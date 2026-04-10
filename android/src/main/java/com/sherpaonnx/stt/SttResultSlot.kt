package com.sherpaonnx.stt

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Retained recognition result held in native memory.
 * Large arrays stay here; JS fetches via discrete getters.
 */
data class SttRetainedResult(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val durations: FloatArray,
  val lang: String,
  val emotion: String,
  val event: String,
  val sampleRate: Int,
  val source: String // "file", "buffer", "samples"
) {
  fun toTranscribeRefMap(resultId: Long): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", true)
    map.putDouble("resultId", resultId.toDouble())
    map.putDouble("sampleRate", sampleRate.toDouble())
    map.putInt("textLength", text.length)
    map.putInt("tokenCount", tokens.size)
    map.putInt("timestampCount", timestamps.size)
    map.putInt("durationCount", durations.size)
    map.putBoolean("hasLang", lang.isNotEmpty())
    map.putBoolean("hasEmotion", emotion.isNotEmpty())
    map.putBoolean("hasEvent", event.isNotEmpty())
    map.putString("source", source)
    return map
  }
}

/**
 * Per-instance result slot. Holds at most one result at a time.
 * Each successful transcribe replaces the slot and increments the resultId.
 */
class SttResultSlot {
  companion object {
    private val globalIdCounter = AtomicLong(0)
  }

  @Volatile
  var currentResultId: Long = -1
    private set

  @Volatile
  var result: SttRetainedResult? = null
    private set

  fun store(newResult: SttRetainedResult): Long {
    val id = globalIdCounter.incrementAndGet()
    currentResultId = id
    result = newResult
    return id
  }

  fun release() {
    currentResultId = -1
    result = null
  }

  fun isStale(requestedId: Long): Boolean {
    return requestedId != currentResultId
  }

  fun isEmpty(): Boolean {
    return result == null
  }
}
