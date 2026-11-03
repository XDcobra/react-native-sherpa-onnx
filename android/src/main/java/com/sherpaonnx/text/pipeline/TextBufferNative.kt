package com.sherpaonnx.text.pipeline

/**
 * JNI facade for shared C++ TextRegistry (Txt* offline/live SoT).
 */
internal object TextBufferNative {
  @JvmStatic external fun nativeInit(cacheDir: String)

  @JvmStatic external fun nativeCreateEmptyOffline(): String?

  @JvmStatic
  external fun nativeCreateOfflineFromText(
    text: String,
    lang: String,
    emotion: String,
    event: String,
  ): String?

  @JvmStatic
  external fun nativeCreateLive(
    windowMaxChars: Int,
    maxSegments: Int,
    emitPartial: Boolean,
    partialMinIntervalMs: Long,
    spoolMode: String,
    spoolPath: String?,
    spoolTemporary: Boolean,
  ): String?

  @JvmStatic external fun nativeWritePartial(liveId: String, text: String): Boolean

  @JvmStatic external fun nativeAppendText(liveId: String, text: String): Boolean

  @JvmStatic
  external fun nativeCommitSegment(
    liveId: String,
    text: String,
    tokens: Array<String>?,
    timestamps: FloatArray?,
    source: String,
    metaJson: String?,
  ): Int

  @JvmStatic external fun nativeSnapshotText(liveId: String): String?

  @JvmStatic external fun nativeLiveRevision(liveId: String): Int

  @JvmStatic external fun nativeCreateSegmentCursor(liveId: String): Int

  @JvmStatic
  external fun nativeDrainSegments(liveId: String, cursorId: Int, maxCount: Int): String?

  @JvmStatic
  external fun nativeGetSegments(liveId: String, startIndex: Int, maxCount: Int): String?

  @JvmStatic external fun nativeReleaseSegmentCursor(liveId: String, cursorId: Int): Boolean

  @JvmStatic external fun nativeFinalizeLive(liveId: String): Boolean
  @JvmStatic external fun nativeRelease(bufferId: String): Boolean
  @JvmStatic external fun nativeReadOfflineText(bufferId: String): String?

  @JvmStatic
  external fun nativeReadOfflineTextSlice(bufferId: String, startUtf16: Int, maxUtf16: Int): String?

  @JvmStatic
  external fun nativeSnapshotTextSlice(liveId: String, startUtf16: Int, maxUtf16: Int): String?

  @JvmStatic
  external fun nativePopulateIfEmpty(
    bufferId: String,
    text: String,
    tokens: Array<String>?,
    timestamps: FloatArray?,
    durations: FloatArray?,
    lang: String,
    emotion: String,
    event: String,
    spatialSpansJson: String?,
  ): Boolean

  @JvmStatic
  external fun nativeOfflineTokensSlice(bufferId: String, start: Int, maxCount: Int): String?

  @JvmStatic
  external fun nativeOfflineTimestampsSlice(bufferId: String, start: Int, maxCount: Int): String?

  @JvmStatic
  external fun nativeOfflineDurationsSlice(bufferId: String, start: Int, maxCount: Int): String?

  @JvmStatic
  external fun nativeOfflineSpatialSpansSlice(bufferId: String, start: Int, maxCount: Int): String?

  @JvmStatic external fun nativeOfflineTokenCount(bufferId: String): Int

  @JvmStatic external fun nativeOfflineTimestampCount(bufferId: String): Int

  @JvmStatic external fun nativeOfflineDurationCount(bufferId: String): Int

  @JvmStatic external fun nativeOfflineSpatialSpanCount(bufferId: String): Int

  @JvmStatic external fun nativeOfflineLang(bufferId: String): String?

  @JvmStatic external fun nativeOfflineEmotion(bufferId: String): String?

  @JvmStatic external fun nativeOfflineEvent(bufferId: String): String?

  @JvmStatic external fun nativeCreateOfflineFromLive(liveId: String, mode: String): String?
  @JvmStatic external fun nativeLiveSnapshot(liveId: String): String?
  @JvmStatic external fun nativeIsOffline(bufferId: String): Boolean
  @JvmStatic external fun nativeIsLive(bufferId: String): Boolean
  @JvmStatic external fun nativeOfflineUtf16Length(bufferId: String): Int
  @JvmStatic external fun nativeLiveState(liveId: String): Int
  @JvmStatic external fun nativeLiveTotalChars(liveId: String): Long
  @JvmStatic external fun nativeLiveSegmentCount(liveId: String): Int
  @JvmStatic external fun nativeOfflinePopulated(bufferId: String): Boolean
}
