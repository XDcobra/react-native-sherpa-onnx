package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineNemoEncDecCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineZipformerCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineFunAsrNanoModelConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File

internal class SherpaOnnxSttHelper(
  private val detectSttModel: (
    modelDir: String,
    preferInt8: Boolean,
    hasPreferInt8: Boolean,
    modelType: String,
    debug: Boolean
  ) -> HashMap<String, Any>?,
  private val logTag: String
) {

  @Volatile
  private var recognizer: OfflineRecognizer? = null

  fun initializeSherpaOnnx(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(logTag, errorMsg)
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      val result = detectSttModel(
        modelDir,
        preferInt8 ?: false,
        preferInt8 != null,
        modelType ?: "auto",
        debug ?: false
      )

      if (result == null) {
        val errorMsg = "Failed to detect STT model. Check native logs for details."
        Log.e(logTag, "Detection returned null for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()

      if (!success) {
        val reason = result["error"] as? String
        val errorMsg = if (!reason.isNullOrBlank()) {
          "Failed to initialize sherpa-onnx: $reason"
        } else {
          "Failed to initialize sherpa-onnx. Check native logs for details."
        }
        Log.e(logTag, "Detection failed for modelDir: $modelDir")
        promise.reject("INIT_ERROR", errorMsg)
        return
      }

      val paths = result["paths"] as? Map<*, *> ?: emptyMap<String, String>()
      val pathStrings = paths.mapValues { (_, v) -> (v as? String).orEmpty() }.mapKeys { it.key.toString() }
      val modelTypeStr = result["modelType"] as? String ?: "unknown"

      recognizer?.release()
      recognizer = null
      val config = buildRecognizerConfig(pathStrings, modelTypeStr)
      recognizer = OfflineRecognizer(config = config)

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      val detectedModelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val modelResultMap = Arguments.createMap()
          modelResultMap.putString("type", modelMap["type"] as? String ?: "")
          modelResultMap.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          detectedModelsArray.pushMap(modelResultMap)
        }
      }
      resultMap.putArray("detectedModels", detectedModelsArray)
      promise.resolve(resultMap)
    } catch (e: Exception) {
      val errorMsg = "Exception during initialization: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMsg, e)
      promise.reject("INIT_ERROR", errorMsg, e)
    }
  }

  fun transcribeFile(filePath: String, promise: Promise) {
    try {
      val rec = recognizer
      if (rec == null) {
        promise.reject("TRANSCRIBE_ERROR", "STT not initialized. Call initializeSherpaOnnx first.")
        return
      }
      val wave = WaveReader.readWave(filePath)
      val stream: OfflineStream = rec.createStream()
      stream.acceptWaveform(wave.samples, wave.sampleRate)
      rec.decode(stream)
      val result = rec.getResult(stream)
      promise.resolve(result.text)
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe file"
      Log.e(logTag, "transcribeFile error: $message", e)
      promise.reject("TRANSCRIBE_ERROR", message, e)
    }
  }

  fun unloadSherpaOnnx(promise: Promise) {
    try {
      recognizer?.release()
      recognizer = null
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("RELEASE_ERROR", "Failed to release resources", e)
    }
  }

  private fun path(paths: Map<String, String>, key: String): String =
    paths[key].orEmpty()

  private fun buildRecognizerConfig(paths: Map<String, String>, modelType: String): OfflineRecognizerConfig {
    val featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80)
    val modelConfig = when (modelType) {
      "transducer", "nemo_transducer" -> OfflineModelConfig(
        transducer = OfflineTransducerModelConfig(
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          joiner = path(paths, "joiner")
        ),
        tokens = path(paths, "tokens"),
        modelType = modelType
      )
      "paraformer" -> OfflineModelConfig(
        paraformer = OfflineParaformerModelConfig(model = path(paths, "paraformerModel")),
        tokens = path(paths, "tokens"),
        modelType = "paraformer"
      )
      "nemo_ctc" -> OfflineModelConfig(
        nemo = OfflineNemoEncDecCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "nemo_ctc"
      )
      "wenet_ctc" -> OfflineModelConfig(
        wenetCtc = com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "wenet_ctc"
      )
      "sense_voice" -> OfflineModelConfig(
        senseVoice = OfflineSenseVoiceModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "sense_voice"
      )
      "zipformer_ctc", "ctc" -> OfflineModelConfig(
        zipformerCtc = OfflineZipformerCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = if (modelType == "ctc") "zipformer_ctc" else modelType
      )
      "whisper" -> OfflineModelConfig(
        whisper = OfflineWhisperModelConfig(
          encoder = path(paths, "whisperEncoder"),
          decoder = path(paths, "whisperDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "whisper"
      )
      "funasr_nano" -> OfflineModelConfig(
        funasrNano = OfflineFunAsrNanoModelConfig(
          encoderAdaptor = path(paths, "funasrEncoderAdaptor"),
          llm = path(paths, "funasrLLM"),
          embedding = path(paths, "funasrEmbedding"),
          tokenizer = path(paths, "funasrTokenizer")
        ),
        tokens = ""
      )
      else -> {
        val tokens = path(paths, "tokens")
        when {
          path(paths, "encoder").isNotEmpty() -> OfflineModelConfig(
            transducer = OfflineTransducerModelConfig(
              encoder = path(paths, "encoder"),
              decoder = path(paths, "decoder"),
              joiner = path(paths, "joiner")
            ),
            tokens = tokens,
            modelType = "transducer"
          )
          path(paths, "paraformerModel").isNotEmpty() -> OfflineModelConfig(
            paraformer = OfflineParaformerModelConfig(model = path(paths, "paraformerModel")),
            tokens = tokens,
            modelType = "paraformer"
          )
          path(paths, "ctcModel").isNotEmpty() -> OfflineModelConfig(
            zipformerCtc = OfflineZipformerCtcModelConfig(model = path(paths, "ctcModel")),
            tokens = tokens,
            modelType = modelType
          )
          else -> OfflineModelConfig(tokens = tokens, modelType = modelType)
        }
      }
    }
    return OfflineRecognizerConfig(featConfig = featConfig, modelConfig = modelConfig)
  }
}
