package com.sherpaonnx.audio.pipeline

/**
 * JNI facade for shared C++ AudioRegistry (Pa* offline/live SoT).
 * Loaded via [com.sherpaonnx.SherpaOnnxNativeLoader].
 */
internal object AudioBufferNative {
  @JvmStatic external fun nativeInit(cacheDir: String, totalRamBytes: Long)

  @JvmStatic
  external fun nativeCreateOfflineFromSamples(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int,
  ): String?

  @JvmStatic external fun nativeCreateEmptyOffline(sampleRate: Int, channelCount: Int): String?

  @JvmStatic
  external fun nativeCreateLive(
    sampleRate: Int,
    channelCount: Int,
    windowSec: Double,
    spoolPath: String?,
    emitEvents: Boolean,
    minIntervalMs: Int,
  ): String?

  @JvmStatic
  external fun nativeAppendSamplesToLive(
    bufferId: String,
    samples: FloatArray,
    sampleRate: Int,
  ): Boolean

  /** Append Int16 PCM; C converts ÷32768 (no Kotlin FloatArray). */
  @JvmStatic
  external fun nativeAppendInt16SamplesToLive(
    bufferId: String,
    samples: ShortArray,
    sampleRate: Int,
  ): Boolean

  @JvmStatic external fun nativeFinalizeLive(bufferId: String): Boolean
  @JvmStatic external fun nativeRelease(bufferId: String): Boolean

  @JvmStatic external fun nativeReadAllOfflineSamples(bufferId: String): FloatArray?

  @JvmStatic
  external fun nativeReadOfflineSlice(bufferId: String, start: Int, count: Int): FloatArray?

  /** Copy offline samples into [out] at [outOffset]; returns samples written. */
  @JvmStatic
  external fun nativeReadOfflineInto(
    bufferId: String,
    start: Int,
    out: FloatArray,
    outOffset: Int,
    maxSamples: Int,
  ): Int

  @JvmStatic
  external fun nativeReadLiveSlice(bufferId: String, start: Int, count: Int): FloatArray?

  @JvmStatic external fun nativeOfflineNumSamples(bufferId: String): Int
  @JvmStatic external fun nativeOfflineSampleRate(bufferId: String): Int
  @JvmStatic external fun nativeOfflineStorageKind(bufferId: String): String?
  @JvmStatic external fun nativeOfflineFilePath(bufferId: String): String?
  @JvmStatic external fun nativeIsOffline(bufferId: String): Boolean
  @JvmStatic external fun nativeIsLive(bufferId: String): Boolean
  @JvmStatic external fun nativeIsInvalidatedLive(bufferId: String): Boolean

  @JvmStatic
  external fun nativeCreateOfflineFromF32File(
    path: String,
    sampleRate: Int,
    channelCount: Int,
  ): String?

  @JvmStatic external fun nativeAdoptIfEmpty(bufferId: String, samples: FloatArray): Boolean

  /** Move source offline PCM into empty target (C SoT); erases source id. */
  @JvmStatic
  external fun nativePopulateOfflineIfEmpty(targetBufferId: String, sourceBufferId: String): Boolean

  @JvmStatic external fun nativeUpgradeToMmap(bufferId: String)
  @JvmStatic external fun nativeTransferFromLive(liveBufferId: String, fullIfSpooled: Boolean): String?

  @JvmStatic external fun nativeCreateCursor(liveBufferId: String): Int

  @JvmStatic
  external fun nativeDrainCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray?

  /** Drain live cursor into [out] at [outOffset]; returns samples written. */
  @JvmStatic
  external fun nativeDrainCursorInto(
    liveBufferId: String,
    cursorId: Int,
    out: FloatArray,
    outOffset: Int,
    maxSamples: Int,
  ): Int

  @JvmStatic
  external fun nativePeekCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray?

  @JvmStatic external fun nativeReleaseCursor(liveBufferId: String, cursorId: Int)
  @JvmStatic external fun nativeSeekCursor(liveBufferId: String, cursorId: Int, absolutePos: Long)
  @JvmStatic external fun nativeLiveSampleRate(liveBufferId: String): Int
  @JvmStatic external fun nativeLiveTotalSamples(liveBufferId: String): Long
  @JvmStatic external fun nativeLiveState(liveBufferId: String): Int
  @JvmStatic external fun nativeLiveHasActiveSpool(liveBufferId: String): Boolean
  @JvmStatic external fun nativeLiveSpoolPath(liveBufferId: String): String?
  @JvmStatic external fun nativeLiveActiveCursorCount(liveBufferId: String): Int
  @JvmStatic external fun nativeEnableSpool(liveBufferId: String, path: String, temporary: Boolean)
}
