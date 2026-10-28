package com.sherpaonnx.pdf.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.fileio.FileIOHelper
import com.sherpaonnx.fileio.SeekableOpenedSource
import com.sherpaonnx.pdf.PdfNative
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import com.sherpaonnx.text.pipeline.TextSpatialSpan
import java.util.concurrent.Executors

class SherpaOnnxPdfHelper(
  private val reactContext: ReactApplicationContext,
) {
  private val executor = Executors.newSingleThreadExecutor()
  private val fileIO = FileIOHelper(reactContext)

  fun isPdfiumEnabled(promise: Promise) {
    try {
      promise.resolve(PdfNative.nativeIsPdfiumEnabled())
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  fun extractPdfTextLayer(
    source: ReadableMap,
    textOutBufferId: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        doExtract(source, textOutBufferId, options, promise)
      } catch (e: Exception) {
        Log.e(TAG, "extractPdfTextLayer failed", e)
        promise.reject(ERR_INTERNAL, e.message, e)
      }
    }
  }

  fun rasterizePdfPages(
    source: ReadableMap,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        doRasterize(source, options, promise)
      } catch (e: Exception) {
        Log.e(TAG, "rasterizePdfPages failed", e)
        promise.reject(ERR_INTERNAL, e.message, e)
      }
    }
  }

  private fun doExtract(
    source: ReadableMap,
    textOutBufferId: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    if (!PdfNative.nativeIsPdfiumEnabled()) {
      promise.reject(
        ERR_DISABLED,
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true " +
          "(Android gradle.properties) and ensure pdfium prebuilts resolve.",
      )
      return
    }

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
    val pages = readPages(options)
    emitProgress(0, 1, "extract")
    val raw =
      try {
        PdfNative.nativeExtractTextLayer(opened.path, opened.fd, pages)
      } finally {
        opened.close()
      }
    val ok = raw.getOrNull(0) as? Boolean ?: false
    val errorCode = raw.getOrNull(1) as? String
    val errorMessage = raw.getOrNull(2) as? String
    if (!ok) {
      promise.reject(
        errorCode ?: ERR_INTERNAL,
        errorMessage ?: "PDF text-layer extract failed",
      )
      return
    }
    emitProgress(1, 1, "done")

    val text = raw.getOrNull(3) as? String ?: ""
    val pageCount = (raw.getOrNull(4) as? Number)?.toInt() ?: 0
    val pagesWithText = (raw.getOrNull(5) as? Number)?.toInt() ?: 0
    @Suppress("UNCHECKED_CAST")
    val spanObjs = raw.getOrNull(6) as? Array<Any?> ?: emptyArray()
    val spans = spanObjs.mapNotNull { mapSpan(it) }

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

    Log.i(
      TAG,
      "extract ok pages=$pageCount withText=$pagesWithText spans=${spans.size} utf16=${text.length}",
    )

    val result: WritableMap = Arguments.createMap()
    result.putInt("pageCount", pageCount)
    result.putInt("pagesWithText", pagesWithText)
    result.putInt("utf16Length", text.length)
    result.putInt("spatialSpanCount", spans.size)
    promise.resolve(result)
  }

  private fun doRasterize(
    source: ReadableMap,
    options: ReadableMap?,
    promise: Promise,
  ) {
    if (!PdfNative.nativeIsPdfiumEnabled()) {
      promise.reject(
        ERR_DISABLED,
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true " +
          "(Android gradle.properties) and ensure pdfium prebuilts resolve.",
      )
      return
    }

    com.sherpaonnx.image.ImageBufferService.ensureInitialized(reactContext)

    val opened = openSeekable(source, promise) ?: return
    val pages = readPages(options)
    val dpi =
      if (options != null && options.hasKey("dpi") && !options.isNull("dpi")) {
        options.getDouble("dpi").toInt().coerceAtLeast(1)
      } else {
        144
      }
    val maxSide =
      if (options != null && options.hasKey("maxSide") && !options.isNull("maxSide")) {
        options.getDouble("maxSide").toInt()
      } else {
        4096
      }
    val strategy =
      if (options != null && options.hasKey("strategy") && !options.isNull("strategy")) {
        options.getString("strategy")
      } else {
        "rasterize-all"
      }
    val hotFrames =
      if (options != null && options.hasKey("hotFrames") && !options.isNull("hotFrames")) {
        options.getDouble("hotFrames").toInt()
      } else {
        0 // native default 8 for lazy-lru
      }

    emitProgress(0, 1, "raster")
    val raw =
      try {
        PdfNative.nativeRasterizePages(
          opened.path,
          opened.fd,
          pages,
          dpi,
          maxSide,
          strategy,
          hotFrames,
        )
      } finally {
        opened.close()
      }
    val ok = raw["ok"] as? Boolean ?: false
    if (!ok) {
      val code = raw["errorCode"] as? String ?: ERR_INTERNAL
      val msg = raw["errorMessage"] as? String ?: "PDF rasterize failed"
      promise.reject(code, msg)
      return
    }
    emitProgress(1, 1, "done")

    val bufferId = raw["bufferId"] as? String
    if (bufferId.isNullOrEmpty()) {
      promise.reject(ERR_INTERNAL, "rasterize returned no bufferId")
      return
    }

    Log.i(
      TAG,
      "rasterize ok bufferId=$bufferId strategy=$strategy frames=${raw["frameCount"]} " +
        "pageCount=${raw["pageCount"]} state=${raw["state"]}",
    )

    val result: WritableMap = Arguments.createMap()
    result.putString("bufferId", bufferId)
    result.putString("kind", raw["kind"] as? String ?: "offlineImageBuffer")
    result.putString("state", raw["state"] as? String ?: "immutable")
    result.putInt("frameCount", (raw["frameCount"] as? Number)?.toInt() ?: 0)
    result.putDouble("totalBytes", (raw["totalBytes"] as? Number)?.toDouble() ?: 0.0)
    result.putString("storageKind", raw["storageKind"] as? String ?: "ram")
    result.putInt("pageCount", (raw["pageCount"] as? Number)?.toInt() ?: 0)
    promise.resolve(result)
  }

  private fun openSeekable(source: ReadableMap, promise: Promise): SeekableOpenedSource? =
    fileIO.openSeekableSourceOrReject(source, promise, ERR_OPEN, TAG)

  private fun emitProgress(done: Int, total: Int, phase: String) {
    try {
      val map = Arguments.createMap()
      map.putInt("done", done)
      map.putInt("total", total)
      map.putString("phase", phase)
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("SherpaOnnxPdfProgress", map)
    } catch (e: Exception) {
      Log.w(TAG, "emitProgress failed: ${e.message}")
    }
  }

  private fun readPages(options: ReadableMap?): IntArray? {
    if (options == null || !options.hasKey("pages") || options.isNull("pages")) {
      return null
    }
    try {
      val arr: ReadableArray = options.getArray("pages") ?: return null
      if (arr.size() == 0) return null
      val out = IntArray(arr.size())
      for (i in 0 until arr.size()) {
        out[i] = arr.getDouble(i).toInt()
      }
      return out
    } catch (_: Exception) {
      return null
    }
  }

  private fun mapSpan(raw: Any?): TextSpatialSpan? {
    @Suppress("UNCHECKED_CAST")
    val one = raw as? Array<Any?> ?: return null
    val utf16Start = (one.getOrNull(0) as? Number)?.toInt() ?: 0
    val utf16End = (one.getOrNull(1) as? Number)?.toInt() ?: 0
    val level = one.getOrNull(2) as? String ?: "line"
    val pageNumber = (one.getOrNull(3) as? Number)?.toInt()
    val pageWidth = (one.getOrNull(4) as? Number)?.toFloat()
    val pageHeight = (one.getOrNull(5) as? Number)?.toFloat()
    val frameIndex = (one.getOrNull(6) as? Number)?.toInt() ?: 0
    val quadArr = one.getOrNull(7) as? FloatArray
    val quad = FloatArray(8)
    if (quadArr != null) {
      for (i in 0 until 8) {
        quad[i] = quadArr.getOrElse(i) { 0f }
      }
    }
    return TextSpatialSpan(
      utf16Start = utf16Start,
      utf16End = utf16End,
      level = level,
      sourceImageBufferId = "",
      frameIndex = frameIndex,
      quad = quad,
      confidence = null,
      origin = "textLayer",
      pageNumber = pageNumber,
      ptsMs = null,
      pageWidth = pageWidth,
      pageHeight = pageHeight,
    )
  }

  fun shutdown() {
    executor.shutdownNow()
  }

  companion object {
    private const val TAG = "SherpaOnnx:pdf"
    const val ERR_DISABLED = "ERR_PDF_PDFIUM_DISABLED"
    const val ERR_INVALID = "ERR_PDF_INVALID_ARGUMENT"
    const val ERR_OPEN = "ERR_PDF_OPEN_FAILED"
    const val ERR_INTERNAL = "ERR_PDF_INTERNAL"
  }
}
