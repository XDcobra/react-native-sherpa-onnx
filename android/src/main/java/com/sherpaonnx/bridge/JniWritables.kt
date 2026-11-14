package com.sherpaonnx.bridge

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/** Plain JNI maps / lists (String, Number, Boolean) → React writables. */
internal object JniWritables {
  fun map(raw: Map<*, *>): WritableMap {
    val out = Arguments.createMap()
    for ((k, v) in raw) {
      val key = k as? String ?: continue
      when (v) {
        is String -> out.putString(key, v)
        is Boolean -> out.putBoolean(key, v)
        is Int -> out.putInt(key, v)
        is Number -> out.putDouble(key, v.toDouble())
        is Map<*, *> -> out.putMap(key, map(v))
        is List<*> -> out.putArray(key, array(v))
      }
    }
    return out
  }

  fun array(raw: List<*>): WritableArray {
    val out = Arguments.createArray()
    for (v in raw) {
      when (v) {
        is String -> out.pushString(v)
        is Boolean -> out.pushBoolean(v)
        is Int -> out.pushInt(v)
        is Number -> out.pushDouble(v.toDouble())
        is Map<*, *> -> out.pushMap(map(v))
        is List<*> -> out.pushArray(array(v))
      }
    }
    return out
  }
}
