package com.sherpaonnx.segment.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject

class OfflineSegmentEntry(
  val bufferId: String,
  private val sourceAudioBufferId: String? = null,
) {
  @Volatile
  private var populated = false
  private val lock = Any()
  private var segments: List<SegmentRecord> = emptyList()

  fun populate(records: List<SegmentRecord>) {
    synchronized(lock) {
      if (populated) {
        throw SegmentPipelineException(
          SegmentErrorCodes.INVALID_STATE,
          "Offline segment buffer already populated: $bufferId"
        )
      }
      segments = records.toList()
      populated = true
    }
  }

  fun snapshotSegments(start: Int = 0, maxCount: Int = Int.MAX_VALUE): List<SegmentRecord> {
    synchronized(lock) {
      if (start < 0 || maxCount < 0) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SLICE_INVALID,
          "Invalid segment slice range start=$start maxCount=$maxCount"
        )
      }
      if (start >= segments.size) return emptyList()
      val end = minOf(start + maxCount, segments.size)
      return segments.subList(start, end)
    }
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", "offlineSegmentBuffer")
    map.putString("state", "immutable")
    map.putInt("segmentCount", synchronized(lock) { segments.size })
    if (!sourceAudioBufferId.isNullOrEmpty()) {
      map.putString("sourceAudioBufferId", sourceAudioBufferId)
    }
    return map
  }

  companion object {
    fun toWritableArray(records: List<SegmentRecord>): WritableArray {
      val arr = Arguments.createArray()
      for (r in records) {
        val item = Arguments.createMap()
        item.putString("id", r.id)
        item.putString("kind", r.kind)
        item.putString("sourceAudioBufferId", r.sourceAudioBufferId)
        item.putInt("startSample", r.startSample)
        item.putInt("endSample", r.endSample)
        item.putInt("sampleRate", r.sampleRate)
        item.putInt("durationMs", r.durationMs)
        if (r.confidence != null) item.putDouble("confidence", r.confidence)
        if (!r.payloadJson.isNullOrEmpty()) {
          item.putMap("payload", jsonStringToWritableMap(r.payloadJson))
        }
        arr.pushMap(item)
      }
      return arr
    }

    fun segmentsToJson(records: List<SegmentRecord>): String {
      val root = JSONObject()
      val arr = JSONArray()
      for (r in records) {
        val obj = JSONObject()
        obj.put("id", r.id)
        obj.put("kind", r.kind)
        obj.put("sourceAudioBufferId", r.sourceAudioBufferId)
        obj.put("startSample", r.startSample)
        obj.put("endSample", r.endSample)
        obj.put("sampleRate", r.sampleRate)
        obj.put("durationMs", r.durationMs)
        if (r.confidence != null) obj.put("confidence", r.confidence)
        if (!r.payloadJson.isNullOrEmpty()) obj.put("payload", JSONObject(r.payloadJson))
        arr.put(obj)
      }
      root.put("segments", arr)
      return root.toString()
    }

    fun segmentsFromJson(json: String): List<SegmentRecord> {
      val root = JSONObject(json)
      val arr = root.optJSONArray("segments") ?: JSONArray()
      val out = ArrayList<SegmentRecord>(arr.length())
      for (i in 0 until arr.length()) {
        val obj = arr.getJSONObject(i)
        out.add(
          SegmentRecord(
            id = obj.optString("id"),
            kind = obj.optString("kind", "speech"),
            sourceAudioBufferId = obj.optString("sourceAudioBufferId"),
            startSample = obj.optInt("startSample"),
            endSample = obj.optInt("endSample"),
            sampleRate = obj.optInt("sampleRate"),
            durationMs = obj.optInt("durationMs"),
            confidence = if (obj.has("confidence")) obj.optDouble("confidence") else null,
            payloadJson = if (obj.has("payload")) obj.optJSONObject("payload")?.toString() else null,
          )
        )
      }
      return out
    }

    private fun jsonStringToWritableMap(json: String): WritableMap {
      val obj = JSONObject(json)
      val map = Arguments.createMap()
      val it = obj.keys()
      while (it.hasNext()) {
        val key = it.next()
        when (val value = obj.get(key)) {
          is String -> map.putString(key, value)
          is Boolean -> map.putBoolean(key, value)
          is Int -> map.putInt(key, value)
          is Long -> map.putDouble(key, value.toDouble())
          is Double -> map.putDouble(key, value)
          is JSONObject -> map.putMap(key, jsonStringToWritableMap(value.toString()))
          else -> map.putString(key, value.toString())
        }
      }
      return map
    }
  }
}
