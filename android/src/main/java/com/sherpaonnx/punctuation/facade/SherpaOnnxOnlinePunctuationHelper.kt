package com.sherpaonnx.punctuation.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.OnlinePunctuation
import com.k2fsa.sherpa.onnx.OnlinePunctuationConfig
import com.k2fsa.sherpa.onnx.OnlinePunctuationModelConfig
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
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
  ) -> HashMap<String, Any>?
) {
  companion object {
    private val onlineEngines = ConcurrentHashMap<String, OnlinePunctuation>()

    fun processOnlineIfExists(instanceId: String, text: String): String? {
      val engine = onlineEngines[instanceId] ?: return null
      val normalized =
        PunctuationTextInputNormalization.normalize(text, null)
      return engine.addPunctuation(normalized)
    }

    fun hasOnlineInstance(instanceId: String): Boolean {
      return onlineEngines.containsKey(instanceId)
    }
  }

  fun shutdown() {
    for (e in onlineEngines.values) {
      try {
        e.release()
      } catch (_: Exception) {
      }
    }
    onlineEngines.clear()
  }

  fun initializeOnlinePunctuation(
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
      val req = (modelType ?: "auto").lowercase()
      if (req != "auto" && req != "cnn_bilstm") {
        promise.reject(
          PunctuationErrorCodes.INIT_ERROR,
          "Streaming punctuation requires cnn_bilstm or auto; received $modelType",
          null
        )
        return
      }
      val detect = nativeDetectPunctuationModel(modelDir, null, "cnn_bilstm")
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
      if (cnn.isEmpty() || vocab.isEmpty()) {
        promise.reject(PunctuationErrorCodes.INIT_ERROR, "Punctuation: missing cnn_bilstm or bpe.vocab path", null)
        return
      }

      val config = OnlinePunctuationConfig(
        model = OnlinePunctuationModelConfig(
          cnnBilstm = cnn,
          bpeVocab = vocab,
          numThreads = (numThreads ?: 1.0).toInt().coerceAtLeast(1),
          debug = debug ?: false,
          provider = provider?.trim().takeIf { !it.isNullOrEmpty() } ?: "cpu",
        )
      )
      val eng = OnlinePunctuation(assetManager = null, config = config)
      onlineEngines[instanceId]?.release()
      onlineEngines[instanceId] = eng

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putString("modelType", "cnn_bilstm")
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
      Log.e("SherpaOnnxPunct", "initializeOnlinePunctuation", e)
      promise.reject(PunctuationErrorCodes.INIT_ERROR, "Failed to initialize online punctuation: ${e.message}", e)
    }
  }

  fun processOnlinePunctuationChunk(
    instanceId: String,
    text: String,
    textInputNormalization: String?,
    promise: Promise
  ) {
    val eng = onlineEngines[instanceId]
    if (eng == null) {
      promise.reject(PunctuationErrorCodes.NOT_FOUND, "Online punctuation instance not found: $instanceId")
      return
    }
    try {
      val t0 = SystemClock.elapsedRealtime()
      val normalized =
        PunctuationTextInputNormalization.normalize(text, textInputNormalization)
      val outText = eng.addPunctuation(normalized)
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
    val eng = onlineEngines[instanceId]
    if (eng == null) {
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
        engine = eng,
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
    onlineEngines.remove(instanceId)?.release()
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
