package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * A committed text segment in the segment log.
 */
data class TextSegment(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val source: String,
  val segmentIndex: Int,
  val meta: Map<String, Any?>? = null,
)

/**
 * Live text buffer entry in the pipeline registry.
 * State machine: RECORDING → FINISHED (no reverse).
 *
 * Holds the most recent partial text, revision counter,
 * optional ring of recent partial history, and a committed
 * segment log with independent cursors + append listeners.
 */
class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
  val maxSegments: Int = 1000,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0
) {
  enum class State { RECORDING, FINISHED }

  @Volatile
  var state: State = State.RECORDING
    private set

  /** Current partial/final text. */
  @Volatile
  var currentText: String = ""
    private set

  /** Monotonic total chars written (including full replacements). */
  @Volatile
  var totalCharsWritten: Long = 0
    private set

  private val _revision = AtomicInteger(0)
  val revision: Int get() = _revision.get()

  val kind: String = "liveTextBuffer"

  // ── Segment log (ring with maxSegments capacity) ──
  private val segments = ArrayList<TextSegment>()
  private val segmentLock = Any()
  @Volatile
  private var evictedCount: Long = 0

  /** Total number of committed segments currently in the log. */
  val segmentCount: Int get() = synchronized(segmentLock) { segments.size }

  // ── Cursor system (for downstream pipeline workers) ──
  private val cursors = ConcurrentHashMap<Int, AtomicInteger>()
  private val nextCursorId = AtomicInteger(0)

  // ── Append listeners (token-based, for condition variable wakeup) ──
  private val appendListeners = CopyOnWriteArrayList<Pair<Int, () -> Unit>>()
  private val nextListenerToken = AtomicInteger(0)

  /**
   * Write/replace the current partial text. Increments revision.
   * @throws IllegalStateException if finalized.
   */
  @Synchronized
  fun writePartial(text: String) {
    if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
    currentText = if (text.length > windowMaxChars) {
      text.substring(text.length - windowMaxChars)
    } else {
      text
    }
    totalCharsWritten += text.length
    _revision.incrementAndGet()
  }

  /**
   * Append text to the current partial (for accumulative updates).
   * @throws IllegalStateException if finalized.
   */
  @Synchronized
  fun appendText(text: String) {
    if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
    val combined = currentText + text
    currentText = if (combined.length > windowMaxChars) {
      combined.substring(combined.length - windowMaxChars)
    } else {
      combined
    }
    totalCharsWritten += text.length
    _revision.incrementAndGet()
  }

  /**
   * Commit a finalized text segment to the segment log. Thread-safe.
   * Notifies append listeners (wakes downstream workers).
   * @throws IllegalStateException if finalized.
   */
  fun commitSegment(
    text: String,
    tokens: Array<String> = emptyArray(),
    timestamps: FloatArray = floatArrayOf(),
    source: String = "unknown",
    meta: Map<String, Any?>? = null,
  ): Int {
    var committedSegmentIndex = -1
    synchronized(segmentLock) {
      if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
      val segmentIndex = (evictedCount + segments.size).toInt()
      val segment = TextSegment(
        text = text,
        tokens = tokens,
        timestamps = timestamps,
        source = source,
        segmentIndex = segmentIndex,
        meta = meta,
      )
      segments.add(segment)
      committedSegmentIndex = segmentIndex
      // Evict oldest if over capacity
      if (segments.size > maxSegments) {
        segments.removeAt(0)
        evictedCount++
        // Snap cursors forward
        for ((_, pos) in cursors) {
          val p = pos.get()
          if (p > 0) pos.decrementAndGet()
          else pos.set(0)
        }
      }
      totalCharsWritten += text.length
      _revision.incrementAndGet()
    }
    notifyAppendListeners()
    return committedSegmentIndex
  }

  /**
   * Read committed segments by index range. Thread-safe.
   */
  fun getSegments(startIndex: Int, maxCount: Int): List<TextSegment> {
    synchronized(segmentLock) {
      if (startIndex < 0 || startIndex >= segments.size) return emptyList()
      val end = minOf(startIndex + maxCount, segments.size)
      return ArrayList(segments.subList(startIndex, end))
    }
  }

  // ── Cursor system ──

  /** Create a new cursor starting at segment position 0. Returns cursor ID. */
  fun createSegmentCursor(): Int {
    val id = nextCursorId.getAndIncrement()
    cursors[id] = AtomicInteger(0)
    return id
  }

  /**
   * Drain up to maxCount unread segments from this cursor's position.
   * Advances the cursor. Returns empty list if no unread segments available.
   */
  fun drainSegments(cursorId: Int, maxCount: Int): List<TextSegment> {
    val pos = cursors[cursorId]
      ?: throw IllegalArgumentException("Segment cursor not found: $cursorId")
    synchronized(segmentLock) {
      val currentPos = pos.get()
      if (currentPos >= segments.size) return emptyList()
      val end = minOf(currentPos + maxCount, segments.size)
      val result = ArrayList(segments.subList(currentPos, end))
      pos.addAndGet(result.size)
      return result
    }
  }

  /** Release a cursor handle. */
  fun releaseSegmentCursor(cursorId: Int) {
    cursors.remove(cursorId)
  }

  // ── Append listeners ──

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

  /**
   * Finalize: RECORDING → FINISHED. Notifies append listeners.
   * @throws IllegalStateException if already finalized.
   */
  @Synchronized
  fun finalize_() {
    if (state == State.FINISHED) throw IllegalStateException("Already finalized: $bufferId")
    state = State.FINISHED
    notifyAppendListeners()
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", if (state == State.RECORDING) "recording" else "finished")
    map.putDouble("totalCharsWritten", totalCharsWritten.toDouble())
    map.putInt("revision", revision)
    map.putInt("segmentCount", segmentCount)
    return map
  }

  /**
   * Snapshot current text for creating offline from live.
   */
  fun snapshotText(): String = currentText
}
