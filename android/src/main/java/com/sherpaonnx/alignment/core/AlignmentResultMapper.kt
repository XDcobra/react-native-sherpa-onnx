package com.sherpaonnx.alignment.core

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.util.ArrayList
import java.util.HashMap

internal object AlignmentResultMapper {
  data class AlignmentSubtitleItem(
    val text: String,
    val startSec: Double,
    val endSec: Double,
  )

  @Suppress("UNCHECKED_CAST")
  fun parseSubtitleItems(raw: HashMap<String, Any>): Pair<List<AlignmentSubtitleItem>, String> {
    val subtitles = raw["subtitles"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing subtitles")
    val timingMode = raw["timingMode"] as? String
      ?: throw IllegalStateException("native alignment: missing timingMode")

    val items = subtitles.map { item ->
      val start = (item["start"] as? Double) ?: 0.0
      val end = (item["end"] as? Double) ?: 0.0
      AlignmentSubtitleItem(
        text = item["text"] as? String ?: "",
        startSec = if (start.isFinite() && start >= 0.0) start else 0.0,
        endSec = if (end.isFinite() && end >= start) end else start.coerceAtLeast(0.0),
      )
    }.filter { it.text.isNotBlank() }

    return items to timingMode
  }

  @Suppress("UNCHECKED_CAST")
  fun parseSttSegments(raw: HashMap<String, Any>): Pair<List<SttAlignmentSegment>, String> {
    val (items, timingMode) = parseSubtitleItems(raw)
    val segments = items.map { item ->
      SttAlignmentSegment(
        text = item.text,
        startSec = item.startSec,
        endSec = item.endSec,
      )
    }

    return segments to timingMode
  }

  @Suppress("UNCHECKED_CAST")
  fun alignmentResultToWritable(raw: HashMap<String, Any>): WritableMap {
    val (items, timingMode) = parseSubtitleItems(raw)

    val out = Arguments.createMap()
    out.putArray("subtitles", alignmentItemsToWritableArray(items))
    out.putString("timingMode", timingMode)
    return out
  }

  private fun alignmentItemsToWritableArray(items: List<AlignmentSubtitleItem>): WritableArray {
    val array = Arguments.createArray()
    for (item in items) {
      val map: WritableMap = Arguments.createMap()
      map.putString("text", item.text)
      map.putDouble("start", item.startSec)
      map.putDouble("end", item.endSec)
      array.pushMap(map)
    }
    return array
  }
}
