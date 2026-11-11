package com.rossmel.visualizer

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var bridge: NativeBridge? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // A visualizer is watched, not touched: don't let the screen go dark while it plays.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  @SuppressLint("JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    val b = NativeBridge(this, webView)
    bridge = b
    webView.addJavascriptInterface(b, "RossAndroid")
  }

  override fun onResume() {
    super.onResume()
    bridge?.onResume()
  }

  override fun onDestroy() {
    bridge?.destroy()
    super.onDestroy()
  }
}
