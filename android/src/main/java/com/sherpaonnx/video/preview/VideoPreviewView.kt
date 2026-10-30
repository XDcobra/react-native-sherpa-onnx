package com.sherpaonnx.video.preview

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.display.DisplayManager
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import com.facebook.react.uimanager.ThemedReactContext

internal class VideoPreviewView(
  context: ThemedReactContext,
  private val useTexture: Boolean,
) : FrameLayout(context) {
  private var playerId: String? = null
  private var resizeMode: String = "contain"
  private var videoW = 16
  private var videoH = 9
  private var surface: Surface? = null
  private val surfaceView: SurfaceView?
  private val textureView: TextureView?
  private val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {}
    override fun onDisplayRemoved(displayId: Int) {}
    override fun onDisplayChanged(displayId: Int) {
      val id = playerId ?: return
      VideoPreviewService.setRefreshRate(id, refreshHz())
    }
  }

  init {
    clipChildren = true
    if (useTexture) {
      surfaceView = null
      val tv = TextureView(context)
      textureView = tv
      tv.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
        override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
          attach(Surface(st))
        }
        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
          layoutChild()
        }
        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
          detach()
          return true
        }
        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
      }
      addView(tv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER))
    } else {
      textureView = null
      val sv = SurfaceView(context)
      surfaceView = sv
      sv.holder.addCallback(object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
          attach(holder.surface)
        }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
          layoutChild()
        }
        override fun surfaceDestroyed(holder: SurfaceHolder) {
          detach()
        }
      })
      addView(sv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER))
    }
    displayManager?.registerDisplayListener(displayListener, handler)
  }

  fun setPlayerId(id: String?) {
    if (playerId == id) return
    if (playerId != null) {
      VideoPreviewService.detachSurface(playerId!!)
    }
    playerId = id
    surface?.let { s ->
      if (id != null) VideoPreviewService.attachSurface(id, s, refreshHz())
    }
  }

  fun setResizeMode(mode: String?) {
    resizeMode = mode?.lowercase() ?: "contain"
    layoutChild()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    layoutChild()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    displayManager?.unregisterDisplayListener(displayListener)
    detach()
  }

  private fun attach(s: Surface) {
    surface = s
    val id = playerId ?: return
    VideoPreviewService.ensure(context)
    VideoPreviewService.attachSurface(id, s, refreshHz())
    Log.i(TAG, "surface attach player=$id refresh=${refreshHz()}")
  }

  private fun detach() {
    val id = playerId
    if (id != null) VideoPreviewService.detachSurface(id)
    surface = null
  }

  private fun refreshHz(): Double {
    val d = display ?: return 60.0
    val r = d.refreshRate
    return if (r > 1f) r.toDouble() else 60.0
  }

  private fun layoutChild() {
    val child: View = (surfaceView ?: textureView) ?: return
    val vw = width
    val vh = height
    if (vw <= 0 || vh <= 0) return
    val ar = videoW.toFloat() / videoH.toFloat().coerceAtLeast(1f)
    when (resizeMode) {
      "stretch" -> {
        child.layout(0, 0, vw, vh)
        if (useTexture) textureView?.setTransform(Matrix())
      }
      "cover" -> {
        var cw = vw
        var ch = (vw / ar).toInt()
        if (ch < vh) {
          ch = vh
          cw = (vh * ar).toInt()
        }
        val l = (vw - cw) / 2
        val t = (vh - ch) / 2
        child.layout(l, t, l + cw, t + ch)
      }
      else -> {
        var cw = vw
        var ch = (vw / ar).toInt()
        if (ch > vh) {
          ch = vh
          cw = (vh * ar).toInt()
        }
        val l = (vw - cw) / 2
        val t = (vh - ch) / 2
        child.layout(l, t, l + cw, t + ch)
      }
    }
  }

  companion object {
    private const val TAG = "SherpaOnnx:video.preview"
  }
}
