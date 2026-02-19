package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult
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
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineDolphinModelConfig
import com.k2fsa.sherpa.onnx.OfflineFireRedAsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineCanaryModelConfig
import com.k2fsa.sherpa.onnx.OfflineOmnilingualAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineMedAsrCtcModelConfig
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

  @Volatile
  private var lastRecognizerConfig: OfflineRecognizerConfig? = null

  fun initializeStt(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    promise: Promise
  ) {
    try {
      CrashlyticsHelper.setContextAttributes(
        modelDir = modelDir,
        modelType = modelType,
        feature = "stt",
        preferInt8 = preferInt8
      )
      val modelDirFile = File(modelDir)
      if (!modelDirFile.exists()) {
        val errorMsg = "Model directory does not exist: $modelDir"
        Log.e(logTag, errorMsg)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      if (!modelDirFile.isDirectory) {
        val errorMsg = "Model path is not a directory: $modelDir"
        Log.e(logTag, errorMsg)
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
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
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
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
        CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, feature = "stt")
        return
      }

      val paths = result["paths"] as? Map<*, *> ?: emptyMap<String, String>()
      val pathStrings = paths.mapValues { (_, v) -> (v as? String).orEmpty() }.mapKeys { it.key.toString() }
      val modelTypeStr = result["modelType"] as? String ?: "unknown"

      recognizer?.release()
      recognizer = null
      val config = buildRecognizerConfig(
        pathStrings,
        modelTypeStr,
        hotwordsFile = hotwordsFile.orEmpty(),
        hotwordsScore = hotwordsScore?.toFloat() ?: 1.5f,
        numThreads = numThreads?.toInt(),
        provider = provider,
        ruleFsts = ruleFsts.orEmpty(),
        ruleFars = ruleFars.orEmpty(),
        dither = dither?.toFloat() ?: 0f
      )
      lastRecognizerConfig = config
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
      CrashlyticsHelper.rejectWithCrashlytics(promise, "INIT_ERROR", errorMsg, e, "stt")
    }
  }

  fun transcribeFile(filePath: String, promise: Promise) {
    try {
      val rec = recognizer
      if (rec == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val wave = WaveReader.readWave(filePath)
      val stream: OfflineStream = rec.createStream()
      stream.acceptWaveform(wave.samples, wave.sampleRate)
      rec.decode(stream)
      val result = rec.getResult(stream)
      promise.resolve(resultToWritableMap(result))
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe file"
      Log.e(logTag, "transcribeFile error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", message, e, "stt")
    }
  }

  fun transcribeSamples(samples: com.facebook.react.bridge.ReadableArray, sampleRate: Int, promise: Promise) {
    try {
      val rec = recognizer
      if (rec == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val floatSamples = FloatArray(samples.size()) { i -> samples.getDouble(i).toFloat() }
      val stream: OfflineStream = rec.createStream()
      try {
        stream.acceptWaveform(floatSamples, sampleRate)
        rec.decode(stream)
        val result = rec.getResult(stream)
        promise.resolve(resultToWritableMap(result))
      } finally {
        stream.release()
      }
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to transcribe samples"
      Log.e(logTag, "transcribeSamples error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "TRANSCRIBE_ERROR", message, e, "stt")
    }
  }

  fun setSttConfig(options: ReadableMap, promise: Promise) {
    try {
      val rec = recognizer
      val current = lastRecognizerConfig
      if (rec == null || current == null) {
        CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", "STT not initialized. Call initializeStt first.", feature = "stt")
        return
      }
      val merged = current.copy(
        decodingMethod = if (options.hasKey("decodingMethod")) options.getString("decodingMethod") ?: current.decodingMethod else current.decodingMethod,
        maxActivePaths = if (options.hasKey("maxActivePaths")) options.getDouble("maxActivePaths").toInt() else current.maxActivePaths,
        hotwordsFile = if (options.hasKey("hotwordsFile")) options.getString("hotwordsFile") ?: current.hotwordsFile else current.hotwordsFile,
        hotwordsScore = if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore").toFloat() else current.hotwordsScore,
        blankPenalty = if (options.hasKey("blankPenalty")) options.getDouble("blankPenalty").toFloat() else current.blankPenalty,
        ruleFsts = if (options.hasKey("ruleFsts")) options.getString("ruleFsts") ?: current.ruleFsts else current.ruleFsts,
        ruleFars = if (options.hasKey("ruleFars")) options.getString("ruleFars") ?: current.ruleFars else current.ruleFars
      )
      lastRecognizerConfig = merged
      rec.setConfig(merged)
      promise.resolve(null)
    } catch (e: Exception) {
      val message = e.message?.takeIf { it.isNotBlank() } ?: "Failed to set STT config"
      Log.e(logTag, "setSttConfig error: $message", e)
      CrashlyticsHelper.rejectWithCrashlytics(promise, "CONFIG_ERROR", message, e, "stt")
    }
  }

  private fun resultToWritableMap(result: OfflineRecognizerResult): WritableMap {
    val map = Arguments.createMap()
    map.putString("text", result.text)
    val tokensArray = Arguments.createArray()
    for (t in result.tokens) tokensArray.pushString(t)
    map.putArray("tokens", tokensArray)
    val timestampsArray = Arguments.createArray()
    for (t in result.timestamps) timestampsArray.pushDouble(t.toDouble())
    map.putArray("timestamps", timestampsArray)
    map.putString("lang", result.lang)
    map.putString("emotion", result.emotion)
    map.putString("event", result.event)
    val durationsArray = Arguments.createArray()
    for (d in result.durations) durationsArray.pushDouble(d.toDouble())
    map.putArray("durations", durationsArray)
    return map
  }

  fun unloadStt(promise: Promise) {
    try {
      recognizer?.release()
      recognizer = null
      lastRecognizerConfig = null
      promise.resolve(null)
    } catch (e: Exception) {
      CrashlyticsHelper.rejectWithCrashlytics(promise, "RELEASE_ERROR", "Failed to release resources", e, "stt")
    }
  }

  private fun path(paths: Map<String, String>, key: String): String =
    paths[key].orEmpty()

  private fun buildRecognizerConfig(
    paths: Map<String, String>,
    modelType: String,
    hotwordsFile: String = "",
    hotwordsScore: Float = 1.5f,
    numThreads: Int? = null,
    provider: String? = null,
    ruleFsts: String = "",
    ruleFars: String = "",
    dither: Float = 0f
  ): OfflineRecognizerConfig {
    val featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80, dither = dither)
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
      "fire_red_asr" -> OfflineModelConfig(
        fireRedAsr = OfflineFireRedAsrModelConfig(
          encoder = path(paths, "fireRedEncoder"),
          decoder = path(paths, "fireRedDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "fire_red_asr"
      )
      "moonshine" -> OfflineModelConfig(
        moonshine = OfflineMoonshineModelConfig(
          preprocessor = path(paths, "moonshinePreprocessor"),
          encoder = path(paths, "moonshineEncoder"),
          uncachedDecoder = path(paths, "moonshineUncachedDecoder"),
          cachedDecoder = path(paths, "moonshineCachedDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "moonshine"
      )
      "dolphin" -> OfflineModelConfig(
        dolphin = OfflineDolphinModelConfig(model = path(paths, "dolphinModel")),
        tokens = path(paths, "tokens"),
        modelType = "dolphin"
      )
      "canary" -> OfflineModelConfig(
        canary = OfflineCanaryModelConfig(
          encoder = path(paths, "canaryEncoder"),
          decoder = path(paths, "canaryDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "canary"
      )
      "omnilingual" -> OfflineModelConfig(
        omnilingual = OfflineOmnilingualAsrCtcModelConfig(model = path(paths, "omnilingualModel")),
        tokens = path(paths, "tokens"),
        modelType = "omnilingual"
      )
      "medasr" -> OfflineModelConfig(
        medasr = OfflineMedAsrCtcModelConfig(model = path(paths, "medasrModel")),
        tokens = path(paths, "tokens"),
        modelType = "medasr"
      )
      "telespeech_ctc" -> OfflineModelConfig(
        teleSpeech = path(paths, "telespeechCtcModel"),
        tokens = path(paths, "tokens"),
        modelType = "telespeech_ctc"
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
    val finalModelConfig = modelConfig.copy(
      numThreads = numThreads ?: 1,
      provider = provider ?: "cpu"
    )
    return OfflineRecognizerConfig(
      featConfig = featConfig,
      modelConfig = finalModelConfig,
      hotwordsFile = hotwordsFile,
      hotwordsScore = hotwordsScore,
      ruleFsts = ruleFsts,
      ruleFars = ruleFars
    )
  }
}
