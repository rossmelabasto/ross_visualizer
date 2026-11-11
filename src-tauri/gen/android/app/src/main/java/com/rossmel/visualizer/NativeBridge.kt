package com.rossmel.visualizer

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.media.audiofx.Visualizer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

/**
 * What the page (src/android/native.ts) calls as `window.RossAndroid`, and what it hears back
 * through `window.__rossNative(type, data)` and `window.__rossAudio(base64)`.
 *
 * Audio: Android's Visualizer on session 0 is the mix of everything the phone plays, the same
 * idea as the desktop app's PipeWire monitor. Android files it under the microphone permission,
 * although nothing is recorded. Media: the active media sessions, readable once the user turns
 * on notification access for the app (MediaListener).
 */
class NativeBridge(private val activity: MainActivity, private val webView: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private var visualizer: Visualizer? = null
    private val media = MediaWatcher(activity) { data -> emit("media", data) }

    private fun emit(type: String, data: String) {
        main.post {
            webView.evaluateJavascript("window.__rossNative && window.__rossNative(${JSONObject.quote(type)}, $data)", null)
        }
    }

    private fun hasAudio() =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun stateJson(): String = JSONObject()
        .put("audio", hasAudio())
        .put("media", media.hasAccess())
        .put("listening", visualizer?.enabled == true)
        .put("sdk", Build.VERSION.SDK_INT)
        .toString()

    @JavascriptInterface
    fun state(): String = stateJson()

    @JavascriptInterface
    fun requestAudio() {
        main.post {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO)) { emit("state", stateJson()) }
        }
    }

    /** Notification access can only be turned on by the user, in the system settings. */
    @JavascriptInterface
    fun openMediaAccess() {
        main.post {
            val component = ComponentName(activity, MediaListener::class.java)
            val detail = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
            } else null
            try {
                activity.startActivity(detail ?: Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            } catch (e: Exception) {
                activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }
    }

    @JavascriptInterface
    fun startAudio() {
        main.post { emit("audio", openVisualizer()) }
    }

    private fun openVisualizer(): String {
        if (!hasAudio()) return JSONObject().put("ok", false).put("reason", "permission").toString()
        visualizer?.let { if (it.enabled) return describe(it) }
        return try {
            val v = Visualizer(0)
            v.enabled = false
            v.captureSize = Visualizer.getCaptureSizeRange()[1]
            // Normalized: the scenes react the same at any volume.
            v.scalingMode = Visualizer.SCALING_MODE_NORMALIZED
            v.setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                override fun onWaveFormDataCapture(vis: Visualizer, waveform: ByteArray, samplingRate: Int) {
                    val b64 = Base64.encodeToString(waveform, Base64.NO_WRAP)
                    webView.evaluateJavascript("window.__rossAudio && window.__rossAudio('$b64')", null)
                }

                override fun onFftDataCapture(vis: Visualizer, fft: ByteArray, samplingRate: Int) {}
            }, Visualizer.getMaxCaptureRate(), true, false)
            v.enabled = true
            visualizer = v
            describe(v)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("reason", e.message ?: e.javaClass.simpleName).toString()
        }
    }

    private fun describe(v: Visualizer) = JSONObject()
        .put("ok", true)
        .put("rate", v.samplingRate / 1000)
        .put("size", v.captureSize)
        .put("hz", Visualizer.getMaxCaptureRate() / 1000.0)
        .toString()

    @JavascriptInterface
    fun stopAudio() {
        main.post { release() }
    }

    @JavascriptInterface
    fun startMedia() {
        main.post { media.start() }
    }

    @JavascriptInterface
    fun mediaControl(action: String) {
        main.post { media.control(action) }
    }

    /** The page's fullscreen button: hide the status and navigation bars. */
    @JavascriptInterface
    fun setFullscreen(on: Boolean) {
        main.post {
            val ctl = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            if (on) {
                ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                ctl.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                ctl.show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    /** Back from the settings or another app: permissions may have changed. */
    fun onResume() {
        if (media.hasAccess()) media.start()
        emit("state", stateJson())
    }

    fun release() {
        visualizer?.let {
            it.enabled = false
            it.release()
        }
        visualizer = null
    }

    fun destroy() {
        release()
        media.stop()
    }
}
