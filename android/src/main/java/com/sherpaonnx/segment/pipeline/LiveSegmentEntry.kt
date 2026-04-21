package com.sherpaonnx.segment.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class LiveSegmentEntry(
  val bufferId: String,
  private val sourceAudioBufferId: String? = null,
  private val maxSegments: Int = 1000,
  private val spoolingMode: SegmentSpoolingMode = SegmentSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  private val spoolThresholdBytes: Long = 0,
) {
  enum class State { RECORDING, FINISHED }

  @Volatile
  var state: State = State.RECORDING
    private set

  private val segmentLock = Any()
  private val segments = ArrayList<SegmentRecord>()
  private var evictedCount: Long = 0
  private val totalSegmentsWritten = AtomicLong(0)

  private val spoolLock = Any()
  @Volatile
  private var spoolWriter: SegmentSpoolWriter? = null
  @Volatile
  private var spoolReady: Boolean = false
  @Volatile
  private var spoolBytes: Long = 0
  @Volatile
  private var spoolEstimatedBytes: Long = 0
  @Volatile
  private var spoolFailureCode: String? = null
  @Volatile
  private var spoolFailureMessage: String? = null

  private fun spoolingEnabled(): Boolean = spoolingMode != SegmentSpoolingMode.OFF

  init {
    if (spoolingEnabled() && spoolingMode == SegmentSpoolingMode.ON) {
      writeSnapshotToSpoolOrThrow(snapshotFullForSpool(), mayActivateAuto = false)
    }
  }

  fun appendSegment(
    kind: String,
    sourceAudioBufferId: String,
    startSample: Int,
    endSample: Int,
    sampleRate: Int,
    durationMs: Int?,
    confidence: Double?,
    payloadJson: String?,
  ): Pair<String, Int> {
    val effectiveDurationMs = durationMs ?: (((endSample - startSample).coerceAtLeast(0) * 1000L) / sampleRate).toInt()
    var segmentId = ""
    var segmentIndex = -1
    var snapshot = ""
    synchronized(segmentLock) {
      if (state == State.FINISHED) {
        throw SegmentPipelineException(
          SegmentErrorCodes.ALREADY_FINALIZED,
          "Live segment buffer is finalized: $bufferId"
        )
      }
      segmentId = "seg_${UUID.randomUUID()}"
      segmentIndex = (evictedCount + segments.size).toInt()
      segments.add(
        SegmentRecord(
          id = segmentId,
          kind = kind,
          sourceAudioBufferId = sourceAudioBufferId,
          startSample = startSample,
          endSample = endSample,
          sampleRate = sampleRate,
          durationMs = effectiveDurationMs,
          confidence = confidence,
          payloadJson = payloadJson,
        )
      )
      snapshot = snapshotFullForSpoolLocked()
      if (segments.size > maxSegments) {
        segments.removeAt(0)
        evictedCount++
      }
      totalSegmentsWritten.incrementAndGet()
    }
    writeSnapshotToSpoolOrThrow(snapshot, mayActivateAuto = true)
    return Pair(segmentId, segmentIndex)
  }

  fun finalize_() {
    synchronized(segmentLock) {
      if (state == State.FINISHED) {
        throw SegmentPipelineException(
          SegmentErrorCodes.ALREADY_FINALIZED,
          "Already finalized: $bufferId"
        )
      }
      state = State.FINISHED
    }
    synchronized(spoolLock) {
      try {
        spoolWriter?.finalize_()
      } catch (e: Exception) {
        markSpoolFailureAndThrow(
          SegmentErrorCodes.SPOOL_WRITE_FAILED,
          "Failed to finalize segment spool for $bufferId: ${e.message}",
          e
        )
      } finally {
        spoolWriter = null
      }
    }
  }

  fun snapshotWindow(): List<SegmentRecord> {
    synchronized(segmentLock) {
      return segments.toList()
    }
  }

  fun snapshotFullIfSpooled(): List<SegmentRecord> {
    if (!spoolingEnabled()) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_UNAVAILABLE,
        "Segment spooling is disabled for $bufferId"
      )
    }
    val failure = spoolFailureCode
    if (failure != null) {
      throw SegmentPipelineException(
        failure,
        spoolFailureMessage ?: "Segment spool unavailable for $bufferId"
      )
    }
    if (!spoolReady) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_UNAVAILABLE,
        "Segment spool is not ready for $bufferId"
      )
    }
    val path = spoolPath ?: throw SegmentPipelineException(
      SegmentErrorCodes.SPOOL_UNAVAILABLE,
      "Segment spool path missing for $bufferId"
    )
    synchronized(spoolLock) {
      try {
        spoolWriter?.flush()
      } catch (e: Exception) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_READ_FAILED,
          "Failed to flush segment spool for $bufferId: ${e.message}",
          e
        )
      }
    }
    val json = try {
      SegmentSpoolReader.readLatestSnapshot(path)
    } catch (e: SegmentPipelineException) {
      throw e
    } catch (e: Exception) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_READ_FAILED,
        "Failed to read segment spool for $bufferId: ${e.message}",
        e
      )
    }
    return OfflineSegmentEntry.segmentsFromJson(json)
  }

  fun getSegments(startIndex: Int, maxCount: Int): List<SegmentRecord> {
    synchronized(segmentLock) {
      if (startIndex < 0 || maxCount < 0) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SLICE_INVALID,
          "Invalid segment slice range start=$startIndex maxCount=$maxCount"
        )
      }
      if (startIndex >= segments.size) return emptyList()
      val end = minOf(startIndex + maxCount, segments.size)
      return segments.subList(startIndex, end).toList()
    }
  }

  fun segmentCount(): Int = synchronized(segmentLock) { segments.size }

  fun release() {
    synchronized(spoolLock) {
      try {
        spoolWriter?.release()
      } catch (_: Exception) {
      } finally {
        spoolWriter = null
      }
    }
    if (spoolTemporary && !spoolPath.isNullOrEmpty()) {
      try {
        File(spoolPath).delete()
      } catch (_: Exception) {
      }
    }
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", "liveSegmentBuffer")
    map.putString("state", if (state == State.RECORDING) "recording" else "finished")
    map.putInt("segmentCount", segmentCount())
    map.putDouble("totalSegmentsWritten", totalSegmentsWritten.get().toDouble())
    if (!sourceAudioBufferId.isNullOrEmpty()) {
      map.putString("sourceAudioBufferId", sourceAudioBufferId)
    }
    map.putString("spoolMode", spoolingMode.rawValue())
    map.putBoolean("spoolEnabled", spoolingEnabled())
    map.putBoolean("spoolReady", spoolReady)
    map.putDouble("spoolBytes", spoolBytes.toDouble())
    if (!spoolPath.isNullOrEmpty()) {
      map.putString("spoolPath", spoolPath)
    }
    return map
  }

  private fun snapshotFullForSpool(): String = synchronized(segmentLock) {
    snapshotFullForSpoolLocked()
  }

  private fun snapshotFullForSpoolLocked(): String {
    return OfflineSegmentEntry.segmentsToJson(segments)
  }

  private fun markSpoolFailureAndThrow(
    code: String,
    message: String,
    cause: Throwable? = null,
  ): Nothing {
    spoolFailureCode = code
    spoolFailureMessage = message
    throw SegmentPipelineException(code, message, cause)
  }

  private fun ensureSpoolWriterActivatedLocked(snapshotJson: String) {
    if (spoolWriter != null) return
    val resolvedPath = spoolPath ?: markSpoolFailureAndThrow(
      SegmentErrorCodes.SPOOL_UNAVAILABLE,
      "Segment spool path is not configured for $bufferId"
    )
    val writer = try {
      SegmentSpoolWriter(resolvedPath)
    } catch (e: Exception) {
      markSpoolFailureAndThrow(
        SegmentErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to create segment spool for $bufferId: ${e.message}",
        e
      )
    }
    try {
      writer.appendSnapshot(snapshotJson)
    } catch (e: Exception) {
      try {
        writer.release()
      } catch (_: Exception) {
      }
      markSpoolFailureAndThrow(
        SegmentErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to initialize segment spool for $bufferId: ${e.message}",
        e
      )
    }
    spoolWriter = writer
    spoolReady = true
    spoolBytes = writer.bytesWritten
  }

  private fun writeSnapshotToSpoolOrThrow(snapshotJson: String, mayActivateAuto: Boolean) {
    if (!spoolingEnabled()) return
    val failureCode = spoolFailureCode
    if (failureCode != null) {
      throw SegmentPipelineException(
        failureCode,
        spoolFailureMessage ?: "Segment spool unavailable for $bufferId"
      )
    }
    synchronized(spoolLock) {
      val writer = spoolWriter
      if (writer == null) {
        when (spoolingMode) {
          SegmentSpoolingMode.OFF -> return
          SegmentSpoolingMode.ON -> {
            ensureSpoolWriterActivatedLocked(snapshotJson)
            return
          }
          SegmentSpoolingMode.AUTO -> {
            if (!mayActivateAuto) return
            val estimatedBytes =
              SegmentSpoolWriter.RECORD_HEADER_BYTES + snapshotJson.toByteArray().size
            spoolEstimatedBytes += estimatedBytes.toLong()
            if (spoolEstimatedBytes < spoolThresholdBytes.coerceAtLeast(0L)) {
              spoolReady = false
              return
            }
            ensureSpoolWriterActivatedLocked(snapshotJson)
            return
          }
        }
      }
      try {
        writer.appendSnapshot(snapshotJson)
        spoolReady = true
        spoolBytes = writer.bytesWritten
      } catch (e: Exception) {
        markSpoolFailureAndThrow(
          SegmentErrorCodes.SPOOL_WRITE_FAILED,
          "Failed to write segment spool for $bufferId: ${e.message}",
          e
        )
      }
    }
  }
}
