package com.sherpaonnx.segment.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Thin handle over shared C++ SegLiveEntry for spool/window SoT.
 * Kotlin keeps a mirror segment log + listeners for pipeline workers (S8 backlog).
 */
class LiveSegmentEntry(
  val bufferId: String,
  val sourceAudioBufferId: String? = null,
  private val maxSegments: Int = 4096,
  private val spoolingMode: SegmentSpoolingMode = SegmentSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  @Suppress("UNUSED_PARAMETER") private val spoolThresholdBytes: Long = 0,
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

    fun wrap(bufferId: String): LiveSegmentEntry? {
      if (!SegmentBufferNative.nativeIsLive(bufferId)) return null
      return LiveSegmentEntry(bufferId = bufferId)
    }
  }

  enum class State { RECORDING, FINISHED }

  private val stateRef = AtomicReference(State.RECORDING)
  val state: State get() = stateRef.get()

  private val segmentLock = Any()
  private val segments = ArrayList<SegmentRecord>()
  private var evictedCount: Long = 0
  private val totalSegmentsWritten = AtomicLong(0)
  private val cursors = HashMap<Int, AtomicInteger>()
  private val nextCursorId = AtomicInteger(0)
  private val commitListeners =
    CopyOnWriteArrayList<Pair<Int, (String, Int, SegmentRecord) -> Unit>>()
  private val nextCommitListenerToken = AtomicInteger(0)
  @Volatile private var lastSegmentEventEmitAtMs: Long = 0L

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
    forceEmitAppendedEvent: Boolean = false,
  ): Pair<String, Int> {
    val normalizedKind = kind.trim().ifEmpty { "speech" }
    if (!ALLOWED_KINDS.contains(normalizedKind)) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_ARGUMENT,
        "kind must be one of speech, alignment, or diarization; received $kind",
      )
    }
    if (state == State.FINISHED) {
      throw SegmentPipelineException(
        SegmentErrorCodes.ALREADY_FINALIZED,
        "Live segment buffer is finalized: $bufferId",
      )
    }
    val effectiveDurationMs =
      durationMs
        ?: (((endSample - startSample).coerceAtLeast(0) * 1000L) / sampleRate.coerceAtLeast(1)).toInt()
    val outIds = arrayOfNulls<String>(2)
    val ok =
      SegmentBufferNative.nativeAppendSegment(
        bufferId,
        normalizedKind,
        sourceAudioBufferId,
        startSample,
        endSample,
        sampleRate,
        effectiveDurationMs,
        confidence != null,
        confidence ?: 0.0,
        payloadJson,
        outIds,
      )
    if (!ok) {
      throw SegmentPipelineException(
        SegmentErrorCodes.INVALID_STATE,
        "nativeAppendSegment failed for $bufferId",
      )
    }
    val segmentId = outIds[0] ?: ""
    val segmentIndex = outIds[1]?.toIntOrNull() ?: -1
    val record =
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
      )
    var totalSegmentsInBuffer = 0
    synchronized(segmentLock) {
      segments.add(record)
      if (segments.size > maxSegments) {
        segments.removeAt(0)
        evictedCount++
      }
      totalSegmentsWritten.incrementAndGet()
      totalSegmentsInBuffer = segments.size
    }

    if (annotationReason != null && annotationSource != null) {
      com.sherpaonnx.segment.engine.SegmentationEngineRegistry.recordSegmentAnnotation(
        segmentId = segmentId,
        annotation =
          com.sherpaonnx.segment.engine.SegmentAnnotationSnapshot(
            reason = annotationReason,
            source = annotationSource,
            createdAtMs = annotationCreatedAtMs ?: System.currentTimeMillis(),
            segmentIndex = segmentIndex,
          ),
      )
    }

    if (emitSegmentAppendedEvents || forceEmitAppendedEvent) {
      val now = System.currentTimeMillis()
      if (
        forceEmitAppendedEvent ||
          segmentEventMinIntervalMs <= 0L ||
          now - lastSegmentEventEmitAtMs >= segmentEventMinIntervalMs
      ) {
        lastSegmentEventEmitAtMs = now
        try {
          SegmentBufferEventBridge.emitSegmentAppended?.invoke(
            bufferId,
            record,
            segmentIndex,
            totalSegmentsInBuffer,
          )
        } catch (_: Exception) {
        }
      }
    }
    notifyCommitListeners(segmentId, segmentIndex, record)
    return Pair(segmentId, segmentIndex)
  }

  fun finalize_() {
    if (state == State.FINISHED) {
      throw SegmentPipelineException(
        SegmentErrorCodes.ALREADY_FINALIZED,
        "Already finalized: $bufferId",
      )
    }
    if (!SegmentBufferNative.nativeFinalizeLive(bufferId)) {
      throw SegmentPipelineException(
        SegmentErrorCodes.ALREADY_FINALIZED,
        "finalize failed for $bufferId",
      )
    }
    stateRef.set(State.FINISHED)
  }

  fun snapshotWindow(): List<SegmentRecord> {
    val json = SegmentBufferNative.nativeLiveSnapshotJson(bufferId, "windowSnapshot")
    if (json != null) return OfflineSegmentEntry.segmentsFromJson(json)
    synchronized(segmentLock) {
      return segments.toList()
    }
  }

  fun snapshotFullIfSpooled(): List<SegmentRecord> {
    val json =
      SegmentBufferNative.nativeLiveSnapshotJson(bufferId, "fullIfSpooled")
        ?: throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_UNAVAILABLE,
          "Segment spool unavailable for $bufferId",
        )
    return OfflineSegmentEntry.segmentsFromJson(json)
  }

  fun getSegments(startIndex: Int, maxCount: Int): List<SegmentRecord> {
    val all = snapshotWindow()
    if (startIndex < 0 || maxCount < 0) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SLICE_INVALID,
        "Invalid segment slice range start=$startIndex maxCount=$maxCount",
      )
    }
    if (startIndex >= all.size) return emptyList()
    val end = minOf(startIndex + maxCount, all.size)
    return all.subList(startIndex, end)
  }

  fun createSegmentCursor(): Int {
    val cursorId = nextCursorId.getAndIncrement()
    synchronized(segmentLock) { cursors[cursorId] = AtomicInteger(0) }
    return cursorId
  }

  fun drainSegments(cursorId: Int, maxCount: Int): List<CommittedSegment> {
    if (maxCount <= 0) return emptyList()
    synchronized(segmentLock) {
      val cursor =
        cursors[cursorId]
          ?: throw SegmentPipelineException(
            SegmentErrorCodes.BUFFER_NOT_FOUND,
            "Segment cursor not found: $cursorId",
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
          ),
        )
      }
      cursor.set(end)
      return committed
    }
  }

  fun releaseSegmentCursor(cursorId: Int) {
    synchronized(segmentLock) { cursors.remove(cursorId) }
  }

  fun addCommitListener(
    listener: (segmentId: String, segmentIndex: Int, record: SegmentRecord) -> Unit,
  ): Int {
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

  fun segmentCount(): Int {
    val n = SegmentBufferNative.nativeLiveSegmentCount(bufferId)
    return if (n >= 0) n else synchronized(segmentLock) { segments.size }
  }

  fun release() {
    SegmentBufferNative.nativeRelease(bufferId)
    commitListeners.clear()
    synchronized(segmentLock) {
      cursors.clear()
      segments.clear()
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
    map.putBoolean("spoolEnabled", spoolingMode != SegmentSpoolingMode.OFF)
    map.putBoolean("spoolReady", spoolingMode != SegmentSpoolingMode.OFF)
    map.putDouble("spoolBytes", 0.0)
    if (!spoolPath.isNullOrEmpty()) {
      map.putString("spoolPath", spoolPath)
    }
    return map
  }
}
