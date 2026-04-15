package com.sherpaonnx.alignment.core

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.util.ArrayList
import java.util.HashMap

internal object AlignmentResultMapper {
  @Suppress("UNCHECKED_CAST")
  fun parseSttSegments(raw: HashMap<String, Any>): Pair<List<SttAlignmentSegment>, String> {
    val subtitles = raw["subtitles"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing subtitles")
    val timingMode = raw["timingMode"] as? String
      ?: throw IllegalStateException("native alignment: missing timingMode")

    val segments = subtitles.map { item ->
      SttAlignmentSegment(
        text = item["text"] as? String ?: "",
        startSec = (item["start"] as? Double) ?: 0.0,
        endSec = (item["end"] as? Double) ?: 0.0,
      )
    }

    return segments to timingMode
  }

  @Suppress("UNCHECKED_CAST")
  fun alignmentResultToWritable(raw: HashMap<String, Any>): WritableMap {
    val subtitles = raw["subtitles"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing subtitles")
    val timingMode = raw["timingMode"] as? String
      ?: throw IllegalStateException("native alignment: missing timingMode")

    val out = Arguments.createMap()
    out.putArray("subtitles", alignmentItemsToWritableArray(subtitles))
    out.putString("timingMode", timingMode)
    return out
  }

  private fun alignmentItemsToWritableArray(items: ArrayList<HashMap<String, Any>>): WritableArray {
    val array = Arguments.createArray()
    for (item in items) {
      val map: WritableMap = Arguments.createMap()
      map.putString("text", item["text"] as? String ?: "")
      val start = item["start"] as? Double
      val end = item["end"] as? Double
      if (start != null) {
        map.putDouble("start", start)
      }
      if (end != null) {
        map.putDouble("end", end)
      }
      array.pushMap(map)
    }
    return array
  }
}
