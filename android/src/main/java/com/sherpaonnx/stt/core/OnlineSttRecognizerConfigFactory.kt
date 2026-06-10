package com.sherpaonnx.stt.core

import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineToneCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import java.io.File

internal class OnlineSttRecognizerConfigFactory(
  private val pathResolver: SttPathResolver
) {

  fun buildOnlineRecognizerConfig(
    modelDir: String,
    modelType: String,
    enableEndpoint: Boolean,
    decodingMethod: String,
    maxActivePaths: Int,
    hotwordsFile: String?,
    hotwordsScore: Float?,
    numThreads: Int?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Float?,
    blankPenalty: Float?,
    debug: Boolean?,
    rule1MustContainNonSilence: Boolean?,
    rule1MinTrailingSilence: Float?,
    rule1MinUtteranceLength: Float?,
    rule2MustContainNonSilence: Boolean?,
    rule2MinTrailingSilence: Float?,
    rule2MinUtteranceLength: Float?,
    rule3MustContainNonSilence: Boolean?,
    rule3MinTrailingSilence: Float?,
    rule3MinUtteranceLength: Float?
  ): OnlineRecognizerConfig {
    val paths = scanOnlineModelPaths(modelDir, modelType)
    return buildOnlineRecognizerConfigFromPaths(
      paths,
      modelType,
      enableEndpoint,
      decodingMethod,
      maxActivePaths,
      hotwordsFile,
      hotwordsScore,
      numThreads,
      provider,
      ruleFsts,
      ruleFars,
      dither,
      blankPenalty,
      debug,
      rule1MustContainNonSilence,
      rule1MinTrailingSilence,
      rule1MinUtteranceLength,
      rule2MustContainNonSilence,
      rule2MinTrailingSilence,
      rule2MinUtteranceLength,
      rule3MustContainNonSilence,
      rule3MinTrailingSilence,
      rule3MinUtteranceLength
    )
  }

  fun buildOnlineRecognizerConfigFromPaths(
    paths: Map<String, String>,
    modelType: String,
    enableEndpoint: Boolean,
    decodingMethod: String,
    maxActivePaths: Int,
    hotwordsFile: String?,
    hotwordsScore: Float?,
    numThreads: Int?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Float?,
    blankPenalty: Float?,
    debug: Boolean?,
    rule1MustContainNonSilence: Boolean?,
    rule1MinTrailingSilence: Float?,
    rule1MinUtteranceLength: Float?,
    rule2MustContainNonSilence: Boolean?,
    rule2MinTrailingSilence: Float?,
    rule2MinUtteranceLength: Float?,
    rule3MustContainNonSilence: Boolean?,
    rule3MinTrailingSilence: Float?,
    rule3MinUtteranceLength: Float?
  ): OnlineRecognizerConfig {
    validateOnlinePaths(paths, modelType)

    val endpointConfig = EndpointConfig(
      rule1 = EndpointRule(
        mustContainNonSilence = rule1MustContainNonSilence ?: false,
        minTrailingSilence = rule1MinTrailingSilence ?: 2.4f,
        minUtteranceLength = rule1MinUtteranceLength ?: 0f
      ),
      rule2 = EndpointRule(
        mustContainNonSilence = rule2MustContainNonSilence ?: true,
        minTrailingSilence = rule2MinTrailingSilence ?: 1.4f,
        minUtteranceLength = rule2MinUtteranceLength ?: 0f
      ),
      rule3 = EndpointRule(
        mustContainNonSilence = rule3MustContainNonSilence ?: false,
        minTrailingSilence = rule3MinTrailingSilence ?: 0f,
        minUtteranceLength = rule3MinUtteranceLength ?: 20f
      )
    )

    val modelConfig = when (modelType) {
      "transducer" -> OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = paths["encoder"] ?: "",
          decoder = paths["decoder"] ?: "",
          joiner = paths["joiner"] ?: ""
        ),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu",
        modelType = "zipformer"
      )
      "nemo_transducer" -> OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = paths["encoder"] ?: "",
          decoder = paths["decoder"] ?: "",
          joiner = paths["joiner"] ?: ""
        ),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu",
        modelType = ""
      )
      "paraformer" -> OnlineModelConfig(
        paraformer = OnlineParaformerModelConfig(
          encoder = paths["encoder"] ?: "",
          decoder = paths["decoder"] ?: ""
        ),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu",
        modelType = "paraformer"
      )
      "zipformer2_ctc" -> OnlineModelConfig(
        zipformer2Ctc = OnlineZipformer2CtcModelConfig(model = paths["model"] ?: ""),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu",
        modelType = "zipformer2"
      )
      "nemo_ctc" -> OnlineModelConfig(
        neMoCtc = OnlineNeMoCtcModelConfig(model = paths["model"] ?: ""),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu"
      )
      "tone_ctc" -> OnlineModelConfig(
        toneCtc = OnlineToneCtcModelConfig(model = paths["model"] ?: ""),
        tokens = paths["tokens"] ?: "",
        numThreads = numThreads ?: 1,
        debug = debug ?: false,
        provider = provider ?: "cpu"
      )
      else -> throw IllegalArgumentException("Unsupported online model type: $modelType")
    }

    val resolvedRuleFsts = try {
      pathResolver.resolveFilePaths(ruleFsts.orEmpty().trim(), "online_stt_rule_fst")
    } catch (_: Exception) {
      ""
    }
    val resolvedRuleFars = try {
      pathResolver.resolveFilePaths(ruleFars.orEmpty().trim(), "online_stt_rule_far")
    } catch (_: Exception) {
      ""
    }
    var resolvedHotwordsFile = hotwordsFile?.trim().orEmpty()
    if (resolvedHotwordsFile.isNotEmpty()) {
      try {
        resolvedHotwordsFile = pathResolver.resolveContentUriToFile(resolvedHotwordsFile, "online_stt_hotwords")
      } catch (_: Exception) {
        resolvedHotwordsFile = ""
      }
    }

    return OnlineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80, dither = dither ?: 0f),
      modelConfig = modelConfig,
      endpointConfig = endpointConfig,
      enableEndpoint = enableEndpoint,
      decodingMethod = decodingMethod,
      maxActivePaths = maxActivePaths,
      hotwordsFile = resolvedHotwordsFile,
      hotwordsScore = hotwordsScore ?: 1.5f,
      ruleFsts = resolvedRuleFsts,
      ruleFars = resolvedRuleFars,
      blankPenalty = blankPenalty ?: 0f
    )
  }

  private fun scanOnlineModelPaths(modelDir: String, modelType: String): Map<String, String> {
    val dir = File(modelDir)
    if (!dir.exists() || !dir.isDirectory) {
      throw IllegalArgumentException("Model directory does not exist or is not a directory: $modelDir")
    }
    val files = dir.listFiles()?.filter { it.isFile }.orEmpty()

    fun firstFile(vararg prefixes: String, suffix: String = ".onnx"): String =
      prefixes.firstNotNullOfOrNull { prefix ->
        files.firstOrNull { it.name.startsWith(prefix) && it.name.endsWith(suffix) }?.absolutePath
      }.orEmpty()

    val tokensPath = files.firstOrNull { it.name == "tokens.txt" }?.absolutePath ?: ""

    return when (modelType) {
      "transducer", "nemo_transducer" -> mapOf(
        "encoder" to firstFile("encoder"),
        "decoder" to firstFile("decoder"),
        "joiner" to firstFile("joiner"),
        "tokens" to tokensPath
      )
      "paraformer" -> mapOf(
        "encoder" to firstFile("encoder"),
        "decoder" to firstFile("decoder"),
        "tokens" to tokensPath
      )
      "zipformer2_ctc", "nemo_ctc", "tone_ctc" -> mapOf(
        "model" to firstFile("model"),
        "tokens" to tokensPath
      )
      else -> throw IllegalArgumentException("Unsupported online STT model type: $modelType. Use: transducer, nemo_transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc")
    }.also { paths ->
      validateOnlinePaths(paths, modelType)
    }
  }

  private fun validateOnlinePaths(paths: Map<String, String>, modelType: String) {
    when (modelType) {
      "transducer", "nemo_transducer" -> {
        if (
          paths["encoder"].isNullOrEmpty() ||
          paths["decoder"].isNullOrEmpty() ||
          paths["joiner"].isNullOrEmpty()
        ) {
          throw IllegalArgumentException(
            "Transducer model requires encoder, decoder, and joiner .onnx files"
          )
        }
      }
      "paraformer" -> {
        if (paths["encoder"].isNullOrEmpty() || paths["decoder"].isNullOrEmpty()) {
          throw IllegalArgumentException(
            "Paraformer model requires encoder and decoder .onnx files"
          )
        }
      }
      "zipformer2_ctc", "nemo_ctc", "tone_ctc" -> {
        if (paths["model"].isNullOrEmpty()) {
          throw IllegalArgumentException(
            "$modelType model requires model.onnx (or model*.onnx)"
          )
        }
      }
    }
  }
}
