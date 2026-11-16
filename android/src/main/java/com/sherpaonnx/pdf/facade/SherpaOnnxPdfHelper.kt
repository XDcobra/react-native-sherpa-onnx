package com.sherpaonnx.pdf.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.bridge.JniWritables
import com.sherpaonnx.fileio.FileIOHelper
import com.sherpaonnx.fileio.SeekableOpenedSource
import com.sherpaonnx.pdf.PdfNative
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
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
    val password = readPassword(options)
    val layout =
      if (options != null && options.hasKey("layout") && !options.isNull("layout")) {
        options.getString("layout")
      } else {
        null
      }
    emitProgress(0, 1, "extract")
    // Text, spans and structure go straight into the native text buffer; only
    // a summary crosses JNI.
    val raw =
      try {
        PdfNative.nativeExtractTextLayer(
          opened.path,
          opened.fd,
          pages,
          password,
          layout,
          textOutBufferId,
        )
      } finally {
        opened.close()
      }
    if (raw["ok"] as? Boolean != true) {
      promise.reject(
        raw["errorCode"] as? String ?: ERR_INTERNAL,
        raw["errorMessage"] as? String ?: "PDF text-layer extract failed",
      )
      return
    }
    emitProgress(1, 1, "done")

    val result: WritableMap = Arguments.createMap()
    result.putInt("pageCount", (raw["pageCount"] as? Number)?.toInt() ?: 0)
    result.putInt("pagesWithText", (raw["pagesWithText"] as? Number)?.toInt() ?: 0)
    result.putInt("utf16Length", (raw["utf16Length"] as? Number)?.toInt() ?: 0)
    result.putInt("spatialSpanCount", (raw["spatialSpanCount"] as? Number)?.toInt() ?: 0)
    (raw["structure"] as? Map<*, *>)?.let { result.putMap("structure", JniWritables.map(it)) }
    Log.i(
      TAG,
      "extract ok pages=${raw["pageCount"]} withText=${raw["pagesWithText"]} " +
        "spans=${raw["spatialSpanCount"]} layout=${layout ?: "lines"}",
    )
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

    val password = readPassword(options)

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
          password,
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

  /** Empty string = omit. Never log the value. */
  private fun readPassword(options: ReadableMap?): String {
    if (options == null || !options.hasKey("password") || options.isNull("password")) {
      return ""
    }
    return options.getString("password").orEmpty()
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
