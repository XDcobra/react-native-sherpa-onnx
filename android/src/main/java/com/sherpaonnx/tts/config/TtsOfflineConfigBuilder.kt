package com.sherpaonnx.tts.config

import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsZipVoiceModelConfig

internal object TtsOfflineConfigBuilder {
  fun path(paths: Map<String, String>, key: String): String = paths[key].orEmpty()

  fun buildTtsConfig(
    paths: Map<String, String>,
    modelType: String,
    numThreads: Int,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Int?,
    silenceScale: Double?,
    provider: String?
  ): OfflineTtsConfig {
    val ns = noiseScale?.toFloat() ?: 0.667f
    val nsw = noiseScaleW?.toFloat() ?: 0.8f
    val ls = lengthScale?.toFloat() ?: 1.0f
    val prov = provider?.takeIf { it.isNotBlank() } ?: "cpu"
    val modelConfig = when (modelType) {
      "vits" -> OfflineTtsModelConfig(
        vits = OfflineTtsVitsModelConfig(
          model = path(paths, "ttsModel"),
          lexicon = path(paths, "lexicon"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          noiseScale = ns,
          noiseScaleW = nsw,
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "matcha" -> OfflineTtsModelConfig(
        matcha = OfflineTtsMatchaModelConfig(
          acousticModel = path(paths, "acousticModel"),
          vocoder = path(paths, "vocoder"),
          lexicon = path(paths, "lexicon"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          noiseScale = ns,
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "kokoro" -> OfflineTtsModelConfig(
        kokoro = OfflineTtsKokoroModelConfig(
          model = path(paths, "ttsModel"),
          voices = path(paths, "voices"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          lexicon = path(paths, "lexicon"),
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "kitten" -> OfflineTtsModelConfig(
        kitten = OfflineTtsKittenModelConfig(
          model = path(paths, "ttsModel"),
          voices = path(paths, "voices"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "pocket" -> OfflineTtsModelConfig(
        pocket = OfflineTtsPocketModelConfig(
          lmFlow = path(paths, "lmFlow"),
          lmMain = path(paths, "lmMain"),
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          textConditioner = path(paths, "textConditioner"),
          vocabJson = path(paths, "vocabJson"),
          tokenScoresJson = path(paths, "tokenScoresJson")
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "zipvoice" -> OfflineTtsModelConfig(
        zipvoice = OfflineTtsZipVoiceModelConfig(
          tokens = path(paths, "tokens"),
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          vocoder = path(paths, "vocoder"),
          dataDir = path(paths, "dataDir"),
          lexicon = path(paths, "lexicon")
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      "supertonic" -> OfflineTtsModelConfig(
        supertonic = OfflineTtsSupertonicModelConfig(
          durationPredictor = path(paths, "durationPredictor"),
          textEncoder = path(paths, "textEncoder"),
          vectorEstimator = path(paths, "vectorEstimator"),
          vocoder = path(paths, "vocoder"),
          ttsJson = path(paths, "ttsJson"),
          unicodeIndexer = path(paths, "unicodeIndexer"),
          voiceStyle = path(paths, "voiceStyle")
        ),
        numThreads = numThreads,
        debug = debug,
        provider = prov
      )
      else -> {
        if (path(paths, "acousticModel").isNotEmpty()) {
          OfflineTtsModelConfig(
            matcha = OfflineTtsMatchaModelConfig(
              acousticModel = path(paths, "acousticModel"),
              vocoder = path(paths, "vocoder"),
              lexicon = path(paths, "lexicon"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              noiseScale = ns,
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug,
            provider = prov
          )
        } else if (path(paths, "voices").isNotEmpty()) {
          OfflineTtsModelConfig(
            kokoro = OfflineTtsKokoroModelConfig(
              model = path(paths, "ttsModel"),
              voices = path(paths, "voices"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              lexicon = path(paths, "lexicon"),
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug,
            provider = prov
          )
        } else {
          OfflineTtsModelConfig(
            vits = OfflineTtsVitsModelConfig(
              model = path(paths, "ttsModel"),
              lexicon = path(paths, "lexicon"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              noiseScale = ns,
              noiseScaleW = nsw,
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug,
            provider = prov
          )
        }
      }
    }
    return OfflineTtsConfig(
      model = modelConfig,
      ruleFsts = ruleFsts?.takeIf { it.isNotBlank() } ?: "",
      ruleFars = ruleFars?.takeIf { it.isNotBlank() } ?: "",
      maxNumSentences = maxNumSentences?.coerceAtLeast(1) ?: 1,
      silenceScale = silenceScale?.toFloat()?.coerceIn(0f, 10f) ?: 0.2f
    )
  }
}
