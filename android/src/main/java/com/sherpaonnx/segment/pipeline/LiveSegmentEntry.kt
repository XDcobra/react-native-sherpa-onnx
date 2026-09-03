package com.sherpaonnx.segment.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class LiveSegmentEntry(
  val bufferId: String,
  val sourceAudioBufferId: String? = null,
  private val maxSegments: Int = 4096,
  private val spoolingMode: SegmentSpoolingMode = SegmentSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  private val spoolThresholdBytes: Long = 0,
  private val emitSegmentAppendedEvents: Boolean = false,
  private val segmentEventMinIntervalMs: Long = 0L,
) {
  data class CommittedSegment(
    val segmentId: String,
    val segmentIndex: Int,
    val record: SegmentRecord,
  )

  companion object {
    private val ALLOWED_KINDS = setOf("speech", "alignment", "diarization")
  }

  enum class State { RECORDING, FINISHED }

  @Volatile
  var state: State = State.RECORDING
    private set

  private val segmentLock = Any()
  private val segments = ArrayList<SegmentRecord>()
  private var evictedCount: Long = 0
  private val totalSegmentsWritten = AtomicLong(0)
  private val cursors = HashMap<Int, AtomicInteger>()
  private val nextCursorId = AtomicInteger(0)
  private val commitListeners = CopyOnWriteArrayList<Pair<Int, (String, Int, SegmentRecord) -> Unit>>()
  private val nextCommitListenerToken = AtomicInteger(0)
  @Volatile
  private var lastSegmentEventEmitAtMs: Long = 0L

  private val spoolLock = Any()
  @Volatile
  private var journalWriter: SegmentJournalWriter? = null
  @Volatile
  private var checkpointWriter: SegmentCheckpointWriter? = null
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
  @Volatile
  private var journalEventCount: Int = 0
  @Volatile
  private var journalBytesSinceCheckpoint: Long = 0

  private fun spoolingEnabled(): Boolean = spoolingMode != SegmentSpoolingMode.OFF
  private fun journalPath(): String? = spoolPath?.let { "${it}.segj" }
  private fun checkpointPath(): String? = spoolPath?.let { "${it}.segc" }

  init {
    if (spoolingEnabled() && spoolingMode == SegmentSpoolingMode.ON) {
      writeSpoolOrThrow(mayActivateAuto = false, checkpointPayload = snapshotFullForSpool())
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
    annotationReason: String? = null,
    annotationSource: String? = null,
    annotationCreatedAtMs: Long? = null,
  ): Pair<String, Int> {
    val normalizedKind = kind.trim().ifEmpty { "speech" }
    if (!ALLOWED_KINDS.contains(normalizedKind)) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "kind must be one of speech, alignment, or diarization; received $kind"
      )
    }
    if (sampleRate <= 0) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "sampleRate must be > 0; received $sampleRate"
      )
    }
    if (endSample < startSample) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "endSample must be >= startSample; received startSample=$startSample endSample=$endSample"
      )
    }
    if (durationMs != null && durationMs < 0) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "durationMs must be >= 0 when provided; received $durationMs"
      )
    }

    val effectiveDurationMs = durationMs ?: (((endSample - startSample).coerceAtLeast(0) * 1000L) / sampleRate).toInt()
    var segmentId = ""
    var segmentIndex = -1
    var checkpointSnapshot = ""
    var appendedRecord: SegmentRecord? = null
    var totalSegmentsInBuffer = 0
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
          kind = normalizedKind,
          sourceAudioBufferId = sourceAudioBufferId,
          startSample = startSample,
          endSample = endSample,
          sampleRate = sampleRate,
          durationMs = effectiveDurationMs,
          confidence = confidence,
          payloadJson = payloadJson,
        ).also { appendedRecord = it }
      )
      checkpointSnapshot = snapshotFullForSpoolLocked()
      if (segments.size > maxSegments) {
        segments.removeAt(0)
        evictedCount++
      }
      totalSegmentsWritten.incrementAndGet()
      totalSegmentsInBuffer = segments.size
    }
    val appendRecord = appendedRecord
      ?: throw SegmentPipelineException(SegmentErrorCodes.INTERNAL_ERROR, "Missing appended segment record")
    writeSpoolOrThrow(
      mayActivateAuto = true,
      appendRecord = appendRecord,
      checkpointPayload = checkpointSnapshot
    )

    if (annotationReason != null && annotationSource != null) {
      com.sherpaonnx.segment.engine.SegmentationEngineRegistry.recordSegmentAnnotation(
        segmentId = segmentId,
        annotation = com.sherpaonnx.segment.engine.SegmentAnnotationSnapshot(
          reason = annotationReason,
          source = annotationSource,
          createdAtMs = annotationCreatedAtMs ?: System.currentTimeMillis(),
          segmentIndex = segmentIndex,
        )
      )
    }

    if (emitSegmentAppendedEvents) {
      val now = System.currentTimeMillis()
      if (segmentEventMinIntervalMs <= 0L || now - lastSegmentEventEmitAtMs >= segmentEventMinIntervalMs) {
        lastSegmentEventEmitAtMs = now
        try {
          SegmentBufferEventBridge.emitSegmentAppended?.invoke(
            bufferId,
            appendRecord,
            segmentIndex,
            totalSegmentsInBuffer,
          )
        } catch (_: Exception) {
        }
      }
    }
    notifyCommitListeners(segmentId, segmentIndex, appendRecord)
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
        journalWriter?.appendRecord(SegmentSpoolFormat.RECORD_FINALIZE_MARK, "{}")
        journalWriter?.finalize_()
      } catch (e: Exception) {
        markSpoolFailureAndThrow(
          SegmentErrorCodes.SPOOL_WRITE_FAILED,
          "Failed to finalize segment spool for $bufferId: ${e.message}",
          e
        )
      } finally {
        journalWriter = null
        checkpointWriter = null
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
      try { journalWriter?.flush() } catch (_: Exception) {}
    }
    return readFullStateFromSpool(path)
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

  fun createSegmentCursor(): Int = synchronized(segmentLock) {
    val cursorId = nextCursorId.getAndIncrement()
    cursors[cursorId] = AtomicInteger(0)
    cursorId
  }

  fun drainSegments(cursorId: Int, maxCount: Int): List<CommittedSegment> = synchronized(segmentLock) {
    if (maxCount <= 0) return emptyList()
    val cursor = cursors[cursorId]
      ?: throw SegmentPipelineException(
        SegmentErrorCodes.BUFFER_NOT_FOUND,
        "Segment cursor not found: $cursorId"
      )
    val currentPos = cursor.get()
    if (currentPos >= segments.size) return emptyList()
    val end = minOf(currentPos + maxCount, segments.size)
    val committed = ArrayList<CommittedSegment>(end - currentPos)
    for (idx in currentPos until end) {
      val absoluteIndex = (evictedCount + idx).toInt()
      committed.add(
        CommittedSegment(
          segmentId = segments[idx].id,
          segmentIndex = absoluteIndex,
          record = segments[idx],
        )
      )
    }
    cursor.set(end)
    committed
  }

  fun releaseSegmentCursor(cursorId: Int) {
    synchronized(segmentLock) {
      cursors.remove(cursorId)
    }
  }

  fun addCommitListener(listener: (segmentId: String, segmentIndex: Int, record: SegmentRecord) -> Unit): Int {
    val token = nextCommitListenerToken.getAndIncrement()
    commitListeners.add(Pair(token, listener))
    return token
  }

  fun removeCommitListener(token: Int) {
    commitListeners.removeAll { it.first == token }
  }

  private fun notifyCommitListeners(segmentId: String, segmentIndex: Int, record: SegmentRecord) {
    for ((_, listener) in commitListeners) {
      listener(segmentId, segmentIndex, record)
    }
  }

  fun segmentCount(): Int = synchronized(segmentLock) { segments.size }

  fun release() {
    synchronized(spoolLock) {
      try {
        journalWriter?.release()
      } catch (_: Exception) {
      } finally {
        journalWriter = null
        checkpointWriter = null
      }
    }
    if (spoolTemporary && !spoolPath.isNullOrEmpty()) {
      try {
        File("${spoolPath}.segj").delete()
      } catch (_: Exception) {
      }
      try {
        File("${spoolPath}.segc").delete()
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
    if (journalWriter != null && checkpointWriter != null) return
    val resolvedPath = spoolPath ?: markSpoolFailureAndThrow(
      SegmentErrorCodes.SPOOL_UNAVAILABLE,
      "Segment spool path is not configured for $bufferId"
    )
    val journalPath = "${resolvedPath}.segj"
    val checkpointPath = "${resolvedPath}.segc"
    val writer = try {
      SegmentJournalWriter(journalPath)
    } catch (e: Exception) {
      markSpoolFailureAndThrow(
        SegmentErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to create segment spool for $bufferId: ${e.message}",
        e
      )
    }
    try {
      val cpWriter = SegmentCheckpointWriter(checkpointPath)
      cpWriter.writeSnapshot(snapshotJson)
      checkpointWriter = cpWriter
      writer.appendRecord(SegmentSpoolFormat.RECORD_CHECKPOINT_MARK, "{}")
      journalEventCount = 0
      journalBytesSinceCheckpoint = 0L
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
    journalWriter = writer
    spoolReady = true
    spoolBytes = writer.bytesWritten
  }

  private fun writeSpoolOrThrow(
    mayActivateAuto: Boolean,
    appendRecord: SegmentRecord? = null,
    checkpointPayload: String? = null,
  ) {
    if (!spoolingEnabled()) return
    val failureCode = spoolFailureCode
    if (failureCode != null) {
      throw SegmentPipelineException(
        failureCode,
        spoolFailureMessage ?: "Segment spool unavailable for $bufferId"
      )
    }
    synchronized(spoolLock) {
      val writer = journalWriter
      if (writer == null) {
        when (spoolingMode) {
          SegmentSpoolingMode.OFF -> return
          SegmentSpoolingMode.ON -> {
            ensureSpoolWriterActivatedLocked(checkpointPayload ?: """{"segments":[]}""")
            return
          }
          SegmentSpoolingMode.AUTO -> {
            if (!mayActivateAuto) return
            val estimatedBytes =
              SegmentSpoolFormat.HEADER_BYTES + (checkpointPayload ?: "").toByteArray().size
            spoolEstimatedBytes += estimatedBytes.toLong()
            if (spoolEstimatedBytes < spoolThresholdBytes.coerceAtLeast(0L)) {
              spoolReady = false
              return
            }
            ensureSpoolWriterActivatedLocked(checkpointPayload ?: """{"segments":[]}""")
            return
          }
        }
      }
      try {
        if (appendRecord != null) {
          val payload = OfflineSegmentEntry.segmentsToJson(listOf(appendRecord))
          writer.appendRecord(SegmentSpoolFormat.RECORD_SEGMENT_APPEND, payload)
          journalEventCount += 1
          journalBytesSinceCheckpoint += (SegmentSpoolFormat.HEADER_BYTES + payload.toByteArray().size).toLong()
        }
        if (checkpointPayload != null && (
            journalEventCount >= SegmentSpoolFormat.CHECKPOINT_EVERY_EVENTS ||
              journalBytesSinceCheckpoint >= SegmentSpoolFormat.CHECKPOINT_EVERY_BYTES
            )
        ) {
          val cp = checkpointWriter ?: SegmentCheckpointWriter(checkpointPath()
            ?: throw SegmentPipelineException(SegmentErrorCodes.SPOOL_UNAVAILABLE, "Missing checkpoint path for $bufferId"))
          cp.writeSnapshot(checkpointPayload)
          writer.truncate()
          writer.appendRecord(SegmentSpoolFormat.RECORD_CHECKPOINT_MARK, "{}")
          checkpointWriter = cp
          journalEventCount = 0
          journalBytesSinceCheckpoint = 0L
        }
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

  private fun readFullStateFromSpool(basePath: String): List<SegmentRecord> {
    val journalPath = "$basePath.segj"
    val checkpointPath = "$basePath.segc"
    val hasSpool = File(journalPath).exists() || File(checkpointPath).exists()
    if (!hasSpool) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_UNAVAILABLE,
        "Segment spool files are missing for $bufferId"
      )
    }
    val checkpointJson = SegmentCheckpointReader.readSnapshot(checkpointPath) ?: """{"segments":[]}"""
    val base = OfflineSegmentEntry.segmentsFromJson(checkpointJson).toMutableList()
    val records = SegmentJournalReader.readAllRecords(journalPath)
    records.forEach { record ->
      when (record.type) {
        SegmentSpoolFormat.RECORD_SEGMENT_APPEND -> {
          val parsed = OfflineSegmentEntry.segmentsFromJson(record.payload)
          if (parsed.isNotEmpty()) base.add(parsed[0])
        }
        SegmentSpoolFormat.RECORD_CHECKPOINT_MARK,
        SegmentSpoolFormat.RECORD_FINALIZE_MARK -> {}
        else -> throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Unknown segment journal record type in $journalPath"
        )
      }
    }
    return base
  }
}
