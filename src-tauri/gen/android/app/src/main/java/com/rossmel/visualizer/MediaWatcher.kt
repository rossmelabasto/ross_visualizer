package com.rossmel.visualizer

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** Exists so the user can grant notification access, which is what lets us read media sessions. */
class MediaListener : NotificationListenerService()

/**
 * Follows the media session that is playing (Spotify, YouTube, a browser…) and reports what's on,
 * the same shape the desktop app gets from MPRIS: player, status, title, artist and the artwork
 * (as a data: URL, sent only when it changes).
 */
class MediaWatcher(private val context: Context, private val onChange: (String) -> Unit) {
    private val manager = context.getSystemService(MediaSessionManager::class.java)
    private val component = ComponentName(context, MediaListener::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var controller: MediaController? = null
    private var listening = false
    private var lastArtKey: String? = null

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list -> pick(list ?: emptyList()) }

    private val callback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) = report()
        override fun onPlaybackStateChanged(state: PlaybackState?) {
            // Another app may have started playing: re-pick, then report.
            pick(sessions())
        }
        override fun onSessionDestroyed() = pick(sessions())
    }

    fun hasAccess(): Boolean {
        val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: ""
        return enabled.split(":").any { ComponentName.unflattenFromString(it) == component }
    }

    private fun sessions(): List<MediaController> =
        try { manager.getActiveSessions(component) } catch (e: SecurityException) { emptyList() }

    fun start() {
        if (!hasAccess()) return
        if (!listening) {
            try {
                manager.addOnActiveSessionsChangedListener(sessionsListener, component, handler)
                listening = true
            } catch (e: SecurityException) {
                return
            }
        }
        pick(sessions())
    }

    fun stop() {
        if (listening) manager.removeOnActiveSessionsChangedListener(sessionsListener)
        listening = false
        controller?.unregisterCallback(callback)
        controller = null
    }

    private fun pick(list: List<MediaController>) {
        val playing = list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
        val next = playing ?: list.firstOrNull()
        if (next?.sessionToken != controller?.sessionToken) {
            controller?.unregisterCallback(callback)
            controller = next
            next?.registerCallback(callback, handler)
            lastArtKey = null
        }
        report()
    }

    private fun report() {
        val c = controller
        if (c == null) {
            onChange("null")
            return
        }
        val m = c.metadata
        val title = m?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: m?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: ""
        val artist = m?.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: m?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: m?.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE) ?: ""
        val status = when (c.playbackState?.state) {
            PlaybackState.STATE_PLAYING -> "Playing"
            PlaybackState.STATE_PAUSED -> "Paused"
            else -> "Stopped"
        }
        val json = JSONObject()
            .put("player", appLabel(c.packageName))
            .put("status", status)
            .put("title", title)
            .put("artist", artist)
        val bitmap = m?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: m?.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: m?.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        val artKey = "${c.packageName}|$title|$artist|${bitmap?.width}x${bitmap?.height}"
        json.put("artKey", artKey)
        if (artKey != lastArtKey) {
            lastArtKey = artKey
            json.put("art", bitmap?.let { toDataUrl(it) } ?: "")
        }
        onChange(json.toString())
    }

    private fun appLabel(pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        pkg
    }

    private fun toDataUrl(src: Bitmap): String {
        val scale = 512f / maxOf(src.width, src.height)
        val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true) else src
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 88, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    fun control(action: String) {
        val c = controller ?: return
        val t = c.transportControls
        when (action) {
            "play-pause" -> if (c.playbackState?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
            "next" -> t.skipToNext()
            "previous" -> t.skipToPrevious()
        }
    }
}
