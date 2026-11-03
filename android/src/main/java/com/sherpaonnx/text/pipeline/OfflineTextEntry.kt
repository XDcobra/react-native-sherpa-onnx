package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * Spatial span linking a UTF-16 range of offline text to pixel coordinates
 * on a source image frame (OCR, PDF text layer, EPUB markup).
 */
data class TextSpatialSpan(
  val utf16Start: Int,
  val utf16End: Int,
  val level: String,
  val sourceImageBufferId: String,
  val frameIndex: Int,
  val quad: FloatArray,
  val confidence: Float? = null,
  val origin: String,
  val pageNumber: Int? = null,
  val ptsMs: Double? = null,
  val pageWidth: Float? = null,
  val pageHeight: Float? = null,
  val sectionIndex: Int? = null,
  val href: String? = null,
) {
  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putInt("utf16Start", utf16Start)
    map.putInt("utf16End", utf16End)
    map.putString("level", level)
    map.putString("sourceImageBufferId", sourceImageBufferId)
    map.putInt("frameIndex", frameIndex)
    val q = Arguments.createArray()
    for (i in 0 until 8) {
      q.pushDouble((quad.getOrNull(i) ?: 0f).toDouble())
    }
    map.putArray("quad", q)
    if (confidence != null) map.putDouble("confidence", confidence.toDouble())
    map.putString("origin", origin)
    if (pageNumber != null) map.putInt("pageNumber", pageNumber)
    if (ptsMs != null) map.putDouble("ptsMs", ptsMs)
    if (pageWidth != null) map.putDouble("pageWidth", pageWidth.toDouble())
    if (pageHeight != null) map.putDouble("pageHeight", pageHeight.toDouble())
    if (sectionIndex != null) map.putInt("sectionIndex", sectionIndex)
    if (!href.isNullOrEmpty()) map.putString("href", href)
    return map
  }

  fun toJsonObject(): JSONObject {
    val o = JSONObject()
    o.put("utf16Start", utf16Start)
    o.put("utf16End", utf16End)
    o.put("level", level)
    o.put("sourceImageBufferId", sourceImageBufferId)
    o.put("frameIndex", frameIndex)
    val q = JSONArray()
    for (i in 0 until 8) {
      q.put((quad.getOrNull(i) ?: 0f).toDouble())
    }
    o.put("quad", q)
    o.put("origin", origin)
    if (confidence != null) o.put("confidence", confidence.toDouble())
    if (pageNumber != null) o.put("pageNumber", pageNumber)
    if (ptsMs != null) o.put("ptsMs", ptsMs)
    if (pageWidth != null) o.put("pageWidth", pageWidth.toDouble())
    if (pageHeight != null) o.put("pageHeight", pageHeight.toDouble())
    if (sectionIndex != null) o.put("sectionIndex", sectionIndex)
    if (!href.isNullOrEmpty()) o.put("href", href)
    return o
  }

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is TextSpatialSpan) return false
    return utf16Start == other.utf16Start &&
      utf16End == other.utf16End &&
      level == other.level &&
      sourceImageBufferId == other.sourceImageBufferId &&
      frameIndex == other.frameIndex &&
      quad.contentEquals(other.quad) &&
      confidence == other.confidence &&
      origin == other.origin &&
      pageNumber == other.pageNumber &&
      ptsMs == other.ptsMs &&
      pageWidth == other.pageWidth &&
      pageHeight == other.pageHeight &&
      sectionIndex == other.sectionIndex &&
      href == other.href
  }

  override fun hashCode(): Int {
    var result = utf16Start
    result = 31 * result + utf16End
    result = 31 * result + level.hashCode()
    result = 31 * result + sourceImageBufferId.hashCode()
    result = 31 * result + frameIndex
    result = 31 * result + quad.contentHashCode()
    result = 31 * result + (confidence?.hashCode() ?: 0)
    result = 31 * result + origin.hashCode()
    result = 31 * result + (pageNumber ?: 0)
    result = 31 * result + (ptsMs?.hashCode() ?: 0)
    result = 31 * result + (pageWidth?.hashCode() ?: 0)
    result = 31 * result + (pageHeight?.hashCode() ?: 0)
    result = 31 * result + (sectionIndex ?: 0)
    result = 31 * result + (href?.hashCode() ?: 0)
    return result
  }

  companion object {
    fun fromJsonObject(obj: JSONObject): TextSpatialSpan {
      val quadArr = obj.optJSONArray("quad")
      val quad = FloatArray(8)
      if (quadArr != null) {
        for (i in 0 until minOf(8, quadArr.length())) {
          quad[i] = quadArr.optDouble(i, 0.0).toFloat()
        }
      }
      return TextSpatialSpan(
        utf16Start = obj.optInt("utf16Start", 0),
        utf16End = obj.optInt("utf16End", 0),
        level = obj.optString("level", "line"),
        sourceImageBufferId = obj.optString("sourceImageBufferId", ""),
        frameIndex = obj.optInt("frameIndex", 0),
        quad = quad,
        confidence = if (obj.has("confidence")) obj.optDouble("confidence").toFloat() else null,
        origin = obj.optString("origin", "ocr"),
        pageNumber = if (obj.has("pageNumber")) obj.optInt("pageNumber") else null,
        ptsMs = if (obj.has("ptsMs")) obj.optDouble("ptsMs") else null,
        pageWidth = if (obj.has("pageWidth")) obj.optDouble("pageWidth").toFloat() else null,
        pageHeight = if (obj.has("pageHeight")) obj.optDouble("pageHeight").toFloat() else null,
        sectionIndex = if (obj.has("sectionIndex")) obj.optInt("sectionIndex") else null,
        href = obj.optString("href", "").ifEmpty { null },
      )
    }
  }
}

