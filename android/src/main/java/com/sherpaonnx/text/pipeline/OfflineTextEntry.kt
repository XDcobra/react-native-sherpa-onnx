package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

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
}

/**
 * Thin handle over shared C++ TxtOfflineEntry.
 * Local fields mirror C for Kotlin consumers; populate syncs into C.
 */
class OfflineTextEntry(
  val bufferId: String,
  text: String = "",
  tokens: Array<String> = emptyArray(),
  timestamps: FloatArray = floatArrayOf(),
  durations: FloatArray = floatArrayOf(),
  spatialSpans: List<TextSpatialSpan> = emptyList(),
  lang: String = "",
  emotion: String = "",
  event: String = "",
  populated: Boolean = false,
) {
  @Volatile var text: String = text
  @Volatile var tokens: Array<String> = tokens
  @Volatile var timestamps: FloatArray = timestamps
  @Volatile var durations: FloatArray = durations
  @Volatile var spatialSpans: List<TextSpatialSpan> = spatialSpans
  @Volatile var lang: String = lang
  @Volatile var emotion: String = emotion
  @Volatile var event: String = event
  @Volatile var populated: Boolean = populated

  val kind: String = "offlineTextBuffer"
  val state: String = "immutable"

  val utf16Length: Int
    get() {
      val n = TextBufferNative.nativeOfflineUtf16Length(bufferId)
      return if (n >= 0) n else text.length
    }
  val tokenCount: Int get() = tokens.size
  val timestampCount: Int get() = timestamps.size
  val durationCount: Int get() = durations.size
  val spatialSpanCount: Int get() = spatialSpans.size
  val hasLang: Boolean get() = lang.isNotEmpty()
  val hasEmotion: Boolean get() = emotion.isNotEmpty()
  val hasEvent: Boolean get() = event.isNotEmpty()
  val hasSpatialSpans: Boolean get() = spatialSpans.isNotEmpty()

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
    if (!TextBufferNative.nativePopulateIfEmpty(bufferId, text, lang, emotion, event)) {
      throw IllegalStateException("Native populate failed for $bufferId")
    }
    this.text = text
    this.tokens = tokens
    this.timestamps = timestamps
    this.durations = durations
    this.spatialSpans = spatialSpans
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
    map.putInt("spatialSpanCount", spatialSpanCount)
    map.putBoolean("hasLang", hasLang)
    map.putBoolean("hasEmotion", hasEmotion)
    map.putBoolean("hasEvent", hasEvent)
    map.putBoolean("hasSpatialSpans", hasSpatialSpans)
    return map
  }

  fun spatialSpansSlice(start: Int, maxCount: Int): WritableArray {
    val arr = Arguments.createArray()
    if (start >= spatialSpans.size) return arr
    val end = minOf(start + maxCount, spatialSpans.size)
    for (i in start until end) {
      arr.pushMap(spatialSpans[i].toWritableMap())
    }
    return arr
  }

  companion object {
    fun wrap(bufferId: String): OfflineTextEntry? {
      if (!TextBufferNative.nativeIsOffline(bufferId)) return null
      val text = TextBufferNative.nativeReadOfflineText(bufferId) ?: ""
      val populated = TextBufferNative.nativeOfflinePopulated(bufferId)
      return OfflineTextEntry(
        bufferId = bufferId,
        text = text,
        populated = populated,
      )
    }
  }
}
