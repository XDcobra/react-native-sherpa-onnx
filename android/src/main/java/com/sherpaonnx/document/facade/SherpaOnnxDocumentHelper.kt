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
import com.sherpaonnx.text.pipeline.TextSpatialSpan
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
        DocumentNative.nativeExtractText(opened.path, opened.fd, progress)
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

    val text = raw["text"] as? String ?: ""
    val spanMaps = raw["spans"] as? List<*> ?: emptyList<Any>()
    val spans = spanMaps.mapNotNull { item ->
      (item as? Map<*, *>)?.let { mapSpan(it) }
    }
    try {
      textEntry.populate(
        text = text,
        tokens = emptyArray(),
        timestamps = floatArrayOf(),
        durations = floatArrayOf(),
        lang = "",
        emotion = "",
        event = "",
        spatialSpans = spans,
      )
    } catch (e: IllegalStateException) {
      promise.reject(ERR_INVALID, e.message, e)
      return
    }

    emitProgress(1, 1, "done")
    val result = Arguments.createMap()
    result.putString("format", raw["format"] as? String ?: "")
    result.putInt("sectionCount", (raw["sectionCount"] as? Number)?.toInt() ?: 0)
    result.putInt("spatialSpanCount", spans.size)
    result.putArray("sections", sectionArray(raw["sections"]))
    result.putArray("imageOnlySections", sectionArray(raw["imageOnlySections"]))
    promise.resolve(result)
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
    val opened = openSeekable(source, promise) ?: return
    val progress = NativeDocProgress { done, total, phase ->
      emitProgress(done, total, phase)
    }
    val raw =
      try {
        DocumentNative.nativeExtractImages(opened.path, opened.fd, maxSide, progress)
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

  private fun mapSpan(raw: Map<*, *>): TextSpatialSpan? {
    val start = (raw["utf16Start"] as? Number)?.toInt() ?: return null
    val end = (raw["utf16End"] as? Number)?.toInt() ?: start
    val href = raw["href"] as? String
    val sectionIndex = (raw["sectionIndex"] as? Number)?.toInt()
    return TextSpatialSpan(
      utf16Start = start,
      utf16End = end,
      level = raw["level"] as? String ?: "block",
      sourceImageBufferId = "",
      frameIndex = 0,
      quad = FloatArray(8),
      confidence = null,
      origin = "markup",
      pageNumber = null,
      ptsMs = null,
      pageWidth = null,
      pageHeight = null,
      sectionIndex = sectionIndex,
      href = href?.takeIf { it.isNotEmpty() },
    )
  }

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
