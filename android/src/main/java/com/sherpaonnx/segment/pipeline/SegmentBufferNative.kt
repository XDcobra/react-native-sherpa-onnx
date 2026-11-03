package com.sherpaonnx.segment.pipeline

/**
 * JNI facade for shared C++ SegmentRegistry (Seg* offline/live SoT).
 */
internal object SegmentBufferNative {
  @JvmStatic external fun nativeInit(cacheDir: String)

  @JvmStatic external fun nativeCreateEmptyOffline(sourceAudioBufferId: String?): String?

  @JvmStatic
  external fun nativeCreateLive(
    sourceAudioBufferId: String?,
    maxSegments: Int,
    spoolMode: String,
    spoolPath: String?,
    spoolTemporary: Boolean,
    spoolThresholdBytes: Long,
    emitSegmentAppended: Boolean,
    segmentEventMinIntervalMs: Long,
  ): String?

  @JvmStatic
  external fun nativeAppendSegment(
    liveId: String,
    kind: String,
    sourceAudioBufferId: String,
    startSample: Int,
    endSample: Int,
    sampleRate: Int,
    durationMs: Int,
    hasConfidence: Boolean,
    confidence: Double,
    payloadJson: String?,
    outIds: Array<String?>,
  ): Boolean

  @JvmStatic external fun nativeFinalizeLive(liveId: String): Boolean
  @JvmStatic external fun nativeRelease(bufferId: String): Boolean
  @JvmStatic external fun nativeCreateOfflineFromLive(liveId: String, mode: String): String?
  @JvmStatic
  external fun nativePopulateOfflineFromLive(offlineId: String, liveId: String, mode: String): Boolean

  @JvmStatic external fun nativeIsLive(bufferId: String): Boolean
  @JvmStatic external fun nativeIsOffline(bufferId: String): Boolean
  @JvmStatic external fun nativeLiveSegmentCount(liveId: String): Int
  @JvmStatic external fun nativeLiveSnapshotJson(liveId: String, mode: String): String?
  @JvmStatic external fun nativeOfflineSnapshotJson(offlineId: String): String?
}
