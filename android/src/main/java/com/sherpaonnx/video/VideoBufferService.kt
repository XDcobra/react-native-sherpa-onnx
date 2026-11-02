package com.sherpaonnx.video

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import org.json.JSONObject

internal object VideoBufferService : ComponentCallbacks2 {
  private const val TAG = "SherpaOnnx:video"
  @Volatile private var initialized = false
  @Volatile private var reactContext: ReactApplicationContext? = null

  fun ensureInitialized(context: Context) {
    if (context is ReactApplicationContext) {
      reactContext = context
    }
    if (initialized) return
    synchronized(this) {
      if (context is ReactApplicationContext) {
        reactContext = context
      }
      if (initialized) return
      val cacheDir = File(context.cacheDir, "sherpa-video").apply { mkdirs() }
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      val memInfo = ActivityManager.MemoryInfo()
      am?.getMemoryInfo(memInfo)
      val totalRam = memInfo.totalMem.takeIf { it > 0 } ?: (6L * 1024 * 1024 * 1024)
      val debug = 0 != (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)
      VideoBufferNative.nativeInit(cacheDir.absolutePath, totalRam, debug)
      for (e in VideoCodecCatalog.listVideoCodecs()) {
        val codec = when {
          e.mime.equals("video/hevc", ignoreCase = true) -> "hevc"
          e.mime.equals("video/x-vnd.on2.vp9", ignoreCase = true) -> "vp9"
          else -> "h264"
        }
        VideoBufferNative.nativeRegisterVideoCodec(
          e.name, codec, e.encoder, e.hardware,
          e.minW, e.minH, e.maxW, e.maxH, e.alignW, e.alignH,
          e.maxBlocks, e.blockW, e.blockH, e.maxInstances, e.fps1080,
        )
      }
      if (debug) {
        VideoCodecCatalog.dumpAll()
      }
      context.applicationContext.registerComponentCallbacks(this)
      initialized = true
      Log.i(TAG, "VideoBufferService initialized cacheDir=${cacheDir.absolutePath}")
    }
  }

  fun createOfflineFromFile(path: String, decodePolicy: String? = null): Map<String, Any>? {
    val map = VideoBufferNative.nativeCreateOfflineFromFile(path)
    val id = map?.get("bufferId") as? String
    if (!decodePolicy.isNullOrEmpty() && !id.isNullOrEmpty()) {
      VideoBufferNative.nativeSetDecodePolicy(id, decodePolicy)
    }
    return map
  }

  fun createLive(
    ringSeconds: Int,
    retentionMode: Int,
    path: String?,
    decodePolicy: String? = null,
  ): Map<String, Any>? {
    val map = VideoBufferNative.nativeCreateLive(ringSeconds, retentionMode, path)
    val id = map?.get("bufferId") as? String
    if (!decodePolicy.isNullOrEmpty() && !id.isNullOrEmpty()) {
      VideoBufferNative.nativeSetDecodePolicy(id, decodePolicy)
    }
    return map
  }

  fun getInfo(bufferId: String): Map<String, Any>? =
    VideoBufferNative.nativeGetInfo(bufferId)

  fun release(bufferId: String): Boolean = VideoBufferNative.nativeRelease(bufferId)

  fun finalizeLive(bufferId: String): Map<String, Any>? =
    VideoBufferNative.nativeFinalizeLive(bufferId)

  fun ingestFile(
    liveId: String,
    path: String,
    realtime: Boolean,
    includeAudio: Boolean = true,
  ): Map<String, Any>? =
    VideoBufferNative.nativeIngestFile(liveId, path, realtime, includeAudio)

  fun startLiveAudioTap(videoId: String, audioId: String, targetRate: Int): Map<String, Any>? =
    VideoBufferNative.nativeStartLiveAudioTap(videoId, audioId, targetRate)

  fun stopLiveAudioTap(videoId: String): Boolean =
    VideoBufferNative.nativeStopLiveAudioTap(videoId)

