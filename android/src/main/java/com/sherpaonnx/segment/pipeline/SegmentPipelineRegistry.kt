package com.sherpaonnx.segment.pipeline

import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object SegmentPipelineRegistry {
  private val offlineMap = ConcurrentHashMap<String, OfflineSegmentEntry>()
  private val liveMap = ConcurrentHashMap<String, LiveSegmentEntry>()
  private var cacheDir: File? = null

  fun initializeWithCacheDir(cacheDir: File) {
    this.cacheDir = cacheDir
  }

  private fun requireCacheDir(): File {
    return cacheDir ?: throw SegmentPipelineException(
      SegmentErrorCodes.INTERNAL_ERROR,
      "SegmentPipelineRegistry not initialized with cacheDir"
    )
  }

  private fun newId(prefix: String): String = "${prefix}_${UUID.randomUUID()}"

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
    val id = newId("seg_live")
    val mode = SegmentSpoolingMode.fromRaw(spoolingModeRaw)
    val tempDir = requireCacheDir()
    val effectivePath = if (mode == SegmentSpoolingMode.OFF) {
      null
    } else {
      spoolingPath ?: File(tempDir, "seg_spool_${System.currentTimeMillis()}_${UUID.randomUUID()}.json").absolutePath
    }
    val temporary = spoolingTemporary ?: spoolingPath.isNullOrEmpty()
    val entry = LiveSegmentEntry(
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
    val id = newId("seg_off")
    val entry = OfflineSegmentEntry(id, sourceAudioBufferId)
    offlineMap[id] = entry
    return entry
  }

  fun createOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled",
  ): OfflineSegmentEntry {
    val live = getLive(liveBufferId) ?: throw SegmentPipelineException(
      SegmentErrorCodes.BUFFER_NOT_FOUND,
      "Live segment buffer not found: $liveBufferId"
    )
    val records = when (mode) {
      "windowSnapshot" -> live.snapshotWindow()
      "fullIfSpooled" -> live.snapshotFullIfSpooled()
      else -> throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'."
      )
    }

    val id = newId("seg_off")
    val entry = OfflineSegmentEntry(id, live.sourceAudioBufferId)
    entry.populate(records)
    offlineMap[id] = entry
    return entry
  }

  fun populateOfflineFromLiveIfEmpty(
    targetOfflineId: String,
    liveBufferId: String,
    mode: String = "fullIfSpooled",
  ) {
    val live = getLive(liveBufferId) ?: throw SegmentPipelineException(
      SegmentErrorCodes.BUFFER_NOT_FOUND,
      "Live segment buffer not found: $liveBufferId"
    )
    val target = getOffline(targetOfflineId) ?: throw SegmentPipelineException(
      SegmentErrorCodes.BUFFER_NOT_FOUND,
      "Offline segment buffer not found: $targetOfflineId"
    )

    val records = when (mode) {
      "windowSnapshot" -> live.snapshotWindow()
      "fullIfSpooled" -> live.snapshotFullIfSpooled()
      else -> throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'."
      )
    }

    target.populate(records)
  }

  fun getOffline(bufferId: String): OfflineSegmentEntry? = offlineMap[bufferId]
  fun getLive(bufferId: String): LiveSegmentEntry? = liveMap[bufferId]

  fun release(bufferId: String) {
    liveMap.remove(bufferId)?.release()
    offlineMap.remove(bufferId)
  }

  fun releaseAll() {
    val liveEntries = liveMap.values.toList()
    liveMap.clear()
    offlineMap.clear()
    liveEntries.forEach {
      try {
        it.release()
      } catch (_: Exception) {
      }
    }
  }
}
