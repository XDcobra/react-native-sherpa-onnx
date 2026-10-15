package com.sherpaonnx.ocr.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.SherpaOnnxModule
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.ocr.OcrNative
import com.sherpaonnx.ocr.core.OcrErrorCodes
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import com.sherpaonnx.text.pipeline.TextSpatialSpan
import java.util.concurrent.ConcurrentHashMap

class SherpaOnnxOcrHelper(
  private val emitProgress: (operationId: String, done: Int, total: Int, phase: String) -> Unit,
) {
  companion object {
    private const val TAG = "SherpaOnnx:ocr"

    /** Sentinel objects for NativeInstanceGate keys (C++ owns real engines). */
    private val instances = ConcurrentHashMap<String, Any>()
  }

  fun shutdown() {
    val ids = instances.keys.toList()
    instances.clear()
    for (id in ids) {
      try {
        OcrNative.nativeUnload(id)
      } catch (_: Exception) {
      }
    }
  }

  fun detectOcrModel(modelDir: String, modelType: String?, promise: Promise) {
    try {
      val raw = OcrNative.nativeDetect(modelDir, modelType)
        ?: run {
          promise.reject(OcrErrorCodes.DETECT_FAILED, "detectOcrModel returned null")
          return
        }
      promise.resolve(detectMapToWritable(raw))
    } catch (e: Exception) {
      Log.e(TAG, "detectOcrModel failed", e)
      promise.reject(OcrErrorCodes.DETECT_FAILED, e.message, e)
    }
  }

  fun initializeOcr(instanceId: String, options: ReadableMap, promise: Promise) {
    try {
      val modelDir = options.getString("modelDir")?.trim().orEmpty()
      if (modelDir.isEmpty()) {
        promise.reject(OcrErrorCodes.INVALID_ARGUMENT, "modelDir is required")
        return
      }
      val modelType = options.getString("modelType")?.trim().orEmpty().ifEmpty { "auto" }
      val numThreads =
        if (options.hasKey("numThreads")) options.getDouble("numThreads").toInt() else 4
      val provider =
        if (options.hasKey("provider") && !options.isNull("provider")) {
          options.getString("provider")
        } else {
          "cpu"
        }
      val maxSideLen =
        if (options.hasKey("maxSideLen")) options.getDouble("maxSideLen").toInt() else 960
      val useOrientationCls =
        if (options.hasKey("useOrientationCls")) options.getBoolean("useOrientationCls") else true

      val sentinel = Any()
      instances[instanceId] = sentinel
      try {
        OcrNative.nativeLoad(
          instanceId,
          modelDir,
          modelType,
          numThreads,
          provider,
          maxSideLen,
          useOrientationCls,
        )
      } catch (e: Exception) {
        instances.remove(instanceId)
        throw e
      }
      Log.i(TAG, "initialized instance=$instanceId type=$modelType dir=$modelDir")
      val out = Arguments.createMap()
      out.putString("instanceId", instanceId)
      out.putString("modelType", modelType)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(TAG, "initializeOcr failed", e)
      promise.reject(OcrErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  fun unloadOcr(instanceId: String, promise: Promise) {
    val sentinel = instances.remove(instanceId)
    if (sentinel == null) {
      promise.resolve(null)
      return
    }
    NativeInstanceGate.releaseWhenIdle(NativeInstanceGate.keyFor(sentinel)) {
      try {
        OcrNative.nativeUnload(instanceId)
      } catch (e: Exception) {
        Log.w(TAG, "unloadOcr native error: ${e.message}")
      }
    }
    promise.resolve(null)
  }

  fun cancelOcrRecognize(operationId: String, promise: Promise) {
    try {
      OcrNative.nativeCancelRecognize(operationId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(OcrErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  fun ocrRecognize(
    instanceId: String,
    imageBufferId: String,
    textOutBufferId: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    val sentinel = instances[instanceId]
    if (sentinel == null) {
      promise.reject(OcrErrorCodes.INSTANCE_NOT_FOUND, "OCR instance not found: $instanceId")
      return
    }
    val textEntry = TextPipelineRegistry.getOffline(textOutBufferId)
    if (textEntry == null) {
      promise.reject(
        OcrErrorCodes.INVALID_ARGUMENT,
        "Offline text buffer not found: $textOutBufferId",
      )
      return
    }
    if (textEntry.populated) {
      promise.reject(
        OcrErrorCodes.ALREADY_POPULATED,
        "Text buffer already populated: $textOutBufferId",
      )
      return
    }

    val operationId =
      options?.takeIf { it.hasKey("operationId") && !it.isNull("operationId") }
        ?.getString("operationId")
        ?.trim()
        .orEmpty()
    val granularity =
      options?.takeIf { it.hasKey("granularity") && !it.isNull("granularity") }
        ?.getString("granularity")
        ?: "line"
    val frameIndices = readFrameIndices(options)

    val gateKey = NativeInstanceGate.keyFor(sentinel)
    if (!NativeInstanceGate.beginUse(gateKey)) {
      promise.reject(OcrErrorCodes.BUSY, "OCR instance is busy or releasing")
      return
    }

    val prevListener = OcrNative.progressListener
    if (operationId.isNotEmpty()) {
      OcrNative.progressListener = { opId, done, total, phase ->
        if (opId == operationId) {
          emitProgress(opId, done, total, phase)
        }
      }
    }

    try {
      val raw =
        OcrNative.nativeRecognize(
          instanceId,
          imageBufferId,
          frameIndices,
          granularity,
          operationId.ifEmpty { null },
        )
          ?: run {
            promise.reject(OcrErrorCodes.RECOGNIZE_FAILED, "nativeRecognize returned null")
            return
          }

      val ok = raw["ok"] as? Boolean ?: false
      val cancelled = raw["cancelled"] as? Boolean ?: false
      if (cancelled) {
        promise.reject(OcrErrorCodes.CANCELLED, raw["errorMessage"] as? String ?: "cancelled")
        return
      }
      if (!ok) {
        val code = (raw["errorCode"] as? String)?.ifBlank { null } ?: OcrErrorCodes.RECOGNIZE_FAILED
        val msg = raw["errorMessage"] as? String ?: "recognize failed"
        promise.reject(code, msg)
        return
      }

      val text = raw["text"] as? String ?: ""
      @Suppress("UNCHECKED_CAST")
      val spanMaps = raw["spans"] as? ArrayList<HashMap<String, Any>> ?: arrayListOf()
      val spans = spanMaps.map { mapNativeSpan(it, imageBufferId) }

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
        promise.reject(OcrErrorCodes.ALREADY_POPULATED, e.message, e)
        return
      }

      Log.i(
        TAG,
        "recognize ok instance=$instanceId image=$imageBufferId spans=${spans.size} textLen=${text.length}",
      )
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "ocrRecognize failed", e)
      promise.reject(OcrErrorCodes.RECOGNIZE_FAILED, e.message, e)
    } finally {
      OcrNative.progressListener = prevListener
      NativeInstanceGate.endUse(gateKey)
    }
  }

  private fun readFrameIndices(options: ReadableMap?): IntArray? {
    if (options == null || !options.hasKey("frames") || options.isNull("frames")) return null
    val arr: ReadableArray = options.getArray("frames") ?: return null
    if (arr.size() == 0) return null
    val out = IntArray(arr.size())
    for (i in 0 until arr.size()) {
      out[i] = arr.getDouble(i).toInt()
    }
    return out
  }

  private fun mapNativeSpan(raw: HashMap<String, Any>, imageBufferId: String): TextSpatialSpan {
    val utf16Start = (raw["utf16Start"] as? Number)?.toInt() ?: 0
    val utf16End = (raw["utf16End"] as? Number)?.toInt() ?: 0
    val level = raw["level"] as? String ?: "line"
    val frameIndex = (raw["frameIndex"] as? Number)?.toInt() ?: 0
    val confidence = (raw["confidence"] as? Number)?.toFloat()
    @Suppress("UNCHECKED_CAST")
    val quadList = raw["quad"] as? ArrayList<Any> ?: arrayListOf()
    val quad = FloatArray(8)
    for (i in 0 until 8) {
      quad[i] = (quadList.getOrNull(i) as? Number)?.toFloat() ?: 0f
    }
    return TextSpatialSpan(
      utf16Start = utf16Start,
      utf16End = utf16End,
      level = level,
      sourceImageBufferId = imageBufferId,
      frameIndex = frameIndex,
      quad = quad,
      confidence = confidence,
      origin = "ocr",
    )
  }

  private fun detectMapToWritable(raw: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    val success = raw["success"] as? Boolean ?: (raw["ok"] as? Boolean ?: false)
    map.putBoolean("success", success)
    map.putBoolean("ok", success)
    val modelType = raw["modelType"] as? String
    if (!modelType.isNullOrBlank()) map.putString("modelType", modelType)
    val family = raw["family"] as? String
    if (!family.isNullOrBlank()) map.putString("family", family)
    map.putBoolean("hasDet", raw["hasDet"] as? Boolean ?: false)
    map.putBoolean("hasRec", raw["hasRec"] as? Boolean ?: false)
    map.putBoolean("hasCls", raw["hasCls"] as? Boolean ?: false)
    map.putBoolean("hasRecYml", raw["hasRecYml"] as? Boolean ?: false)
    val quantization = raw["quantization"] as? String
    if (!quantization.isNullOrBlank()) map.putString("quantization", quantization)
    val sizeTier = raw["sizeTier"] as? String
    if (!sizeTier.isNullOrBlank()) map.putString("sizeTier", sizeTier)
    val errCode = raw["errorCode"] as? String
    if (!errCode.isNullOrBlank()) map.putString("errorCode", errCode)
    val errMsg = raw["errorMessage"] as? String ?: raw["error"] as? String
    if (!errMsg.isNullOrBlank()) {
      map.putString("errorMessage", errMsg)
      map.putString("error", errMsg)
    }

    @Suppress("UNCHECKED_CAST")
    val pathsRaw = raw["paths"] as? HashMap<String, Any>
    val paths = Arguments.createMap()
    fun putPath(key: String, value: Any?) {
      val s = value as? String
      if (!s.isNullOrBlank()) paths.putString(key, s)
    }
    putPath("det", pathsRaw?.get("det") ?: raw["detPath"])
    putPath("rec", pathsRaw?.get("rec") ?: raw["recPath"])
    putPath("cls", pathsRaw?.get("cls") ?: raw["clsPath"])
    putPath("rec_dict", pathsRaw?.get("rec_dict") ?: raw["recDictPath"])
    if (paths.toHashMap().isNotEmpty()) {
      map.putMap("paths", paths)
    }

    @Suppress("UNCHECKED_CAST")
    val filesRaw = raw["files"] as? HashMap<String, Any>
    val files = Arguments.createMap()
    val detPath = (filesRaw?.get("det") as? String) ?: (pathsRaw?.get("det") as? String)
    val recPath = (filesRaw?.get("rec") as? String) ?: (pathsRaw?.get("rec") as? String)
    val clsPath = (filesRaw?.get("cls") as? String) ?: (pathsRaw?.get("cls") as? String)
    val dictPath =
      (filesRaw?.get("recInferenceYml") as? String)
        ?: (pathsRaw?.get("rec_dict") as? String)
    if (!detPath.isNullOrBlank()) files.putString("det", detPath)
    if (!recPath.isNullOrBlank()) files.putString("rec", recPath)
    if (!clsPath.isNullOrBlank()) files.putString("cls", clsPath)
    if (!dictPath.isNullOrBlank()) files.putString("recInferenceYml", dictPath)
    if (files.toHashMap().isNotEmpty()) {
      map.putMap("files", files)
    }

    val sourcesArr = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val sources = raw["detectionSources"] as? ArrayList<*>
    sources?.forEach { entry ->
      val s = entry as? String
      if (!s.isNullOrBlank()) sourcesArr.pushString(s)
    }
    if (sourcesArr.size() > 0) {
      map.putArray("detectionSources", sourcesArr)
    }

    val modelsArr = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val models = raw["detectedModels"] as? ArrayList<*>
    models?.forEach { entry ->
      @Suppress("UNCHECKED_CAST")
      val m = entry as? HashMap<String, Any> ?: return@forEach
      val row = Arguments.createMap()
      val type = m["type"] as? String
      val dir = m["modelDir"] as? String
      if (!type.isNullOrBlank()) row.putString("type", type)
      if (!dir.isNullOrBlank()) row.putString("modelDir", dir)
      modelsArr.pushMap(row)
    }
    map.putArray("detectedModels", modelsArr)

    SherpaOnnxModule.publicLanguageRowsToWritableArray(
      raw["languages"] as? ArrayList<*>
    )?.let { rows ->
      map.putArray("languages", rows)
    }

    return map
  }
}
