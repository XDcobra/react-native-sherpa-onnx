package com.sherpaonnx.segment.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * Utility to convert [JSONObject] and [JSONArray] recursively to React Native [WritableMap] and [WritableArray].
 *
 * Parity with iOS NSJSONSerialization -> NSDictionary/NSArray behavior for pipelineLiveSegmentAppended.
 */
object JsonToReactUtils {

    fun jsonObjectToWritableMap(jo: JSONObject): WritableMap {
        val map = Arguments.createMap()
        val keys = jo.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (jo.isNull(key)) {
                map.putNull(key)
                continue
            }
            when (val value = jo.get(key)) {
                is Boolean -> map.putBoolean(key, value)
                is Int -> map.putInt(key, value)
                is Long -> map.putDouble(key, value.toDouble())
                is Double -> map.putDouble(key, value)
                is String -> map.putString(key, value)
                is JSONObject -> map.putMap(key, jsonObjectToWritableMap(value))
                is JSONArray -> map.putArray(key, jsonArrayToWritableArray(value))
                // Fallback for types not explicitly handled
                else -> map.putString(key, value.toString())
            }
        }
        return map
    }

    fun jsonArrayToWritableArray(ja: JSONArray): WritableArray {
        val array = Arguments.createArray()
        for (i in 0 until ja.length()) {
            if (ja.isNull(i)) {
                array.pushNull()
                continue
            }
            when (val value = ja.get(i)) {
                is Boolean -> array.pushBoolean(value)
                is Int -> array.pushInt(value)
                is Long -> array.pushDouble(value.toDouble())
                is Double -> array.pushDouble(value)
                is String -> array.pushString(value)
                is JSONObject -> array.pushMap(jsonObjectToWritableMap(value))
                is JSONArray -> array.pushArray(jsonArrayToWritableArray(value))
                // Fallback for types not explicitly handled
                else -> array.pushString(value.toString())
            }
        }
        return array
    }
}
