package com.sherpaonnx.punctuation.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.punctuation.config.PunctuationInitOptionsParser
import com.sherpaonnx.punctuation.core.PunctuationErrorCodes
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.punctuation.pipeline.PunctuationPipelineWorker
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.text.pipeline.TextErrorCodes
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class SherpaOnnxOnlinePunctuationHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectPunctuationModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
    quantization: String?
  ) -> HashMap<String, Any>?
) {
  companion object {
    private val onlineInstanceIds = ConcurrentHashMap.newKeySet<String>()

    fun gateKey(instanceId: String): String = "punctOnline:$instanceId"

    fun processOnlineIfExists(instanceId: String, text: String): String? {
      if (!onlineInstanceIds.contains(instanceId) || !nativeHasOnlineInstance(instanceId)) {
        return null
      }
      val gateKey = gateKey(instanceId)
      if (!NativeInstanceGate.beginUse(gateKey)) return null
      return try {
        val normalized =
          PunctuationTextInputNormalization.normalize(text, null)
        addPunctuationOnlineOrThrow(instanceId, normalized)
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }
    }

    fun hasOnlineInstance(instanceId: String): Boolean {
      return onlineInstanceIds.contains(instanceId) && nativeHasOnlineInstance(instanceId)
    }

    internal fun addPunctuationOnlineOrThrow(instanceId: String, text: String): String {
      @Suppress("UNCHECKED_CAST")
      val raw = nativeAddPunctuationOnline(instanceId, text) as? HashMap<String, Any>
        ?: throw IllegalStateException("nativeAddPunctuationOnline returned null")
      val success = raw["success"] as? Boolean ?: false
      if (!success) {
        throw IllegalStateException(raw["error"] as? String ?: "Punctuation failed")
      }
      return raw["text"] as? String ?: ""
    }

    private fun releaseOnlineSafely(instanceId: String) {
      val gateKey = gateKey(instanceId)
      NativeInstanceGate.releaseWhenIdle(gateKey) {
        try {
          nativeUnloadOnline(instanceId)
        } catch (_: Exception) {
        }
      }
    }

    @JvmStatic
    private external fun nativeInitializeOnline(
      instanceId: String,
      cnnPath: String,
      bpePath: String,
      numThreads: Int,
      provider: String,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeAddPunctuationOnline(
      instanceId: String,
      text: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeHasOnlineInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnloadOnline(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAllOnline()
  }

  fun shutdown() {
    val ids = onlineInstanceIds.toList()
    onlineInstanceIds.clear()
    for (id in ids) {
      releaseOnlineSafely(id)
    }
    nativeShutdownAllOnline()
  }

  fun initializeOnlinePunctuation(
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
        initializeOnlinePunctuationCustom(instanceId, parsed, promise)
      } else {
        initializeOnlinePunctuationAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxPunct", "initializeOnlinePunctuation", e)
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Failed to initialize online punctuation: ${e.message}", e)
    }
  }

  private fun initializeOnlinePunctuationCustom(
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
    if (modelTypeStr != "cnn_bilstm") {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Streaming punctuation requires cnn_bilstm; received $modelTypeStr",
        null
      )
      return
    }

    val pathStrings = parsed.modelPaths.orEmpty()
    ModelPathValidationNative.validate("punctuation", modelTypeStr, pathStrings)?.let { errorMsg ->
      promise.reject(PunctuationErrorCodes.INIT_ERROR, errorMsg, null)
      return
    }

    finishInitializeOnlineWithPaths(
      instanceId = instanceId,
      cnn = pathStrings["cnn_bilstm"]?.trim().orEmpty(),
      vocab = pathStrings["bpe_vocab"]?.trim().orEmpty(),
      parsed = parsed,
      detectedModels = arrayListOf(
        hashMapOf("type" to "cnn_bilstm", "modelDir" to "custom")
      ),
      promise = promise
    )
  }

  private fun initializeOnlinePunctuationAuto(
    instanceId: String,
    parsed: PunctuationInitOptionsParser.Parsed,
    promise: Promise
  ) {
    val modelDir = parsed.modelDir?.trim().orEmpty()
    if (modelDir.isEmpty()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "modelDir is required", null)
      return
    }

    val req = parsed.modelType.lowercase()
    if (req != "auto" && req != "cnn_bilstm") {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Streaming punctuation requires cnn_bilstm or auto; received ${parsed.modelType}",
        null
      )
      return
    }
    val detect = nativeDetectPunctuationModel(modelDir, null, "cnn_bilstm", parsed.quantization)
    if (detect == null) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation model detection returned null", null)
      return
    }
    val success = detect["success"] as? Boolean ?: false
    if (!success) {
      val reason = (detect["error"] as? String)?.trim()
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        if (reason.isNullOrEmpty()) "Punctuation: model is not a valid online CNN-BiLSTM layout" else reason,
        null
      )
      return
    }
    val resolvedType = (detect["modelType"] as? String)?.trim() ?: ""
    val isStreaming = detect["isStreaming"] as? Boolean ?: false
    if (resolvedType != "cnn_bilstm" || !isStreaming) {
      promise.reject(
        PunctuationErrorCodes.INIT_ERROR,
        "Streaming punctuation requires online cnn_bilstm; native detect reported modelType=$resolvedType isStreaming=$isStreaming",
        null
      )
      return
    }
    @Suppress("UNCHECKED_CAST")
    val paths = detect["paths"] as? HashMap<*, *>
    val cnn = (paths?.get("cnn_bilstm") as? String)?.trim() ?: ""
    val vocab = (paths?.get("bpe_vocab") as? String)?.trim() ?: ""

    @Suppress("UNCHECKED_CAST")
    val dms = detect["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
    finishInitializeOnlineWithPaths(
      instanceId = instanceId,
      cnn = cnn,
      vocab = vocab,
      parsed = parsed,
      detectedModels = dms,
      promise = promise
    )
  }

  private fun finishInitializeOnlineWithPaths(
    instanceId: String,
    cnn: String,
    vocab: String,
    parsed: PunctuationInitOptionsParser.Parsed,
    detectedModels: ArrayList<HashMap<String, String>>,
    promise: Promise
  ) {
    if (cnn.isEmpty() || vocab.isEmpty()) {
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation: missing cnn_bilstm or bpe.vocab path", null)
      return
    }

    val threads = parsed.numThreads.toInt().coerceAtLeast(1)
    val prov = parsed.provider?.trim().takeIf { !it.isNullOrEmpty() } ?: "cpu"

    if (onlineInstanceIds.contains(instanceId)) {
      releaseOnlineSafely(instanceId)
      onlineInstanceIds.remove(instanceId)
    }

    @Suppress("UNCHECKED_CAST")
    val raw = nativeInitializeOnline(instanceId, cnn, vocab, threads, prov, parsed.debug)
      as? HashMap<String, Any>
    val ok = raw?.get("success") as? Boolean ?: false
    if (!ok) {
      val err = raw?.get("error") as? String ?: "Failed to initialize online punctuation"
      promise.reject(PunctuationErrorCodes.INIT_ERROR, err, null)
      return
    }
    onlineInstanceIds.add(instanceId)

    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putString("modelType", "cnn_bilstm")
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

  fun processOnlinePunctuationChunk(
    instanceId: String,
    text: String,
    textInputNormalization: String?,
    promise: Promise
  ) {
    if (!hasOnlineInstance(instanceId)) {
      promise.reject(PunctuationErrorCodes.NOT_FOUND, "Online punctuation instance not found: $instanceId")
      return
    }
    try {
      val t0 = SystemClock.elapsedRealtime()
      val normalized =
        PunctuationTextInputNormalization.normalize(text, textInputNormalization)
      val gateKey = gateKey(instanceId)
      if (!NativeInstanceGate.beginUse(gateKey)) {
        promise.reject(PunctuationErrorCodes.NOT_FOUND, "Online punctuation instance released: $instanceId")
        return
      }
      val outText = try {
        addPunctuationOnlineOrThrow(instanceId, normalized)
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }
      val t1 = SystemClock.elapsedRealtime()
      val out = Arguments.createMap()
      out.putString("punctuatedText", outText)
      out.putDouble("processingTimeMs", (t1 - t0).toDouble())
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(PunctuationErrorCodes.PUNCTUATE_ERROR, e.message ?: "Punctuation failed", e)
    }
  }

  fun startStreamingPunctuationPipeline(
    instanceId: String,
    inputBufferId: String,
    outputBufferId: String,
    textInputNormalization: String?,
    promise: Promise
  ) {
    if (!hasOnlineInstance(instanceId)) {
      promise.reject(PunctuationErrorCodes.NOT_FOUND, "Online punctuation instance not found: $instanceId")
      return
    }
    val input = TextPipelineRegistry.getLive(inputBufferId)
    if (input == null) {
      promise.reject(TextErrorCodes.BUFFER_KIND_MISMATCH, "Streaming punctuation input must be a live text buffer: $inputBufferId")
      return
    }
    val output = TextPipelineRegistry.getLive(outputBufferId)
    if (output == null) {
      promise.reject(TextErrorCodes.BUFFER_KIND_MISMATCH, "Streaming punctuation output must be a live text buffer: $outputBufferId")
      return
    }
    if (input.state != LiveTextEntry.State.RECORDING || output.state != LiveTextEntry.State.RECORDING) {
      promise.reject(TextErrorCodes.INVALID_STATE, "Streaming punctuation buffers must be recording live text buffers")
      return
    }

    try {
      val worker = PunctuationPipelineWorker(
        pipelineId = "punct_pipeline_${UUID.randomUUID()}",
        instanceId = instanceId,
        inputEntry = input,
        outputEntry = output,
        textInputNormalization =
          PunctuationTextInputNormalization.resolve(textInputNormalization),
      )
      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) {
        completion -> emitPipelineCompletedEvent(completion)
      }
      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(PunctuationErrorCodes.PIPELINE_ERROR, "Failed to start punctuation pipeline: ${e.message}", e)
    }
  }

  fun unloadOnlinePunctuation(instanceId: String, promise: Promise) {
    onlineInstanceIds.remove(instanceId)
    releaseOnlineSafely(instanceId)
    promise.resolve(null)
  }

  private fun emitPipelineCompletedEvent(completion: StreamingPipelineCompletion) {
    try {
      val payload = Arguments.createMap().apply {
        putString("pipelineId", completion.pipelineId)
        putString("reason", completion.reason)
        putDouble("chunksProcessed", completion.chunksProcessed.toDouble())
        putDouble("unitsRead", completion.unitsRead.toDouble())
        putDouble("unitsWritten", completion.unitsWritten.toDouble())
        if (completion.error != null) putString("error", completion.error) else putNull("error")
      }
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("streamingPipelineCompleted", payload)
    } catch (_: Exception) {
    }
  }
}