  fun createImageFromVideo(
    bufferId: String,
    sampling: Int,
    uniform: Int,
    fps: Double,
    maxSide: Int,
    timesUs: LongArray? = null,
    cancelFlagAddr: Long = 0L,
    progress: Any? = null,
  ): Map<String, Any>? =
    VideoBufferNative.nativeCreateImageFromVideo(
      bufferId, sampling, uniform, fps, maxSide, timesUs, cancelFlagAddr, progress
    )

  fun keyframeTimes(bufferId: String, fromUs: Long, toUs: Long, maxCount: Int): List<Long> =
    VideoBufferNative.nativeKeyframeTimes(bufferId, fromUs, toUs, maxCount) ?: emptyList()

  fun configureDecoderBudget(cpu: Int, display: Int) {
    VideoBufferNative.nativeConfigureDecoderBudget(cpu, display)
  }

  fun configureCodecs(
    videoDecode: String?,
    videoDisplay: String?,
    videoEncode: String?,
    imageDecode: String?,
    imageEncode: String?,
    hwDec: Int,
    hwDisp: Int,
    hwEnc: Int,
    swDec: Int,
    swEnc: Int,
    img: Int,
  ): String? =
    VideoBufferNative.nativeConfigureCodecs(
      videoDecode, videoDisplay, videoEncode, imageDecode, imageEncode,
      hwDec, hwDisp, hwEnc, swDec, swEnc, img,
    )

  fun codecInfoJson(): String? = VideoBufferNative.nativeGetCodecInfo()

  fun extractAudioFromVideo(
    bufferId: String,
    startUs: Long,
    endUs: Long,
    targetRate: Int,
    outPath: String?,
    cancelFlagAddr: Long,
    progress: Any?,
  ): Map<String, Any>? =
    VideoBufferNative.nativeExtractAudioFromVideo(
      bufferId, startUs, endUs, targetRate, outPath, cancelFlagAddr, progress
    )

  fun exportVideo(
    bufferId: String,
    outPath: String,
    format: String,
    codec: String,
    bitrate: Int,
    fromUs: Long,
    toUs: Long,
    maxSide: Int,
    cancelFlagAddr: Long,
    progress: Any?,
    decodePolicy: String? = null,
    encodePolicy: String? = null,
    includeAudio: Boolean = true,
  ): Map<String, Any>? =
    VideoBufferNative.nativeExportVideo(
      bufferId, outPath, format, codec, bitrate, fromUs, toUs, maxSide,
      cancelFlagAddr, progress, decodePolicy, encodePolicy, includeAudio,
    )

  fun probeVideoFile(path: String): Map<String, Any>? =
    VideoBufferNative.nativeProbeVideoFile(path)

  /**
   * Called from JNI on a media thread. Marshals onto the JS queue.
   */
  @JvmStatic
  fun emitNative(eventName: String, type: String, bufferId: String, json: String) {
    val ctx = reactContext ?: return
    val safeType = type
    val safeId = bufferId
    val safeJson = json
    val emit = Runnable {
      if (!ctx.hasActiveReactInstance()) {
        Log.w(TAG, "emit $eventName skip: no active RN instance")
        return@Runnable
      }
      try {
        // Bridgeless: WritableNativeMap.putString on the JS queue UAF'd
        // folly::dynamic (tombstone 13:45:43, S2.4 slotFreed). Emit one
        // JSON string instead — JS already accepts string or {payload}.
        val wrapped =
          JSONObject()
            .put("type", safeType)
            .put("playerId", safeId)
            .put("liveBufferId", safeId)
            .put("payload", safeJson)
            .toString()
        Log.i(
          TAG,
          "emit $eventName type=$safeType id=$safeId payloadBytes=${safeJson.length}"
        )
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(eventName, wrapped)
      } catch (t: Throwable) {
        Log.w(TAG, "emit $eventName failed: ${t.message}")
      }
    }
    if (ctx.hasActiveReactInstance()) {
      ctx.runOnJSQueueThread(emit)
    }
  }

  override fun onTrimMemory(level: Int) {
    VideoBufferNative.nativeOnTrimMemory(level)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {}

  @Deprecated("Deprecated in Java")
  override fun onLowMemory() {
    VideoBufferNative.nativeOnTrimMemory(80)
  }
}
