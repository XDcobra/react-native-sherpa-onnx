package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

/**
 * Offline text buffer entry in the pipeline registry.
 * Immutable once populated (either empty on creation, then filled by STT, or seeded from live snapshot).
 *
 * Holds the recognition result: text, tokens, timestamps, durations, lang, emotion, event.
 */
class OfflineTextEntry(
  val bufferId: String,
  @Volatile var text: String = "",
  @Volatile var tokens: Array<String> = emptyArray(),
  @Volatile var timestamps: FloatArray = floatArrayOf(),
  @Volatile var durations: FloatArray = floatArrayOf(),
  @Volatile var lang: String = "",
  @Volatile var emotion: String = "",
  @Volatile var event: String = "",
  @Volatile var populated: Boolean = false
) {
  val kind: String = "offlineTextBuffer"
  val state: String = "immutable"

  val utf16Length: Int get() = text.length
  val tokenCount: Int get() = tokens.size
  val timestampCount: Int get() = timestamps.size
  val durationCount: Int get() = durations.size
  val hasLang: Boolean get() = lang.isNotEmpty()
  val hasEmotion: Boolean get() = emotion.isNotEmpty()
  val hasEvent: Boolean get() = event.isNotEmpty()

  /**
   * Populate the entry with STT result data. Only allowed once.
   * @throws IllegalStateException if already populated.
   */
  @Synchronized
  fun populate(
    text: String,
    tokens: Array<String>,
    timestamps: FloatArray,
    durations: FloatArray,
    lang: String,
    emotion: String,
    event: String
  ) {
    if (populated) throw IllegalStateException("OfflineTextEntry already populated: $bufferId")
    this.text = text
    this.tokens = tokens
    this.timestamps = timestamps
    this.durations = durations
    this.lang = lang
    this.emotion = emotion
    this.event = event
    this.populated = true
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", state)
    map.putInt("utf16Length", utf16Length)
    map.putInt("tokenCount", tokenCount)
    map.putInt("timestampCount", timestampCount)
    map.putInt("durationCount", durationCount)
    map.putBoolean("hasLang", hasLang)
    map.putBoolean("hasEmotion", hasEmotion)
    map.putBoolean("hasEvent", hasEvent)
    return map
  }
}
