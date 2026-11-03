package com.sherpaonnx.punctuation.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.punctuation.config.PunctuationInitOptionsParser
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
    quantization: String?
  ) -> HashMap<String, Any>?
) {
  companion object {
    /** Kotlin-side bookkeeping that an offline instance id was initialized. */
    private val offlineInstanceIds = ConcurrentHashMap.newKeySet<String>()

    fun gateKey(instanceId: String): String = "punctOffline:$instanceId"

    fun processOfflineIfExists(instanceId: String, text: String): String? {
      if (!offlineInstanceIds.contains(instanceId) || !nativeHasOfflineInstance(instanceId)) {
        return null
      }
      val gateKey = gateKey(instanceId)
      if (!NativeInstanceGate.beginUse(gateKey)) return null
      return try {
        val normalized =
          PunctuationTextInputNormalization.normalize(text, null)
        addPunctuationOfflineOrThrow(instanceId, normalized)
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }
    }

    fun hasOfflineInstance(instanceId: String): Boolean {
      return offlineInstanceIds.contains(instanceId) && nativeHasOfflineInstance(instanceId)
    }

    internal fun addPunctuationOfflineOrThrow(instanceId: String, text: String): String {
      @Suppress("UNCHECKED_CAST")
      val raw = nativeAddPunctuationOffline(instanceId, text) as? HashMap<String, Any>
        ?: throw IllegalStateException("nativeAddPunctuationOffline returned null")
      val success = raw["success"] as? Boolean ?: false
      if (!success) {
        throw IllegalStateException(raw["error"] as? String ?: "Punctuation failed")
      }
      return raw["text"] as? String ?: ""
    }

    private fun releaseOfflineSafely(instanceId: String) {
      val gateKey = gateKey(instanceId)
      val inFlight = NativeInstanceGate.inFlight(gateKey)
      if (inFlight > 0) {
        Log.w(
          "SherpaOnnxPunct",
          "UNLOAD_DURING_COMPUTE offline instanceId=$instanceId inFlight=$inFlight",
        )
      }
      NativeInstanceGate.releaseWhenIdle(gateKey) {
        try {
          nativeUnloadOffline(instanceId)
        } catch (_: Exception) {
        }
      }
    }

    @JvmStatic
    private external fun nativeInitializeOffline(
      instanceId: String,
      ctPath: String,
      numThreads: Int,
      provider: String,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeAddPunctuationOffline(
      instanceId: String,
      text: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeHasOfflineInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnloadOffline(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAllOffline()
  }

  fun shutdown() {
    val ids = offlineInstanceIds.toList()
    offlineInstanceIds.clear()
    for (id in ids) {
      releaseOfflineSafely(id)
    }
    nativeShutdownAllOffline()
  }

  fun detectPunctuationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    quantization: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectPunctuationModel(modelDir, assetName, modelType ?: "auto", quantization)
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
    options: ReadableMap,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "instanceId is required", null)
      return
    }
    val parsed = PunctuationInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        },
        null
      )
      return
    }
    try {
      if (parsed.initMode == "custom") {
        initializeOfflinePunctuationCustom(instanceId, parsed, promise)
      } else {
        initializeOfflinePunctuationAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "initializeOfflinePunctuation", e)
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Failed to initialize offline punctuation: ${e.message}",
        e
      )
    }
  }

  private fun initializeOfflinePunctuationCustom(
    instanceId: String,
    parsed: PunctuationInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "custom init requires a concrete modelType",
        null
      )
      return
    }
    if (modelTypeStr != "ct_transformer") {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Unsupported modelType for offline engine: $modelTypeStr",
        null
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("punctuation", modelTypeStr, pathStrings)?.let { errorMsg ->
      promise.reject(PunctuationErrorCodes.INIT_ERROR, errorMsg, null)
      return
    }

    finishInitializeOfflineWithPaths(
      instanceId = instanceId,
      ctPath = pathStrings["ct_transformer"]?.trim().orEmpty(),
      parsed = parsed,
      detectedModels = arrayListOf(
        hashMapOf("type" to "ct_transformer", "modelDir" to "custom")
      ),
      promise = promise
    )
  }

  private fun initializeOfflinePunctuationAuto(
    instanceId: String,
    parsed: PunctuationInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelDir = parsed.modelDir?.trim().orEmpty()
    if (modelDir.isEmpty()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "modelDir is required", null)
      return
    }

    val detect = nativeDetectPunctuationModel(modelDir, null, "ct_transformer", parsed.quantization)
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
    val req = parsed.modelType.lowercase()
    if (req != "auto" && req != "ct_transformer") {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Unsupported modelType for offline engine: ${parsed.modelType}", null)
      return
    }

    @Suppress("UNCHECKED_CAST")
    val dms = detect["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
    finishInitializeOfflineWithPaths(
      instanceId = instanceId,
      ctPath = ctPath,
      parsed = parsed,
      detectedModels = dms,
      promise = promise
    )
  }

  private fun finishInitializeOfflineWithPaths(
    instanceId: String,
    ctPath: String,
    parsed: PunctuationInitOptionsParser.Parsed,
    detectedModels: ArrayList<HashMap<String, String>>,
    promise: Promise
  ) {
    if (ctPath.isEmpty()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation: missing ct_transformer onnx path", null)
      return
    }

    val threads = parsed.numThreads.toInt().coerceAtLeast(1)
    val prov = parsed.provider?.trim().takeIf { !it.isNullOrEmpty() } ?: "cpu"

    if (offlineInstanceIds.contains(instanceId)) {
      releaseOfflineSafely(instanceId)
      offlineInstanceIds.remove(instanceId)
    }

    @Suppress("UNCHECKED_CAST")
    val raw = nativeInitializeOffline(instanceId, ctPath, threads, prov, parsed.debug)
      as? HashMap<String, Any>
    val ok = raw?.get("success") as? Boolean ?: false
    if (!ok) {
      val err = raw?.get("error") as? String ?: "Failed to initialize offline punctuation"
      promise.reject(PunctuationErrorCodes.INIT_ERROR, err, null)
      return
    }
    offlineInstanceIds.add(instanceId)

    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putString("modelType", "ct_transformer")
    val arr = Arguments.createArray()
    for (m in detectedModels) {
      val w = Arguments.createMap()
      w.putString("type", m["type"] ?: "")
      w.putString("modelDir", m["modelDir"] ?: "")
      arr.pushMap(w)
    }
    out.putArray("detectedModels", arr)
    promise.resolve(out)
  }

  /** True when native offline instance exists (for live pipeline helpers). */
  fun hasOfflineEngine(instanceId: String): Boolean = hasOfflineInstance(instanceId)

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
    if (!hasOfflineInstance(instanceId)) {
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
    val gateKey = gateKey(instanceId)
    if (!NativeInstanceGate.beginUse(gateKey)) {
      promise.reject(
        PunctuationErrorCodes.NOT_FOUND,
        "Offline punctuation instance released: $instanceId"
      )
      return
    }
    val outText: String
    try {
      outText = addPunctuationOfflineOrThrow(instanceId, plain)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "punctuateOfflineTextBuffers", e)
      promise.reject(
        PunctuationErrorCodes.PUNCTUATE_ERROR,
        e.message ?: "Punctuation failed",
        e
      )
      return
    } finally {
      NativeInstanceGate.endUse(gateKey)
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
    if (!hasOfflineInstance(instanceId)) {
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
    val gateKey = gateKey(instanceId)
    if (!NativeInstanceGate.beginUse(gateKey)) {
      promise.reject(
        PunctuationErrorCodes.NOT_FOUND,
        "Offline punctuation instance released: $instanceId"
      )
      return
    }
    val outText: String
    try {
      outText = addPunctuationOfflineOrThrow(instanceId, normalizedPlain)
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "punctuateOfflineString", e)
      promise.reject(
        PunctuationErrorCodes.PUNCTUATE_ERROR,
        e.message ?: "Punctuation failed",
        e
      )
      return
    } finally {
      NativeInstanceGate.endUse(gateKey)
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
    offlineInstanceIds.remove(instanceId)
    releaseOfflineSafely(instanceId)
    promise.resolve(null)
  }
}