/**
 * Thin handle over shared C++ TxtOfflineEntry (text/tokens/spans SoT in C).
 */
class OfflineTextEntry(
  val bufferId: String,
) {
  val kind: String = "offlineTextBuffer"
  val state: String = "immutable"

  val text: String
    get() = TextBufferNative.nativeReadOfflineText(bufferId) ?: ""

  val tokens: Array<String>
    get() {
      val n = tokenCount
      if (n <= 0) return emptyArray()
      return parseStringArrayJson(
        TextBufferNative.nativeOfflineTokensSlice(bufferId, 0, n) ?: "[]",
      )
    }

  val timestamps: FloatArray
    get() {
      val n = timestampCount
      if (n <= 0) return floatArrayOf()
      return parseFloatArrayJson(
        TextBufferNative.nativeOfflineTimestampsSlice(bufferId, 0, n) ?: "[]",
      )
    }

  val durations: FloatArray
    get() {
      val n = durationCount
      if (n <= 0) return floatArrayOf()
      return parseFloatArrayJson(
        TextBufferNative.nativeOfflineDurationsSlice(bufferId, 0, n) ?: "[]",
      )
    }

  val spatialSpans: List<TextSpatialSpan>
    get() {
      val n = spatialSpanCount
      if (n <= 0) return emptyList()
      return parseSpatialSpansJson(
        TextBufferNative.nativeOfflineSpatialSpansSlice(bufferId, 0, n) ?: "[]",
      )
    }

  val lang: String
    get() = TextBufferNative.nativeOfflineLang(bufferId) ?: ""

  val emotion: String
    get() = TextBufferNative.nativeOfflineEmotion(bufferId) ?: ""

  val event: String
    get() = TextBufferNative.nativeOfflineEvent(bufferId) ?: ""

  val populated: Boolean
    get() = TextBufferNative.nativeOfflinePopulated(bufferId)

  val utf16Length: Int
    get() {
      val n = TextBufferNative.nativeOfflineUtf16Length(bufferId)
      return if (n >= 0) n else text.length
    }

  val tokenCount: Int
    get() = TextBufferNative.nativeOfflineTokenCount(bufferId).coerceAtLeast(0)

  val timestampCount: Int
    get() = TextBufferNative.nativeOfflineTimestampCount(bufferId).coerceAtLeast(0)

  val durationCount: Int
    get() = TextBufferNative.nativeOfflineDurationCount(bufferId).coerceAtLeast(0)

  val spatialSpanCount: Int
    get() = TextBufferNative.nativeOfflineSpatialSpanCount(bufferId).coerceAtLeast(0)

  val hasLang: Boolean get() = lang.isNotEmpty()
  val hasEmotion: Boolean get() = emotion.isNotEmpty()
  val hasEvent: Boolean get() = event.isNotEmpty()
  val hasSpatialSpans: Boolean get() = spatialSpanCount > 0

  @Synchronized
  fun populate(
    text: String,
    tokens: Array<String>,
    timestamps: FloatArray,
    durations: FloatArray,
    lang: String,
    emotion: String,
    event: String,
    spatialSpans: List<TextSpatialSpan> = emptyList(),
  ) {
    if (populated) throw IllegalStateException("OfflineTextEntry already populated: $bufferId")
    val spansJson =
      if (spatialSpans.isEmpty()) {
        null
      } else {
        val arr = JSONArray()
        for (span in spatialSpans) {
          arr.put(span.toJsonObject())
        }
        arr.toString()
      }
    if (!TextBufferNative.nativePopulateIfEmpty(
        bufferId,
        text,
        tokens,
        timestamps,
        durations,
        lang,
        emotion,
        event,
        spansJson,
      )
    ) {
      throw IllegalStateException("Native populate failed for $bufferId")
    }
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
    map.putInt("spatialSpanCount", spatialSpanCount)
    map.putBoolean("hasLang", hasLang)
    map.putBoolean("hasEmotion", hasEmotion)
    map.putBoolean("hasEvent", hasEvent)
    map.putBoolean("hasSpatialSpans", hasSpatialSpans)
    return map
  }

  fun spatialSpansSlice(start: Int, maxCount: Int): WritableArray {
    val arr = Arguments.createArray()
    if (start < 0 || maxCount <= 0) return arr
    val json =
      TextBufferNative.nativeOfflineSpatialSpansSlice(bufferId, start, maxCount) ?: return arr
    for (span in parseSpatialSpansJson(json)) {
      arr.pushMap(span.toWritableMap())
    }
    return arr
  }

  companion object {
    fun wrap(bufferId: String): OfflineTextEntry? {
      if (!TextBufferNative.nativeIsOffline(bufferId)) return null
      return OfflineTextEntry(bufferId = bufferId)
    }

    internal fun parseStringArrayJson(json: String): Array<String> {
      if (json.isEmpty() || json == "[]") return emptyArray()
      val arr = JSONArray(json)
      return Array(arr.length()) { i -> arr.optString(i, "") }
    }

    internal fun parseFloatArrayJson(json: String): FloatArray {
      if (json.isEmpty() || json == "[]") return floatArrayOf()
      val arr = JSONArray(json)
      return FloatArray(arr.length()) { i -> arr.optDouble(i, 0.0).toFloat() }
    }

    internal fun parseSpatialSpansJson(json: String): List<TextSpatialSpan> {
      if (json.isEmpty() || json == "[]") return emptyList()
      val arr = JSONArray(json)
      val out = ArrayList<TextSpatialSpan>(arr.length())
      for (i in 0 until arr.length()) {
        out.add(TextSpatialSpan.fromJsonObject(arr.getJSONObject(i)))
      }
      return out
    }
  }
}
