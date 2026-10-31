package com.sherpaonnx.video

internal object VideoBufferNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  external fun nativeInit(cacheDir: String, totalRamBytes: Long, debug: Boolean)

  external fun nativeConfigureDecoderBudget(cpu: Int, display: Int)

  external fun nativeConfigureCodecs(
    videoDecode: String?,
    videoDisplay: String?,
    videoEncode: String?,
    imageDecode: String?,
    hwDec: Int,
    hwDisp: Int,
    hwEnc: Int,
    swDec: Int,
    swEnc: Int,
    img: Int,
  ): String?

  external fun nativeGetCodecInfo(): String?

  external fun nativeRegisterVideoCodec(
    name: String,
    codec: String,
    encoder: Boolean,
    hardware: Boolean,
    minW: Int,
    minH: Int,
    maxW: Int,
    maxH: Int,
    alignW: Int,
    alignH: Int,
    maxBlocks: Long,
    blockW: Int,
    blockH: Int,
    maxInstances: Int,
    fps1080: Double,
  )

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
    includeAudio: Boolean,
  ): HashMap<String, Any>?

  external fun nativeStartLiveAudioTap(
    videoBufferId: String,
    liveAudioBufferId: String,
    targetRate: Int,
  ): HashMap<String, Any>?

  external fun nativeStopLiveAudioTap(videoBufferId: String): Boolean

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

  external fun nativeExtractAudioFromVideo(
    bufferId: String,
    startUs: Long,
    endUs: Long,
    targetRate: Int,
    outPath: String?,
    cancelFlagAddr: Long,
    progress: Any?,
  ): HashMap<String, Any>?

  external fun nativeExportVideo(
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
    decodePolicy: String?,
    encodePolicy: String?,
  ): HashMap<String, Any>?

  external fun nativeSetDecodePolicy(bufferId: String, policy: String?)

  external fun nativeProbeVideoFile(path: String): HashMap<String, Any>?
}
