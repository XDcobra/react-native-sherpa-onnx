package com.sherpaonnx.image

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.ImageView
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native preview of one OfflineImageBuffer frame (paints from native RGB; no file encode).
 * Lazy-lru: ensure runs on a background executor so PDFium never blocks the UI thread.
 */
class OfflineImageBufferFrameView(context: ThemedReactContext) :
  ImageView(context), LifecycleEventListener {

  private val reactContext = context
  private var bufferId: String? = null
  private var frameIndex: Int = 0
  private var maxSide: Int = 0
  private var heldBitmap: Bitmap? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private val reloadGeneration = AtomicInteger(0)

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
    val gen = reloadGeneration.incrementAndGet()
    if (id.isNullOrEmpty()) {
      clearBitmap()
      return
    }

    bgExecutor.execute {
      try {
        ImageBufferService.ensureInitialized(reactContext)
        // Ensure (and optional ±1 prefetch) off the UI thread before paint.
        val ensured = ImageBufferService.ensureFrame(id, frameIndex)
        if (ensured != null && ensured["errorCode"] != null) {
          Log.w(TAG, "ensure failed bufferId=$id frameIndex=$frameIndex: ${ensured["errorMessage"]}")
        }
        val bmp = ImageBufferService.copyFrameBitmap(id, frameIndex, maxSide)
        mainHandler.post {
          if (gen != reloadGeneration.get()) return@post
          if (bmp == null) {
            Log.w(TAG, "Frame not found bufferId=$id frameIndex=$frameIndex")
            clearBitmap()
            return@post
          }
          heldBitmap?.recycle()
          heldBitmap = bmp
          setImageBitmap(bmp)
        }
      } catch (e: Exception) {
        Log.w(TAG, "reload failed: ${e.message}")
        mainHandler.post {
          if (gen != reloadGeneration.get()) return@post
          clearBitmap()
        }
      }
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
    reloadGeneration.incrementAndGet()
    clearBitmap()
    reactContext.removeLifecycleEventListener(this)
  }

  companion object {
    private const val TAG = "SherpaOnnx:image.view"
    private val bgExecutor = Executors.newSingleThreadExecutor { r ->
      Thread(r, "SherpaOnnx-ImageFrameView").apply { isDaemon = true }
    }
  }
}
