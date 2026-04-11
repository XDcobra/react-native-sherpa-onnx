package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Live text buffer entry in the pipeline registry.
 * State machine: RECORDING → FINISHED (no reverse).
 *
 * Holds the most recent partial text, revision counter,
 * and optional ring of recent partial history.
 */
class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
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
   * Finalize: RECORDING → FINISHED
   * @throws IllegalStateException if already finalized.
   */
  @Synchronized
  fun finalize_() {
    if (state == State.FINISHED) throw IllegalStateException("Already finalized: $bufferId")
    state = State.FINISHED
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", if (state == State.RECORDING) "recording" else "finished")
    map.putDouble("totalCharsWritten", totalCharsWritten.toDouble())
    map.putInt("revision", revision)
    return map
  }

  /**
   * Snapshot current text for creating offline from live.
   */
  fun snapshotText(): String = currentText
}
