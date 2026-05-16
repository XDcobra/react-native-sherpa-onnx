package com.sherpaonnx.punctuation.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.k2fsa.sherpa.onnx.OfflinePunctuation
import com.k2fsa.sherpa.onnx.OfflinePunctuationConfig
import com.k2fsa.sherpa.onnx.OfflinePunctuationModelConfig
import com.sherpaonnx.punctuation.core.PunctuationErrorCodes
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.text.pipeline.TextErrorCodes
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.concurrent.ConcurrentHashMap

class SherpaOnnxPunctuationHelper(
  private val nativeDetectPunctuationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?
) {
  companion object {
    private val offlineEngines = ConcurrentHashMap<String, OfflinePunctuation>()

    fun processOfflineIfExists(instanceId: String, text: String): String? {
      val engine = offlineEngines[instanceId] ?: return null
      val normalized =
        PunctuationTextInputNormalization.normalize(text, null)
      return engine.addPunctuation(normalized)
    }

    fun hasOfflineInstance(instanceId: String): Boolean {
      return offlineEngines.containsKey(instanceId)
    }
  }

  fun shutdown() {
    for (e in offlineEngines.values) {
      try {
        e.release()
      } catch (_: Exception) {
        // best-effort
      }
    }
    offlineEngines.clear()
  }

  fun detectPunctuationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectPunctuationModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject("PUNCT_DETECT_ERROR", "Punctuation model detection returned null")
        return
      }
      val map = Arguments.createMap()
      map.putBoolean("success", result["success"] as? Boolean ?: false)
      val error = result["error"] as? String
      if (!error.isNullOrBlank()) map.putString("error", error)
      val mt = result["modelType"] as? String
      if (!mt.isNullOrBlank()) map.putString("modelType", mt)
      map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
      val models = Arguments.createArray()
      @Suppress("UNCHECKED_CAST")
      val detected = result["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
      for (entry in detected) {
        val m = Arguments.createMap()
        m.putString("type", entry["type"] ?: "")
        m.putString("modelDir", entry["modelDir"] ?: "")
        models.pushMap(m)
      }
      map.putArray("detectedModels", models)
      val languages = result["languages"] as? ArrayList<*>
      if (!languages.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        for (entry in languages) {
          val value = entry as? String
          if (!value.isNullOrBlank()) arr.pushString(value)
        }
        map.putArray("languages", arr)
      }
      val q = result["quantization"] as? String
      if (!q.isNullOrBlank()) map.putString("quantization", q)
      val detSrc = result["detectionSources"] as? ArrayList<*>
      if (!detSrc.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        for (e in detSrc) {
          val s = e as? String
          if (!s.isNullOrBlank()) arr.pushString(s)
        }
        map.putArray("detectionSources", arr)
      }
      @Suppress("UNCHECKED_CAST")
      val paths = result["paths"] as? HashMap<*, *>
      if (paths != null) {
        val pm = Arguments.createMap()
        var any = false
        (paths["ct_transformer"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("ct_transformer", it)
          any = true
        }
        (paths["cnn_bilstm"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("cnn_bilstm", it)
          any = true
        }
        (paths["bpe_vocab"] as? String)?.takeIf { it.isNotEmpty() }?.let {
          pm.putString("bpe_vocab", it)
          any = true
        }
        if (any) {
          map.putMap("paths", pm)
        }
      }
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "Punctuation detection failed", e)
      promise.reject(
        "PUNCT_DETECT_ERROR",
        "Punctuation model detection failed: ${e.message}",
        e
      )
    }
  }

  fun initializeOfflinePunctuation(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "instanceId is required", null)
      return
    }
    if (modelDir.isBlank()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "modelDir is required", null)
      return
    }
    try {
      // Always resolve **offline CT** for this API (no native `auto` that prefers CNN).
      val detect = nativeDetectPunctuationModel(modelDir, null, "ct_transformer")
      if (detect == null) {
        promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation model detection returned null", null)
        return
      }
      val success = detect["success"] as? Boolean ?: false
      if (!success) {
        val reason = (detect["error"] as? String)?.trim()
        promise.reject(
          PunctuationErrorCodes.INIT_ERROR,
          if (reason.isNullOrEmpty()) "Punctuation: model is not a valid offline CT-Transformer layout for this directory" else reason
        )
        return
      }
      val resolvedType = (detect["modelType"] as? String)?.trim() ?: ""
      if (resolvedType != "ct_transformer") {
        promise.reject(
          PunctuationErrorCodes.INIT_ERROR,
          "Offline punctuation requires ct_transformer; native detect reported: $resolvedType"
        )
        return
      }
      @Suppress("UNCHECKED_CAST")
      val paths = detect["paths"] as? HashMap<*, *>
      val ctPath = (paths?.get("ct_transformer") as? String)?.trim() ?: ""
      if (ctPath.isEmpty()) {
        promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation: missing ct_transformer onnx path in detect result", null)
        return
      }
      // Optional: ensure requested modelType in options is compatible (v1: only auto / ct)
      val req = (modelType ?: "auto").lowercase()
      if (req != "auto" && req != "ct_transformer") {
        promise.reject(PunctuationErrorCodes.INIT_ERROR, "Unsupported modelType for offline engine: $modelType", null)
        return
      }

      val threads = (numThreads ?: 1.0).toInt().coerceAtLeast(1)
      val prov = provider?.trim().takeIf { !it.isNullOrEmpty() } ?: "cpu"
      val debugVal = debug ?: false
      val modelConfig = OfflinePunctuationModelConfig(
        ctTransformer = ctPath,
        numThreads = threads,
        debug = debugVal,
        provider = prov
      )
      val config = OfflinePunctuationConfig(model = modelConfig)
      val eng = OfflinePunctuation(assetManager = null, config = config)
      offlineEngines[instanceId]?.release()
      offlineEngines[instanceId] = eng

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putString("modelType", "ct_transformer")
      @Suppress("UNCHECKED_CAST")
      val dms = detect["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
      val arr = Arguments.createArray()
      for (m in dms) {
        val w = Arguments.createMap()
        w.putString("type", m["type"] ?: "")
        w.putString("modelDir", m["modelDir"] ?: "")
        arr.pushMap(w)
      }
      out.putArray("detectedModels", arr)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "initializeOfflinePunctuation", e)
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Failed to initialize offline punctuation: ${e.message}",
        e
      )
    }
  }

  private fun getEngine(instanceId: String): OfflinePunctuation? = offlineEngines[instanceId]

  fun getOfflineEngine(instanceId: String): OfflinePunctuation? = getEngine(instanceId)

  private fun readOfflineText(
    textInBufferId: String,
  ): Result<Pair<String, String>> {
    if (!textInBufferId.startsWith("txt_off_")) {
      return Result.failure(
        Exception(TextErrorCodes.BUFFER_KIND_MISMATCH)
      )
    }
    val inEntry = TextPipelineRegistry.getOffline(textInBufferId)
    if (inEntry == null) {
      return Result.failure(
        Exception(TextErrorCodes.BUFFER_NOT_FOUND)
      )
    }
    if (!inEntry.populated) {
      return Result.failure(
        Exception(TextErrorCodes.BUFFER_EMPTY)
      )
    }
    return Result.success(inEntry.text to inEntry.lang)
  }

  fun punctuateOfflineTextBuffers(
    instanceId: String,
    textInBufferId: String,
    textOutBufferId: String,
    textInputNormalization: String?,
    promise: Promise
  ) {
    val eng = getEngine(instanceId)
    if (eng == null) {
      promise.reject(
        PunctuationErrorCodes.NOT_FOUND,
        "Offline punctuation instance not found: $instanceId"
      )
      return
    }
    val read = readOfflineText(textInBufferId)
    if (read.isFailure) {
      val code = read.exceptionOrNull()?.message ?: PunctuationErrorCodes.PUNCTUATE_ERROR
      val msg = when (code) {
        TextErrorCodes.BUFFER_KIND_MISMATCH -> "Expected offline text buffer (txt_off_*), got: $textInBufferId"
        TextErrorCodes.BUFFER_NOT_FOUND -> "Offline text buffer not found: $textInBufferId"
        TextErrorCodes.BUFFER_EMPTY -> "Input offline text buffer is not populated: $textInBufferId"
        else -> "Failed to read input text buffer: $code"
      }
      promise.reject(code, msg, null)
      return
    }
    val (plainRaw, lang) = read.getOrThrow()
    val plain =
      PunctuationTextInputNormalization.normalize(plainRaw, textInputNormalization)
    if (!textOutBufferId.startsWith("txt_off_")) {
      promise.reject(
        TextErrorCodes.BUFFER_KIND_MISMATCH,
        "Expected offline text buffer (txt_off_*), got: $textOutBufferId"
      )
      return
    }
    val outEntry = TextPipelineRegistry.getOffline(textOutBufferId)
    if (outEntry == null) {
      promise.reject(
        TextErrorCodes.BUFFER_NOT_FOUND,
        "Offline text buffer not found: $textOutBufferId"
      )
      return
    }
    if (outEntry.populated) {
      promise.reject(
        TextErrorCodes.ALREADY_POPULATED,
        "Output offline text buffer is already populated: $textOutBufferId"
      )
      return
    }
    val t0 = SystemClock.elapsedRealtime()
    val outText: String
    try {
      outText = eng.addPunctuation(plain)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "punctuateOfflineTextBuffers", e)
      promise.reject(
        PunctuationErrorCodes.PUNCTUATE_ERROR,
        e.message ?: "Punctuation failed",
        e
      )
      return
    }
    val t1 = SystemClock.elapsedRealtime()
    val ms = (t1 - t0).toDouble()
    try {
      outEntry.populate(
        outText,
        emptyArray(),
        floatArrayOf(),
        floatArrayOf(),
        lang,
        "",
        ""
      )
    } catch (e: IllegalStateException) {
      promise.reject(TextErrorCodes.ALREADY_POPULATED, e.message, e)
      return
    }
    val m = Arguments.createMap()
    m.putDouble("processingTimeMs", ms)
    promise.resolve(m)
  }

  fun punctuateOfflineString(
    instanceId: String,
    plain: String,
    textOutBufferId: String,
    textInputNormalization: String?,
    promise: Promise
  ) {
    val eng = getEngine(instanceId)
    if (eng == null) {
      promise.reject(
        PunctuationErrorCodes.NOT_FOUND,
        "Offline punctuation instance not found: $instanceId"
      )
      return
    }
    if (!textOutBufferId.startsWith("txt_off_")) {
      promise.reject(
        TextErrorCodes.BUFFER_KIND_MISMATCH,
        "Expected offline text buffer (txt_off_*), got: $textOutBufferId"
      )
      return
    }
    val outEntry = TextPipelineRegistry.getOffline(textOutBufferId)
    if (outEntry == null) {
      promise.reject(
        TextErrorCodes.BUFFER_NOT_FOUND,
        "Offline text buffer not found: $textOutBufferId"
      )
      return
    }
    if (outEntry.populated) {
      promise.reject(
        TextErrorCodes.ALREADY_POPULATED,
        "Output offline text buffer is already populated: $textOutBufferId"
      )
      return
    }
    val normalizedPlain =
      PunctuationTextInputNormalization.normalize(plain, textInputNormalization)
    val t0 = SystemClock.elapsedRealtime()
    val outText: String
    try {
      outText = eng.addPunctuation(normalizedPlain)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "punctuateOfflineString", e)
      promise.reject(
        PunctuationErrorCodes.PUNCTUATE_ERROR,
        e.message ?: "Punctuation failed",
        e
      )
      return
    }
    val t1 = SystemClock.elapsedRealtime()
    val ms = (t1 - t0).toDouble()
    try {
      outEntry.populate(
        outText,
        emptyArray(),
        floatArrayOf(),
        floatArrayOf(),
        "",
        "",
        ""
      )
    } catch (e: IllegalStateException) {
      promise.reject(TextErrorCodes.ALREADY_POPULATED, e.message, e)
      return
    }
    val m = Arguments.createMap()
    m.putDouble("processingTimeMs", ms)
    promise.resolve(m)
  }

  fun unloadOfflinePunctuation(
    instanceId: String,
    promise: Promise
  ) {
    val eng = offlineEngines.remove(instanceId)
    if (eng != null) {
      try {
        eng.release()
      } catch (_: Exception) {
        // best-effort
      }
    }
    promise.resolve(null)
  }
}
