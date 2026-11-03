package com.sherpaonnx.segment.pipeline

import com.sherpaonnx.SherpaOnnxNativeLoader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade over shared C++ SegmentRegistry.
 * Handle maps keep Kotlin listeners; segment/spool SoT is in C++.
 */
object SegmentPipelineRegistry {
  init {
    SherpaOnnxNativeLoader.ensureLoaded()
  }

  private val offlineMap = ConcurrentHashMap<String, OfflineSegmentEntry>()
  private val liveMap = ConcurrentHashMap<String, LiveSegmentEntry>()
  private var cacheDir: File? = null

  fun initializeWithCacheDir(cacheDir: File) {
    this.cacheDir = cacheDir
    SegmentBufferNative.nativeInit(cacheDir.absolutePath)
  }

  private fun requireCacheDir(): File {
    return cacheDir ?: throw SegmentPipelineException(
      SegmentErrorCodes.INTERNAL_ERROR,
      "SegmentPipelineRegistry not initialized with cacheDir",
    )
  }

  private fun defaultSpoolPath(): String {
    val dir = requireCacheDir()
    return File(dir, "seg_spool_${System.nanoTime()}.bin").absolutePath
  }

  fun createLive(
    sourceAudioBufferId: String?,
    maxSegments: Int,
    spoolingModeRaw: String?,
    spoolingPath: String?,
    spoolingTemporary: Boolean?,
    spoolingThresholdBytes: Long?,
    emitSegmentAppendedEvents: Boolean = false,
    segmentEventMinIntervalMs: Long = 0L,
  ): LiveSegmentEntry {
    val mode = SegmentSpoolingMode.fromRaw(spoolingModeRaw)
    val effectivePath =
      if (mode == SegmentSpoolingMode.OFF) null else (spoolingPath ?: defaultSpoolPath())
    val temporary = spoolingTemporary ?: spoolingPath.isNullOrEmpty()
    val id =
      SegmentBufferNative.nativeCreateLive(
        sourceAudioBufferId,
        maxSegments.coerceAtLeast(1),
        mode.rawValue(),
        effectivePath,
        temporary,
        spoolingThresholdBytes ?: 0L,
        emitSegmentAppendedEvents,
        segmentEventMinIntervalMs,
      ) ?: throw IllegalStateException("Failed to create live segment buffer")
    val entry =
      LiveSegmentEntry(
        bufferId = id,
        sourceAudioBufferId = sourceAudioBufferId,
        maxSegments = maxSegments.coerceAtLeast(1),
        spoolingMode = mode,
        spoolPath = effectivePath,
        spoolTemporary = temporary,
        spoolThresholdBytes = spoolingThresholdBytes ?: 0L,
        emitSegmentAppendedEvents = emitSegmentAppendedEvents,
        segmentEventMinIntervalMs = segmentEventMinIntervalMs,
      )
    liveMap[id] = entry
    return entry
  }

  fun createEmptyOffline(sourceAudioBufferId: String?): OfflineSegmentEntry {
    val id =
      SegmentBufferNative.nativeCreateEmptyOffline(sourceAudioBufferId)
        ?: throw IllegalStateException("Failed to create empty offline segment buffer")
    val entry = OfflineSegmentEntry(id, sourceAudioBufferId)
    offlineMap[id] = entry
    return entry
  }

  fun createOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled",
  ): OfflineSegmentEntry {
    val id =
      SegmentBufferNative.nativeCreateOfflineFromLive(liveBufferId, mode)
        ?: throw SegmentPipelineException(
          SegmentErrorCodes.INVALID_ARGUMENT,
          "createOfflineFromLive failed for $liveBufferId mode=$mode",
        )
    val entry = OfflineSegmentEntry.wrap(id) ?: OfflineSegmentEntry(id, null)
    offlineMap[id] = entry
    return entry
  }

  fun populateOfflineFromLiveIfEmpty(
    targetOfflineId: String,
    liveBufferId: String,
    mode: String = "fullIfSpooled",
  ) {
    if (!SegmentBufferNative.nativePopulateOfflineFromLive(targetOfflineId, liveBufferId, mode)) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "populateOfflineFromLiveIfEmpty failed target=$targetOfflineId live=$liveBufferId",
      )
    }
  }

  fun getOffline(bufferId: String): OfflineSegmentEntry? {
    offlineMap[bufferId]?.let { return it }
    val wrapped = OfflineSegmentEntry.wrap(bufferId) ?: return null
    offlineMap[bufferId] = wrapped
    return wrapped
  }

  fun getLive(bufferId: String): LiveSegmentEntry? {
    liveMap[bufferId]?.let { return it }
    val wrapped = LiveSegmentEntry.wrap(bufferId) ?: return null
    liveMap[bufferId] = wrapped
    return wrapped
  }

  fun release(bufferId: String) {
    liveMap.remove(bufferId)?.let {
      try {
        it.release()
      } catch (_: Exception) {
      }
      return
    }
    offlineMap.remove(bufferId)
    SegmentBufferNative.nativeRelease(bufferId)
  }

  fun releaseAll() {
    for (id in liveMap.keys.toList()) {
      release(id)
    }
    for (id in offlineMap.keys.toList()) {
      release(id)
    }
  }
}
