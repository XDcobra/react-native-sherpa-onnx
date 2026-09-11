package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/**
 * Fabric-safe recursive packing of LiveText segment meta into WritableMap/Array.
 *
 * Soft limits (drop on exceed, never throw):
 * - max depth 4
 * - max array length 64
 * - max object keys per level 64
 */
object LiveTextJsonMeta {
  const val MAX_DEPTH = 4
  const val MAX_ARRAY_LENGTH = 64
  const val MAX_OBJECT_KEYS = 64

  fun packMetaMap(raw: Map<String, Any?>?, depth: Int = 1): WritableMap? {
    if (raw == null || raw.isEmpty()) return null
    val out = Arguments.createMap()
    var count = 0
    var wrote = false
    for ((key, value) in raw) {
      if (count >= MAX_OBJECT_KEYS) break
      if (putJsonValue(out, key, value, depth)) {
        wrote = true
      }
      count++
    }
    return if (wrote) out else null
  }

  fun putJsonValue(map: WritableMap, key: String, value: Any?, depth: Int = 1): Boolean {
    return when (val packed = packValue(value, depth)) {
      PackResult.Drop -> false
      PackResult.Null -> {
        map.putNull(key)
        true
      }
      is PackResult.Bool -> {
        map.putBoolean(key, packed.value)
        true
      }
      is PackResult.IntNum -> {
        map.putInt(key, packed.value)
        true
      }
      is PackResult.DoubleNum -> {
        map.putDouble(key, packed.value)
        true
      }
      is PackResult.Str -> {
        map.putString(key, packed.value)
        true
      }
      is PackResult.MapVal -> {
        map.putMap(key, packed.value)
        true
      }
      is PackResult.ArrVal -> {
        map.putArray(key, packed.value)
        true
      }
    }
  }

  fun putJsonValue(array: WritableArray, value: Any?, depth: Int = 1): Boolean {
    return when (val packed = packValue(value, depth)) {
      PackResult.Drop -> false
      PackResult.Null -> {
        array.pushNull()
        true
      }
      is PackResult.Bool -> {
        array.pushBoolean(packed.value)
        true
      }
      is PackResult.IntNum -> {
        array.pushInt(packed.value)
        true
      }
      is PackResult.DoubleNum -> {
        array.pushDouble(packed.value)
        true
      }
      is PackResult.Str -> {
        array.pushString(packed.value)
        true
      }
      is PackResult.MapVal -> {
        array.pushMap(packed.value)
        true
      }
      is PackResult.ArrVal -> {
        array.pushArray(packed.value)
        true
      }
    }
  }

  private sealed class PackResult {
    data object Drop : PackResult()
    data object Null : PackResult()
    data class Bool(val value: Boolean) : PackResult()
    data class IntNum(val value: Int) : PackResult()
    data class DoubleNum(val value: Double) : PackResult()
    data class Str(val value: String) : PackResult()
    data class MapVal(val value: WritableMap) : PackResult()
    data class ArrVal(val value: WritableArray) : PackResult()
  }

  private fun packValue(value: Any?, depth: Int): PackResult {
    if (depth > MAX_DEPTH) return PackResult.Drop
    return when (value) {
      null -> PackResult.Null
      is Boolean -> PackResult.Bool(value)
      is Int -> PackResult.IntNum(value)
      is Long -> PackResult.DoubleNum(value.toDouble())
      is Float -> PackResult.DoubleNum(value.toDouble())
      is Double -> if (value.isFinite()) PackResult.DoubleNum(value) else PackResult.Drop
      is Number -> {
        val d = value.toDouble()
        if (d.isFinite()) PackResult.DoubleNum(d) else PackResult.Drop
      }
      is String -> PackResult.Str(value)
      is Map<*, *> -> {
        if (depth >= MAX_DEPTH) return PackResult.Drop
        val out = Arguments.createMap()
        var count = 0
        var wrote = false
        for ((k, v) in value) {
          if (count >= MAX_OBJECT_KEYS) break
          val key = k as? String ?: continue
          if (putJsonValue(out, key, v, depth + 1)) {
            wrote = true
          }
          count++
        }
        if (wrote) PackResult.MapVal(out) else PackResult.Drop
      }
      is List<*> -> packList(value, depth)
      is Array<*> -> packList(value.asList(), depth)
      else -> PackResult.Drop
    }
  }

  private fun packList(list: List<*>, depth: Int): PackResult {
    if (depth >= MAX_DEPTH) return PackResult.Drop
    val out = Arguments.createArray()
    val limit = minOf(list.size, MAX_ARRAY_LENGTH)
    var wrote = false
    for (i in 0 until limit) {
      if (putJsonValue(out, list[i], depth + 1)) {
        wrote = true
      }
    }
    return if (wrote || list.isEmpty()) PackResult.ArrVal(out) else PackResult.Drop
  }
}
