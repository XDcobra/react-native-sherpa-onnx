package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * Thin handle over shared C++ TxtLiveEntry for spool/window SoT.
 * Kotlin keeps segment log + listeners for existing pipeline workers (materialize path;
 * tracked in Post–Buffer-in-C backlog T1).
 */
class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
  val maxSegments: Int = 4096,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0,
  private val spoolingMode: TextSpoolingMode = TextSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  @Suppress("UNUSED_PARAMETER") private val spoolThresholdBytes: Long = 0,
) {
  enum class State { RECORDING, FINISHED }

  private val stateRef = AtomicReference(State.RECORDING)
  val state: State get() = stateRef.get()

  @Volatile
  var currentText: String = ""
    private set

  private val totalChars = AtomicLong(0)
  val totalCharsWritten: Long get() = totalChars.get()

  private val revisionCounter = AtomicInteger(0)
  val revision: Int get() = revisionCounter.get()

  private val segments = ArrayDeque<TextSegment>()
  private val segmentLock = Any()
  private var evictedCount = 0L

  private val appendListeners = CopyOnWriteArrayList<Pair<Int, () -> Unit>>()
  private val nextListenerToken = AtomicInteger(0)
  private val commitListeners = CopyOnWriteArrayList<Pair<Int, (TextSegment) -> Unit>>()
  private val nextCommitListenerToken = AtomicInteger(0)

  private class SegmentCursor(val cursorId: Int, @Volatile var readPos: Int = 0)
  private val cursors = HashMap<Int, SegmentCursor>()
  private val nextCursorId = AtomicInteger(0)
  private val cursorLock = Any()

  val segmentCount: Int get() = synchronized(segmentLock) { segments.size }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", "liveTextBuffer")
    map.putString("state", if (state == State.FINISHED) "finished" else "recording")
    map.putDouble("totalCharsWritten", totalCharsWritten.toDouble())
    map.putInt("revision", revision)
    map.putInt("segmentCount", segmentCount)
    map.putString("spoolMode", spoolingMode.rawValue())
    map.putBoolean("spoolEnabled", spoolingMode != TextSpoolingMode.OFF)
    map.putBoolean("spoolReady", spoolingMode != TextSpoolingMode.OFF)
    map.putDouble("spoolBytes", 0.0)
    spoolPath?.let { map.putString("spoolPath", it) }
    return map
  }

  fun writePartial(text: String) {
    check(state == State.RECORDING) { "Live text buffer is finalized: $bufferId" }
    if (!TextBufferNative.nativeWritePartial(bufferId, text)) {
      throw TextPipelineException(TextErrorCodes.INVALID_STATE, "writePartial failed for $bufferId")
    }
    currentText =
      if (text.length > windowMaxChars) text.takeLast(windowMaxChars) else text
    totalChars.addAndGet(text.length.toLong())
    revisionCounter.incrementAndGet()
    SegmentationEngineRegistry.onLiveTextWrite(bufferId)
    TextPipelineRegistry.notifyLivePartialWritten(this, "set")
    notifyAppendListeners()
  }

  fun appendText(text: String) {
    check(state == State.RECORDING) { "Live text buffer is finalized: $bufferId" }
    val combined = currentText + text
    if (!TextBufferNative.nativeWritePartial(bufferId, combined)) {
      throw TextPipelineException(TextErrorCodes.INVALID_STATE, "appendText failed for $bufferId")
    }
    currentText =
      if (combined.length > windowMaxChars) combined.takeLast(windowMaxChars) else combined
    totalChars.addAndGet(text.length.toLong())
    revisionCounter.incrementAndGet()
    SegmentationEngineRegistry.onLiveTextWrite(bufferId)
    TextPipelineRegistry.notifyLivePartialWritten(this, "append")
    notifyAppendListeners()
  }

  fun commitSegment(
    text: String,
    tokens: Array<String> = emptyArray(),
    timestamps: FloatArray = FloatArray(0),
    source: String = "unknown",
    meta: Map<String, Any?>? = null,
  ): Int {
    check(state == State.RECORDING) { "Live text buffer is finalized: $bufferId" }
    val metaJson = meta?.let { JSONObject(it).toString() }
    val idx = TextBufferNative.nativeCommitSegment(bufferId, text, source, metaJson)
    if (idx < 0) {
      throw TextPipelineException(TextErrorCodes.INVALID_STATE, "commitSegment failed for $bufferId")
    }
    val segment: TextSegment
    synchronized(segmentLock) {
      segment =
        TextSegment(
          text = text,
          tokens = tokens,
          timestamps = timestamps,
          source = source,
          segmentIndex = (evictedCount + segments.size).toInt(),
          meta = meta,
        )
      segments.addLast(segment)
      while (segments.size > maxSegments) {
        segments.removeFirst()
        evictedCount++
        synchronized(cursorLock) {
          for (c in cursors.values) {
            if (c.readPos > 0) c.readPos-- else c.readPos = 0
          }
        }
      }
      if (currentText.startsWith(text)) {
        currentText = currentText.substring(text.length)
      }
      totalChars.addAndGet(text.length.toLong())
      revisionCounter.incrementAndGet()
    }
    notifyAppendListeners()
    notifyCommitListeners(segment)
    return segment.segmentIndex
  }

  fun finalize_() {
    check(state == State.RECORDING) { "Already finalized: $bufferId" }
    if (!TextBufferNative.nativeFinalizeLive(bufferId)) {
      throw TextPipelineException(TextErrorCodes.ALREADY_FINALIZED, "finalize failed for $bufferId")
    }
    stateRef.set(State.FINISHED)
    notifyAppendListeners()
    SegmentationEngineRegistry.onBufferFinalized(bufferId)
  }

  fun snapshotText(): String = currentText

  fun snapshotFullTextIfSpooled(): String {
    // Prefer C spool replay when available.
    val snap = TextBufferNative.nativeLiveSnapshot(bufferId)
    if (snap != null && snap.isNotEmpty()) return snap
    synchronized(segmentLock) {
      val committed = segments.joinToString("") { it.text }
      return committed + currentText
    }
  }

  fun getSegments(startIndex: Int, maxCount: Int): List<TextSegment> {
    if (startIndex < 0 || maxCount <= 0) return emptyList()
    synchronized(segmentLock) {
      if (startIndex >= segments.size) return emptyList()
      val end = minOf(startIndex + maxCount, segments.size)
      return segments.toList().subList(startIndex, end)
    }
  }

  fun createSegmentCursor(): Int {
    val id = nextCursorId.getAndIncrement()
    synchronized(cursorLock) { cursors[id] = SegmentCursor(id) }
    return id
  }

  fun drainSegments(cursorId: Int, maxCount: Int): List<TextSegment> {
    synchronized(cursorLock) {
      val cursor = cursors[cursorId] ?: return emptyList()
      synchronized(segmentLock) {
        if (cursor.readPos >= segments.size) return emptyList()
        val end = minOf(cursor.readPos + maxCount, segments.size)
        val out = segments.toList().subList(cursor.readPos, end)
        cursor.readPos = end
        return out
      }
    }
  }

  fun releaseSegmentCursor(cursorId: Int) {
    synchronized(cursorLock) { cursors.remove(cursorId) }
  }

  fun addAppendListener(listener: () -> Unit): Int {
    val token = nextListenerToken.getAndIncrement()
    appendListeners.add(Pair(token, listener))
    return token
  }

  fun removeAppendListener(token: Int) {
    appendListeners.removeAll { it.first == token }
  }

  private fun notifyAppendListeners() {
    for ((_, listener) in appendListeners) {
      listener()
    }
  }

  fun addCommitListener(listener: (TextSegment) -> Unit): Int {
    val token = nextCommitListenerToken.getAndIncrement()
    commitListeners.add(Pair(token, listener))
    return token
  }

  fun removeCommitListener(token: Int) {
    commitListeners.removeAll { it.first == token }
  }

  private fun notifyCommitListeners(segment: TextSegment) {
    for ((_, listener) in commitListeners) {
      listener(segment)
    }
  }

  fun release() {
    try {
      if (state == State.RECORDING) {
        TextBufferNative.nativeFinalizeLive(bufferId)
      }
    } catch (_: Exception) {
    }
    TextBufferNative.nativeRelease(bufferId)
    SegmentationEngineRegistry.onBufferReleased(bufferId)
    appendListeners.clear()
    commitListeners.clear()
    synchronized(cursorLock) { cursors.clear() }
    synchronized(segmentLock) { segments.clear() }
  }

  companion object {
    fun wrap(bufferId: String): LiveTextEntry? {
      if (!TextBufferNative.nativeIsLive(bufferId)) return null
      return LiveTextEntry(bufferId = bufferId)
    }
  }
}
