package com.sherpaonnx.image

import android.graphics.Bitmap
import android.util.Log
import android.widget.ImageView
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext

/**
 * Native preview of one OfflineImageBuffer frame (paints from native RGB; no file encode).
 */
class OfflineImageBufferFrameView(context: ThemedReactContext) :
  ImageView(context), LifecycleEventListener {

  private val reactContext = context
  private var bufferId: String? = null
  private var frameIndex: Int = 0
  private var maxSide: Int = 0
  private var heldBitmap: Bitmap? = null

  init {
    scaleType = ScaleType.FIT_CENTER
    adjustViewBounds = true
    reactContext.addLifecycleEventListener(this)
  }

  fun setBufferId(id: String?) {
    if (bufferId == id) return
    bufferId = id
    reload()
  }

  fun setFrameIndex(index: Int) {
    if (frameIndex == index) return
    frameIndex = index.coerceAtLeast(0)
    reload()
  }

  fun setMaxSide(side: Int) {
    if (maxSide == side) return
    maxSide = side
    reload()
  }

  fun setResizeMode(mode: String?) {
    scaleType = when (mode?.lowercase()) {
      "cover" -> ScaleType.CENTER_CROP
      "stretch" -> ScaleType.FIT_XY
      else -> ScaleType.FIT_CENTER // contain
    }
  }

  private fun reload() {
    val id = bufferId
    if (id.isNullOrEmpty()) {
      clearBitmap()
      return
    }
    try {
      ImageBufferService.ensureInitialized(reactContext)
      val bmp = ImageBufferService.copyFrameBitmap(id, frameIndex, maxSide)
      if (bmp == null) {
        Log.w(TAG, "Frame not found bufferId=$id frameIndex=$frameIndex")
        clearBitmap()
        return
      }
      heldBitmap?.recycle()
      heldBitmap = bmp
      setImageBitmap(bmp)
    } catch (e: Exception) {
      Log.w(TAG, "reload failed: ${e.message}")
      clearBitmap()
    }
  }

  private fun clearBitmap() {
    setImageBitmap(null)
    heldBitmap?.recycle()
    heldBitmap = null
  }

  override fun onHostResume() {}

  override fun onHostPause() {}

  override fun onHostDestroy() {
    clearBitmap()
    reactContext.removeLifecycleEventListener(this)
  }

  companion object {
    private const val TAG = "SherpaOnnx:image.view"
  }
}
