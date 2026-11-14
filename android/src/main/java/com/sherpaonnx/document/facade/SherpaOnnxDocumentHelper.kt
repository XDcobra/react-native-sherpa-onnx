package com.sherpaonnx.document.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.document.DocumentNative
import com.sherpaonnx.document.NativeDocProgress
import com.sherpaonnx.fileio.FileIOHelper
import com.sherpaonnx.fileio.SeekableOpenedSource
import com.sherpaonnx.image.ImageBufferService
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.concurrent.Executors

class SherpaOnnxDocumentHelper(
  private val reactContext: ReactApplicationContext,
) {
  private val executor = Executors.newSingleThreadExecutor()
  private val fileIO = FileIOHelper(reactContext)

  fun extractDocumentText(
    source: ReadableMap,
    textOutBufferId: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        doExtractText(source, textOutBufferId, promise)
      } catch (e: Exception) {
        Log.e(TAG, "extractDocumentText failed", e)
        promise.reject(ERR_OPEN, e.message, e)
      }
    }
  }

  fun extractDocumentImages(
    source: ReadableMap,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        doExtractImages(source, options, promise)
      } catch (e: Exception) {
        Log.e(TAG, "extractDocumentImages failed", e)
        promise.reject(ERR_OPEN, e.message, e)
      }
    }
  }

  fun shutdown() {
    executor.shutdownNow()
  }

  private fun doExtractText(
    source: ReadableMap,
    textOutBufferId: String,
    promise: Promise,
  ) {
    val textEntry =
      TextPipelineRegistry.getOffline(textOutBufferId)
        ?: run {
          promise.reject(ERR_INVALID, "unknown textOut buffer: $textOutBufferId")
          return
        }
    if (textEntry.populated) {
      promise.reject(ERR_INVALID, "textOut buffer already populated: $textOutBufferId")
      return
    }

    val opened = openSeekable(source, promise) ?: return
    val progress = NativeDocProgress { done, total, phase ->
      emitProgress(done, total, phase)
    }
    val raw =
      try {
        DocumentNative.nativeExtractTextInto(opened.path, opened.fd, textOutBufferId, progress)
      } finally {
        opened.close()
      }
    val ok = raw["ok"] as? Boolean ?: false
    if (!ok) {
      val code = raw["errorCode"] as? String ?: ERR_OPEN
      val msg = raw["errorMessage"] as? String ?: "extractDocumentText failed"
      promise.reject(code, "$code: $msg")
      return
    }

    emitProgress(1, 1, "done")
    val result = Arguments.createMap()
    result.putString("format", raw["format"] as? String ?: "")
    result.putInt("sectionCount", (raw["sectionCount"] as? Number)?.toInt() ?: 0)
    result.putInt("spatialSpanCount", (raw["spatialSpanCount"] as? Number)?.toInt() ?: 0)
    result.putArray("sections", sectionArray(raw["sections"]))
    result.putArray("imageOnlySections", sectionArray(raw["imageOnlySections"]))
    (raw["structure"] as? Map<*, *>)?.let { result.putMap("structure", toWritableMap(it)) }
    promise.resolve(result)
  }

  /** Plain JNI maps / lists (String, Number, Boolean) → React writables. */
  private fun toWritableMap(raw: Map<*, *>): WritableMap {
    val out = Arguments.createMap()
    for ((k, v) in raw) {
      val key = k as? String ?: continue
      when (v) {
        is String -> out.putString(key, v)
        is Boolean -> out.putBoolean(key, v)
        is Int -> out.putInt(key, v)
        is Number -> out.putDouble(key, v.toDouble())
        is Map<*, *> -> out.putMap(key, toWritableMap(v))
        is List<*> -> out.putArray(key, toWritableArray(v))
      }
    }
    return out
  }

  private fun toWritableArray(raw: List<*>): WritableArray {
    val out = Arguments.createArray()
    for (v in raw) {
      when (v) {
        is String -> out.pushString(v)
        is Boolean -> out.pushBoolean(v)
        is Int -> out.pushInt(v)
        is Number -> out.pushDouble(v.toDouble())
        is Map<*, *> -> out.pushMap(toWritableMap(v))
        is List<*> -> out.pushArray(toWritableArray(v))
      }
    }
    return out
  }

  private fun doExtractImages(
    source: ReadableMap,
    options: ReadableMap?,
    promise: Promise,
  ) {
    ImageBufferService.ensureInitialized(reactContext)
    val maxSide = if (options != null && options.hasKey("maxSide") && !options.isNull("maxSide")) {
      options.getDouble("maxSide").toInt()
    } else {
      4096
    }
    val allImages =
      options != null && options.hasKey("scope") && !options.isNull("scope") &&
        options.getString("scope") == "all"
    val opened = openSeekable(source, promise) ?: return
    val progress = NativeDocProgress { done, total, phase ->
      emitProgress(done, total, phase)
    }
    val raw =
      try {
        DocumentNative.nativeExtractImages(opened.path, opened.fd, maxSide, allImages, progress)
      } finally {
        opened.close()
      }
    val ok = raw["ok"] as? Boolean ?: false
    if (!ok) {
      val code = raw["errorCode"] as? String ?: ERR_OPEN
      val msg = raw["errorMessage"] as? String ?: "extractDocumentImages failed"
      promise.reject(code, "$code: $msg")
      return
    }
    emitProgress(1, 1, "done")
    val result = Arguments.createMap()
    result.putString("bufferId", raw["bufferId"] as? String ?: "")
    result.putString("format", raw["format"] as? String ?: "")
    result.putInt("frameCount", (raw["frameCount"] as? Number)?.toInt() ?: 0)
    promise.resolve(result)
  }

  private fun openSeekable(source: ReadableMap, promise: Promise): SeekableOpenedSource? =
    fileIO.openSeekableSourceOrReject(source, promise, ERR_OPEN, TAG)

  private fun sectionArray(raw: Any?): WritableArray {
    val arr = Arguments.createArray()
    val list = raw as? List<*> ?: return arr
    for (item in list) {
      val m = item as? Map<*, *> ?: continue
      val wm = Arguments.createMap()
      wm.putInt("sectionIndex", (m["sectionIndex"] as? Number)?.toInt() ?: 0)
      val href = m["href"] as? String
      if (!href.isNullOrEmpty()) wm.putString("href", href)
      wm.putString("kind", m["kind"] as? String ?: "text")
      arr.pushMap(wm)
    }
    return arr
  }

  private fun emitProgress(done: Int, total: Int, phase: String) {
    try {
      val map: WritableMap = Arguments.createMap()
      map.putInt("done", done)
      map.putInt("total", total)
      map.putString("phase", phase)
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("SherpaOnnxDocProgress", map)
    } catch (e: Exception) {
      Log.w(TAG, "emitProgress failed: ${e.message}")
    }
  }

  companion object {
    private const val TAG = "SherpaOnnx:doc"
    const val ERR_INVALID = "ERR_DOC_INVALID_ARGUMENT"
    const val ERR_OPEN = "ERR_DOC_OPEN_FAILED"
  }
}
