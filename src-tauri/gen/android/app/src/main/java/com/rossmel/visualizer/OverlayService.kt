package com.rossmel.visualizer

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.media.audiofx.Visualizer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * The overlay: a transparent, untouchable window above every app that runs overlay.html, the same
 * page the desktop app draws its overlay with. It lives in a foreground service so it keeps going
 * with the app closed, and it hears the music on its own (Visualizer + media sessions).
 *
 * Android only lets touches through a window of another app when it's at most 80 % opaque.
 */
class OverlayService : Service() {
    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_OPTIONS = "options"
        const val ACTION_STOP = "com.rossmel.visualizer.OVERLAY_STOP"
        private const val CHANNEL = "overlay"
        private const val NOTIFICATION_ID = 7
        /** Android lets touches through another app's window only up to this opacity. */
        private const val MAX_ALPHA = 0.8f

        @Volatile
        var mode: String? = null
            private set

        fun canDraw(context: Context) = Settings.canDrawOverlays(context)
    }

    private val main = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null
    private var visualizer: Visualizer? = null
    private var media: MediaWatcher? = null
    private var options = "{}"
    private var lastMedia = "null"
    private var ready = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !canDraw(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val asked = intent?.getStringExtra(EXTRA_MODE) ?: mode ?: "halo"
        intent?.getStringExtra(EXTRA_OPTIONS)?.let { options = it }
        startInForeground()
        if (webView == null) open()
        mode = asked
        applyOpacity()
        push()
        return START_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Overlay", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, OverlayService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher_foreground)
            .setContentTitle("ross_visualizer")
            .setContentText(getString(R.string.overlay_on))
            .setContentIntent(open)
            .addAction(0, getString(R.string.overlay_stop), stop)
            .setOngoing(true)
            .setSilent(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun open() {
        val wm = getSystemService(WindowManager::class.java)
        windowManager = wm
        // The built page (dist/) is copied into the APK's assets: see app/build.gradle.kts.
        val loader = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        val view = WebView(this)
        view.setBackgroundColor(Color.TRANSPARENT)
        view.settings.javaScriptEnabled = true
        view.settings.mediaPlaybackRequiresUserGesture = false
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
        }
        view.addJavascriptInterface(PageBridge(), "RossAndroid")
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        params.alpha = MAX_ALPHA
        this.params = params
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        wm.addView(view, params)
        webView = view
        view.loadUrl("https://appassets.androidplatform.net/overlay.html?android=1")

        media = MediaWatcher(this) { data ->
            lastMedia = data
            emit("media", data)
        }.also { it.start() }
        startAudio()
    }

    private fun startAudio() {
        try {
            val v = Visualizer(0)
            v.enabled = false
            v.captureSize = Visualizer.getCaptureSizeRange()[1]
            v.scalingMode = Visualizer.SCALING_MODE_NORMALIZED
            v.setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                override fun onWaveFormDataCapture(vis: Visualizer, waveform: ByteArray, samplingRate: Int) {
                    if (!ready) return
                    val b64 = Base64.encodeToString(waveform, Base64.NO_WRAP)
                    webView?.evaluateJavascript("window.__rossAudio && window.__rossAudio('$b64')", null)
                }

                override fun onFftDataCapture(vis: Visualizer, fft: ByteArray, samplingRate: Int) {}
            }, Visualizer.getMaxCaptureRate(), true, false)
            v.enabled = true
            visualizer = v
        } catch (e: Exception) {
            visualizer = null
        }
    }

    /** The "Opacity" slider (options.android.opacity), capped where touches still go through. */
    private fun applyOpacity() {
        val p = params ?: return
        val asked = try {
            JSONObject(options).optJSONObject("android")?.optDouble("opacity", MAX_ALPHA.toDouble()) ?: MAX_ALPHA.toDouble()
        } catch (e: Exception) {
            MAX_ALPHA.toDouble()
        }
        val alpha = asked.toFloat().coerceIn(0.2f, MAX_ALPHA)
        if (alpha != p.alpha) {
            p.alpha = alpha
            webView?.let { windowManager?.updateViewLayout(it, p) }
        }
    }

    private fun emit(type: String, data: String) {
        main.post {
            webView?.evaluateJavascript("window.__rossNative && window.__rossNative(${JSONObject.quote(type)}, $data)", null)
        }
    }

    /** Style, settings, audio format and the current song, sent once the page is ready. */
    private fun push() {
        if (!ready) return
        emit("overlay", JSONObject().put("mode", mode).put("options", JSONObject(options)).toString())
        val v = visualizer
        if (v != null) emit("audio", JSONObject().put("ok", true).put("rate", v.samplingRate / 1000).put("size", v.captureSize).toString())
        emit("media", lastMedia)
    }

    /** What overlay.html reaches as window.RossAndroid. */
    inner class PageBridge {
        @JavascriptInterface
        fun ready() {
            main.post {
                ready = true
                push()
            }
        }
    }

    override fun onDestroy() {
        mode = null
        ready = false
        visualizer?.let {
            it.enabled = false
            it.release()
        }
        visualizer = null
        media?.stop()
        webView?.let {
            windowManager?.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }
}
