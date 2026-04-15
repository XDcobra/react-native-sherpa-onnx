package com.sherpaonnx.stt.core

import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineCanaryModelConfig
import com.k2fsa.sherpa.onnx.OfflineCohereTranscribeModelConfig
import com.k2fsa.sherpa.onnx.OfflineDolphinModelConfig
import com.k2fsa.sherpa.onnx.OfflineFireRedAsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineFunAsrNanoModelConfig
import com.k2fsa.sherpa.onnx.OfflineMedAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineNemoEncDecCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineOmnilingualAsrCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OfflineWenetCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OfflineZipformerCtcModelConfig

internal class OfflineSttRecognizerConfigFactory {

  fun buildRecognizerConfig(
    paths: Map<String, String>,
    modelType: String,
    hotwordsFile: String = "",
    hotwordsScore: Float = 1.5f,
    numThreads: Int? = null,
    provider: String? = null,
    ruleFsts: String = "",
    ruleFars: String = "",
    dither: Float = 0f,
    modelOptions: ReadableMap? = null,
    modelingUnit: String = "",
    bpeVocab: String = ""
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
        wenetCtc = OfflineWenetCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = "wenet_ctc"
      )
      "sense_voice" -> {
        val sv = modelOptions?.getMap("senseVoice")
        OfflineModelConfig(
          senseVoice = OfflineSenseVoiceModelConfig(
            model = path(paths, "ctcModel"),
            language = sv?.getString("language") ?: "",
            useInverseTextNormalization = if (sv?.hasKey("useItn") == true) sv.getBoolean("useItn") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "sense_voice"
        )
      }
      "zipformer_ctc", "ctc" -> OfflineModelConfig(
        zipformerCtc = OfflineZipformerCtcModelConfig(model = path(paths, "ctcModel")),
        tokens = path(paths, "tokens"),
        modelType = if (modelType == "ctc") "zipformer_ctc" else modelType
      )
      "whisper" -> {
        val w = modelOptions?.getMap("whisper")
        OfflineModelConfig(
          whisper = OfflineWhisperModelConfig(
            encoder = path(paths, "whisperEncoder"),
            decoder = path(paths, "whisperDecoder"),
            language = w?.getString("language") ?: "en",
            task = w?.getString("task") ?: "transcribe",
            tailPaddings = if (w?.hasKey("tailPaddings") == true) w.getInt("tailPaddings") else 1000,
            enableTokenTimestamps = w?.hasKey("enableTokenTimestamps") == true && w.getBoolean("enableTokenTimestamps"),
            enableSegmentTimestamps = w?.hasKey("enableSegmentTimestamps") == true && w.getBoolean("enableSegmentTimestamps")
          ),
          tokens = path(paths, "tokens"),
          modelType = "whisper"
        )
      }
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
          cachedDecoder = path(paths, "moonshineCachedDecoder"),
          mergedDecoder = ""
        ),
        tokens = path(paths, "tokens"),
        modelType = "moonshine"
      )
      "moonshine_v2" -> OfflineModelConfig(
        moonshine = OfflineMoonshineModelConfig(
          encoder = path(paths, "moonshineEncoder"),
          mergedDecoder = path(paths, "moonshineMergedDecoder")
        ),
        tokens = path(paths, "tokens"),
        modelType = "moonshine"
      )
      "dolphin" -> OfflineModelConfig(
        dolphin = OfflineDolphinModelConfig(model = path(paths, "dolphinModel")),
        tokens = path(paths, "tokens"),
        modelType = "dolphin"
      )
      "canary" -> {
        val c = modelOptions?.getMap("canary")
        OfflineModelConfig(
          canary = OfflineCanaryModelConfig(
            encoder = path(paths, "canaryEncoder"),
            decoder = path(paths, "canaryDecoder"),
            srcLang = c?.getString("srcLang") ?: "en",
            tgtLang = c?.getString("tgtLang") ?: "en",
            usePnc = if (c?.hasKey("usePnc") == true) c.getBoolean("usePnc") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "canary"
        )
      }
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
      "funasr_nano" -> {
        val fn = modelOptions?.getMap("funasrNano")
        OfflineModelConfig(
          funasrNano = OfflineFunAsrNanoModelConfig(
            encoderAdaptor = path(paths, "funasrEncoderAdaptor"),
            llm = path(paths, "funasrLLM"),
            embedding = path(paths, "funasrEmbedding"),
            tokenizer = path(paths, "funasrTokenizer"),
            systemPrompt = fn?.getString("systemPrompt") ?: "You are a helpful assistant.",
            userPrompt = fn?.getString("userPrompt") ?: "语音转写：",
            maxNewTokens = if (fn?.hasKey("maxNewTokens") == true) fn.getInt("maxNewTokens") else 512,
            temperature = if (fn?.hasKey("temperature") == true) fn.getDouble("temperature").toFloat() else 1e-6f,
            topP = if (fn?.hasKey("topP") == true) fn.getDouble("topP").toFloat() else 0.8f,
            seed = if (fn?.hasKey("seed") == true) fn.getInt("seed") else 42,
            language = fn?.getString("language") ?: "",
            itn = if (fn?.hasKey("itn") == true) fn.getBoolean("itn") else true,
            hotwords = fn?.getString("hotwords") ?: ""
          ),
          tokens = ""
        )
      }
      "qwen3_asr" -> {
        val q3 = modelOptions?.getMap("qwen3Asr")
        OfflineModelConfig(
          qwen3Asr = OfflineQwen3AsrModelConfig(
            convFrontend = path(paths, "qwen3ConvFrontend"),
            encoder = path(paths, "qwen3Encoder"),
            decoder = path(paths, "qwen3Decoder"),
            tokenizer = path(paths, "qwen3Tokenizer"),
            maxTotalLen = if (q3?.hasKey("maxTotalLen") == true) q3.getInt("maxTotalLen") else 512,
            maxNewTokens = if (q3?.hasKey("maxNewTokens") == true) q3.getInt("maxNewTokens") else 128,
            temperature = if (q3?.hasKey("temperature") == true) q3.getDouble("temperature").toFloat() else 1e-6f,
            topP = if (q3?.hasKey("topP") == true) q3.getDouble("topP").toFloat() else 0.8f,
            seed = if (q3?.hasKey("seed") == true) q3.getInt("seed") else 42,
            hotwords = ""
          ),
          tokens = ""
        )
      }
      "cohere_transcribe" -> {
        val ct = modelOptions?.getMap("cohereTranscribe")
        OfflineModelConfig(
          cohereTranscribe = OfflineCohereTranscribeModelConfig(
            encoder = path(paths, "cohereEncoder"),
            decoder = path(paths, "cohereDecoder"),
            language = ct?.getString("language")?.trim()?.takeIf { it.isNotEmpty() } ?: "en",
            usePunct = if (ct?.hasKey("usePunct") == true) ct.getBoolean("usePunct") else true,
            useItn = if (ct?.hasKey("useItn") == true) ct.getBoolean("useItn") else true
          ),
          tokens = path(paths, "tokens"),
          modelType = "cohere_transcribe"
        )
      }
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

    val effectiveBpeVocab = bpeVocab.ifEmpty { path(paths, "bpeVocab") }
    val finalModelConfig = modelConfig.copy(
      numThreads = numThreads ?: 1,
      provider = provider ?: "cpu",
      modelingUnit = modelingUnit,
      bpeVocab = effectiveBpeVocab
    )
    val baseConfig = OfflineRecognizerConfig(
      featConfig = featConfig,
      modelConfig = finalModelConfig,
      hotwordsFile = hotwordsFile,
      hotwordsScore = hotwordsScore,
      ruleFsts = ruleFsts,
      ruleFars = ruleFars
    )

    return if (hotwordsFile.isNotEmpty() && (modelType == "transducer" || modelType == "nemo_transducer")) {
      baseConfig.copy(
        decodingMethod = "modified_beam_search",
        maxActivePaths = maxOf(4, baseConfig.maxActivePaths)
      )
    } else baseConfig
  }

  private fun path(paths: Map<String, String>, key: String): String =
    paths[key].orEmpty()
}
