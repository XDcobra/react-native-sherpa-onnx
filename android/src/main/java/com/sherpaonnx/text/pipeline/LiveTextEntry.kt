package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * Thin handle over shared C++ TxtLiveEntry (window / segment log / cursors in C).
 * Kotlin keeps listener tokens + JS event fan-out only (Audio LiveEntry pattern).
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

  val state: State
    get() =
      if (TextBufferNative.nativeLiveState(bufferId) == 1) State.FINISHED else State.RECORDING

  val currentText: String
    get() = TextBufferNative.nativeSnapshotText(bufferId) ?: ""

  val totalCharsWritten: Long
    get() = TextBufferNative.nativeLiveTotalChars(bufferId).coerceAtLeast(0)

  val revision: Int
    get() = TextBufferNative.nativeLiveRevision(bufferId).coerceAtLeast(0)

  val segmentCount: Int
    get() = TextBufferNative.nativeLiveSegmentCount(bufferId).coerceAtLeast(0)

  private val appendListeners = CopyOnWriteArrayList<Pair<Int, () -> Unit>>()
  private val nextListenerToken = AtomicInteger(0)
  private val commitListeners = CopyOnWriteArrayList<Pair<Int, (TextSegment) -> Unit>>()
  private val nextCommitListenerToken = AtomicInteger(0)

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
    SegmentationEngineRegistry.onLiveTextWrite(bufferId)
    TextPipelineRegistry.notifyLivePartialWritten(this, "set")
    notifyAppendListeners()
  }

  fun appendText(text: String) {
    check(state == State.RECORDING) { "Live text buffer is finalized: $bufferId" }
    if (!TextBufferNative.nativeAppendText(bufferId, text)) {
      throw TextPipelineException(TextErrorCodes.INVALID_STATE, "appendText failed for $bufferId")
    }
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
    val idx =
      TextBufferNative.nativeCommitSegment(bufferId, text, tokens, timestamps, source, metaJson)
    if (idx < 0) {
      throw TextPipelineException(TextErrorCodes.INVALID_STATE, "commitSegment failed for $bufferId")
    }
    val segment =
      TextSegment(
        text = text,
        tokens = tokens,
        timestamps = timestamps,
        source = source,
        segmentIndex = idx,
        meta = meta,
      )
    notifyAppendListeners()
    notifyCommitListeners(segment)
    return idx
  }

  fun finalize_() {
    check(state == State.RECORDING) { "Already finalized: $bufferId" }
    if (!TextBufferNative.nativeFinalizeLive(bufferId)) {
      throw TextPipelineException(TextErrorCodes.ALREADY_FINALIZED, "finalize failed for $bufferId")
    }
    notifyAppendListeners()
    SegmentationEngineRegistry.onBufferFinalized(bufferId)
  }

  fun snapshotText(): String = currentText

  fun snapshotFullTextIfSpooled(): String {
    val snap = TextBufferNative.nativeLiveSnapshot(bufferId)
    if (snap != null) return snap
    return currentText
  }

  fun getSegments(startIndex: Int, maxCount: Int): List<TextSegment> {
    if (startIndex < 0 || maxCount <= 0) return emptyList()
    val json = TextBufferNative.nativeGetSegments(bufferId, startIndex, maxCount) ?: return emptyList()
    return parseSegmentsJson(json)
  }

  fun createSegmentCursor(): Int {
    val id = TextBufferNative.nativeCreateSegmentCursor(bufferId)
    if (id < 0) {
      throw TextPipelineException(
        TextErrorCodes.INVALID_STATE,
        "createSegmentCursor failed for $bufferId",
      )
    }
    return id
  }

  fun drainSegments(cursorId: Int, maxCount: Int): List<TextSegment> {
    val json =
      TextBufferNative.nativeDrainSegments(bufferId, cursorId, maxCount) ?: return emptyList()
    return parseSegmentsJson(json)
  }

  fun releaseSegmentCursor(cursorId: Int) {
    TextBufferNative.nativeReleaseSegmentCursor(bufferId, cursorId)
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
  }

  companion object {
    fun wrap(bufferId: String): LiveTextEntry? {
      if (!TextBufferNative.nativeIsLive(bufferId)) return null
      return LiveTextEntry(bufferId = bufferId)
    }

    internal fun parseSegmentsJson(json: String): List<TextSegment> {
      if (json.isEmpty() || json == "[]") return emptyList()
      val arr = JSONArray(json)
      val out = ArrayList<TextSegment>(arr.length())
      for (i in 0 until arr.length()) {
        val obj = arr.getJSONObject(i)
        val tokensArr = obj.optJSONArray("tokens")
        val tokens =
          if (tokensArr != null) {
            Array(tokensArr.length()) { t -> tokensArr.optString(t, "") }
          } else {
            emptyArray()
          }
        val tsArr = obj.optJSONArray("timestamps")
        val timestamps =
          if (tsArr != null) {
            FloatArray(tsArr.length()) { t -> tsArr.optDouble(t, 0.0).toFloat() }
          } else {
            FloatArray(0)
          }
        val metaJson = obj.optString("metaJson", "")
        val meta: Map<String, Any?>? =
          if (metaJson.isNotEmpty()) {
            try {
              jsonObjectToMap(JSONObject(metaJson))
            } catch (_: Exception) {
              null
            }
          } else {
            null
          }
        out.add(
          TextSegment(
            text = obj.optString("text", ""),
            tokens = tokens,
            timestamps = timestamps,
            source = obj.optString("source", "unknown"),
            segmentIndex = obj.optInt("segmentIndex", i),
            meta = meta,
          ),
        )
      }
      return out
    }

    private fun jsonObjectToMap(obj: JSONObject): Map<String, Any?> {
      val map = LinkedHashMap<String, Any?>()
      val keys = obj.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        map[key] = jsonValueToAny(obj.get(key))
      }
      return map
    }

    private fun jsonValueToAny(value: Any?): Any? {
      return when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> jsonObjectToMap(value)
        is JSONArray -> {
          val list = ArrayList<Any?>(value.length())
          for (i in 0 until value.length()) {
            list.add(jsonValueToAny(value.get(i)))
          }
          list
        }
        is Number, is Boolean, is String -> value
        else -> value.toString()
      }
    }
  }
}
