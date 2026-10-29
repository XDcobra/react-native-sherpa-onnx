package com.sherpaonnx.video

internal object VideoBufferNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  external fun nativeInit(cacheDir: String, totalRamBytes: Long, debug: Boolean)

  external fun nativeSetHwCodecs(
    h264Decoder: String?,
    hevcDecoder: String?,
    h264Encoder: String?,
    hevcEncoder: String?,
  )

  external fun nativeOnTrimMemory(level: Int)

  external fun nativeCreateOfflineFromFile(path: String): HashMap<String, Any>?

  external fun nativeCreateLive(
    ringSeconds: Int,
    retentionMode: Int,
    path: String?,
  ): HashMap<String, Any>?

  external fun nativeGetInfo(bufferId: String): HashMap<String, Any>?

  external fun nativeRelease(bufferId: String): Boolean

  external fun nativeFinalizeLive(bufferId: String): HashMap<String, Any>?

  external fun nativeIngestFile(
    liveBufferId: String,
    path: String,
    realtime: Boolean,
  ): HashMap<String, Any>?

  external fun nativeCreateImageFromVideo(
    bufferId: String,
    sampling: Int,
    uniform: Int,
    fps: Double,
    maxSide: Int,
    timesUs: LongArray?,
  ): HashMap<String, Any>?

  external fun nativeKeyframeTimes(
    bufferId: String,
    fromUs: Long,
    toUs: Long,
    maxCount: Int,
  ): ArrayList<Long>?
}
