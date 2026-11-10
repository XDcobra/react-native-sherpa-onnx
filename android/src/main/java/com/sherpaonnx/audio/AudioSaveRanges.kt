package com.sherpaonnx.audio

import com.facebook.react.bridge.ReadableArray

/**
 * Half-open frame span `[startFrame, endFrame)`.
 */
data class FrameSpan(val startFrame: Long, val endFrame: Long) {
  val length: Long get() = (endFrame - startFrame).coerceAtLeast(0L)
}

/**
 * Parse / normalize ms ranges for native multi-range audio save.
 */
object AudioSaveRanges {
  data class MsRange(val startMs: Double, val endMs: Double)

  /**
   * Parse ReadableArray of `{startMs,endMs}` maps.
   * Empty / null → empty list (caller treats as full input).
   * @throws IllegalArgumentException with AUDIO_SAVE_INVALID_RANGE prefix on bad bounds
   */
  fun parseMsRanges(ranges: ReadableArray?): List<MsRange> {
    if (ranges == null || ranges.size() == 0) return emptyList()
    val out = ArrayList<MsRange>(ranges.size())
    for (i in 0 until ranges.size()) {
      val map = ranges.getMap(i)
        ?: throw IllegalArgumentException(
          "AUDIO_SAVE_INVALID_RANGE: ranges[$i] must be an object with startMs/endMs"
        )
      val startMs = map.getDouble("startMs")
      val endMs = map.getDouble("endMs")
      if (!startMs.isFinite() || !endMs.isFinite() || endMs <= startMs) {
        throw IllegalArgumentException(
          "AUDIO_SAVE_INVALID_RANGE: each range requires finite startMs < endMs (exclusive end)"
        )
      }
      out.add(MsRange(startMs, endMs))
    }
    return out
  }

  /** Sort + merge overlapping/touching ms ranges. */
  fun normalizeMs(ranges: List<MsRange>): List<MsRange> {
    if (ranges.isEmpty()) return emptyList()
    val sorted = ranges.sortedWith(compareBy({ it.startMs }, { it.endMs }))
    val merged = ArrayList<MsRange>(sorted.size)
    for (r in sorted) {
      val last = merged.lastOrNull()
      if (last == null || r.startMs > last.endMs) {
        merged.add(r)
      } else if (r.endMs > last.endMs) {
        merged[merged.lastIndex] = MsRange(last.startMs, r.endMs)
      }
    }
    return merged
  }

  /**
   * Convert normalized ms ranges to clamped frame spans.
   * @param totalFrames media length in frames (mono PCM clock); used for clamp
   */
  fun toFrameSpans(
    rangesMs: List<MsRange>,
    sampleRate: Int,
    totalFrames: Long,
  ): List<FrameSpan> {
    if (rangesMs.isEmpty() || sampleRate <= 0 || totalFrames <= 0L) return emptyList()
    val spans = ArrayList<FrameSpan>(rangesMs.size)
    for (r in rangesMs) {
      val start = msToFrame(r.startMs, sampleRate).coerceIn(0L, totalFrames)
      val end = msToFrame(r.endMs, sampleRate).coerceIn(0L, totalFrames)
      if (end > start) {
        spans.add(FrameSpan(start, end))
      }
    }
    return mergeFrameSpans(spans)
  }

  fun mergeFrameSpans(spans: List<FrameSpan>): List<FrameSpan> {
    if (spans.isEmpty()) return emptyList()
    val sorted = spans.sortedWith(compareBy({ it.startFrame }, { it.endFrame }))
    val merged = ArrayList<FrameSpan>(sorted.size)
    for (s in sorted) {
      val last = merged.lastOrNull()
      if (last == null || s.startFrame > last.endFrame) {
        merged.add(s)
      } else if (s.endFrame > last.endFrame) {
        merged[merged.lastIndex] = FrameSpan(last.startFrame, s.endFrame)
      }
    }
    return merged
  }

  fun totalFrames(spans: List<FrameSpan>): Long =
    spans.sumOf { it.length }

  fun msToFrame(ms: Double, sampleRate: Int): Long {
    if (!ms.isFinite() || sampleRate <= 0) return 0L
    return kotlin.math.floor(ms * sampleRate / 1000.0).toLong().coerceAtLeast(0L)
  }
}
