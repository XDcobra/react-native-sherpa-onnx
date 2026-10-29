package com.sherpaonnx.video

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.util.Log
import java.io.File

internal object VideoBufferService : ComponentCallbacks2 {
  private const val TAG = "SherpaOnnx:video"
  @Volatile private var initialized = false

  fun ensureInitialized(context: Context) {
    if (initialized) return
    synchronized(this) {
      if (initialized) return
      val cacheDir = File(context.cacheDir, "sherpa-video").apply { mkdirs() }
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      val memInfo = ActivityManager.MemoryInfo()
      am?.getMemoryInfo(memInfo)
      val totalRam = memInfo.totalMem.takeIf { it > 0 } ?: (6L * 1024 * 1024 * 1024)
      val debug = 0 != (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)
      VideoBufferNative.nativeInit(cacheDir.absolutePath, totalRam, debug)
      val avc = VideoCodecCatalog.find("video/avc")
      val hevc = VideoCodecCatalog.find("video/hevc")
      VideoBufferNative.nativeSetHwCodecs(avc.decoder, hevc.decoder, avc.encoder, hevc.encoder)
      context.applicationContext.registerComponentCallbacks(this)
      initialized = true
      Log.i(TAG, "VideoBufferService initialized cacheDir=${cacheDir.absolutePath}")
    }
  }

  fun createOfflineFromFile(path: String): Map<String, Any>? =
    VideoBufferNative.nativeCreateOfflineFromFile(path)

  fun createLive(ringSeconds: Int, retentionMode: Int, path: String?): Map<String, Any>? =
    VideoBufferNative.nativeCreateLive(ringSeconds, retentionMode, path)

  fun getInfo(bufferId: String): Map<String, Any>? =
    VideoBufferNative.nativeGetInfo(bufferId)

  fun release(bufferId: String): Boolean = VideoBufferNative.nativeRelease(bufferId)

  fun finalizeLive(bufferId: String): Map<String, Any>? =
    VideoBufferNative.nativeFinalizeLive(bufferId)

  fun ingestFile(liveId: String, path: String, realtime: Boolean): Map<String, Any>? =
    VideoBufferNative.nativeIngestFile(liveId, path, realtime)

  fun createImageFromVideo(
    bufferId: String,
    sampling: Int,
    uniform: Int,
    fps: Double,
    maxSide: Int,
    timesUs: LongArray? = null,
  ): Map<String, Any>? =
    VideoBufferNative.nativeCreateImageFromVideo(bufferId, sampling, uniform, fps, maxSide, timesUs)

  fun keyframeTimes(bufferId: String, fromUs: Long, toUs: Long, maxCount: Int): List<Long> =
    VideoBufferNative.nativeKeyframeTimes(bufferId, fromUs, toUs, maxCount) ?: emptyList()

  override fun onTrimMemory(level: Int) {
    VideoBufferNative.nativeOnTrimMemory(level)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {}

  @Deprecated("Deprecated in Java")
  override fun onLowMemory() {
    VideoBufferNative.nativeOnTrimMemory(80)
  }
}
