package com.sherpaonnx

import android.content.Context
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineToneCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.audio.pipeline.SttPipelineWorker
import com.sherpaonnx.stt.SttErrorCodes
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Helper for streaming (online) STT using sherpa-onnx OnlineRecognizer + OnlineStream.
 * Manages recognizer instances and streams; resolves model paths by scanning the model directory.
 */
internal class SherpaOnnxOnlineSttHelper(
  private val context: Context,
  private val logTag: String
) {

  private data class OnlineSttInstance(
    val recognizer: OnlineRecognizer,
    val config: OnlineRecognizerConfig,
    var activePipelineId: String? = null,
  )

  private val instances = ConcurrentHashMap<String, OnlineSttInstance>()

  private fun getInstance(instanceId: String): OnlineSttInstance? = instances[instanceId]

  private fun resolveContentUriToFile(path: String, cacheFilePrefix: String): String {
    if (!path.startsWith("content://")) return path
    val uri = Uri.parse(path)
    val cacheFile = File(context.cacheDir, "${cacheFilePrefix}_${System.nanoTime()}")
    context.contentResolver.openInputStream(uri)?.use { input ->
      cacheFile.outputStream().use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("File is not readable (content URI could not be opened): $path")
    return cacheFile.absolutePath
  }

  private fun resolveFilePaths(pathsString: String, cacheFilePrefix: String): String {
    if (pathsString.isBlank()) return pathsString
    return pathsString.split(',').map { it.trim() }.filter { it.isNotEmpty() }
      .mapIndexed { index, p -> resolveContentUriToFile(p, "${cacheFilePrefix}_$index") }
      .joinToString(",")
  }

  /**
   * Scan model directory for files matching the given online model type.
   * Returns a map with keys: encoder, decoder, joiner, tokens (transducer/paraformer) or model, tokens (ctc types).
   */
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
      "transducer" -> mapOf(
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
      else -> throw IllegalArgumentException("Unsupported online STT model type: $modelType. Use: transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc")
    }.also { paths ->
      when (modelType) {
        "transducer" -> {
          if ((paths["encoder"]?.isEmpty() != false) || (paths["decoder"]?.isEmpty() != false) || (paths["joiner"]?.isEmpty() != false))
            throw IllegalArgumentException("Transducer model requires encoder, decoder, and joiner .onnx files in $modelDir")
        }
        "paraformer" -> {
          if ((paths["encoder"]?.isEmpty() != false) || (paths["decoder"]?.isEmpty() != false))
            throw IllegalArgumentException("Paraformer model requires encoder and decoder .onnx files in $modelDir")
        }
        "zipformer2_ctc", "nemo_ctc", "tone_ctc" -> {
          if (paths["model"]?.isEmpty() != false)
            throw IllegalArgumentException("$modelType model requires model.onnx (or model*.onnx) in $modelDir")
        }
      }
    }
  }

  private fun buildOnlineRecognizerConfig(
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
      resolveFilePaths(ruleFsts.orEmpty().trim(), "online_stt_rule_fst")
    } catch (e: Exception) {
      ""
    }
    val resolvedRuleFars = try {
      resolveFilePaths(ruleFars.orEmpty().trim(), "online_stt_rule_far")
    } catch (e: Exception) {
      ""
    }
    var resolvedHotwordsFile = hotwordsFile?.trim().orEmpty()
    if (resolvedHotwordsFile.isNotEmpty()) {
      try {
        resolvedHotwordsFile = resolveContentUriToFile(resolvedHotwordsFile, "online_stt_hotwords")
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

  fun initializeOnlineStt(
    instanceId: String,
    modelDir: String,
    modelType: String,
    enableEndpoint: Boolean,
    decodingMethod: String,
    maxActivePaths: Int,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    blankPenalty: Double?,
    debug: Boolean?,
    rule1MustContainNonSilence: Boolean?,
    rule1MinTrailingSilence: Double?,
    rule1MinUtteranceLength: Double?,
    rule2MustContainNonSilence: Boolean?,
    rule2MinTrailingSilence: Double?,
    rule2MinUtteranceLength: Double?,
    rule3MustContainNonSilence: Boolean?,
    rule3MinTrailingSilence: Double?,
    rule3MinUtteranceLength: Double?,
    promise: Promise
  ) {
    try {
      val config = buildOnlineRecognizerConfig(
        modelDir = modelDir,
        modelType = modelType,
        enableEndpoint = enableEndpoint,
        decodingMethod = decodingMethod,
        maxActivePaths = maxActivePaths,
        hotwordsFile = hotwordsFile,
        hotwordsScore = hotwordsScore?.toFloat(),
        numThreads = numThreads?.toInt(),
        provider = provider,
        ruleFsts = ruleFsts,
        ruleFars = ruleFars,
        dither = dither?.toFloat(),
        blankPenalty = blankPenalty?.toFloat(),
        debug = debug,
        rule1MustContainNonSilence = rule1MustContainNonSilence,
        rule1MinTrailingSilence = rule1MinTrailingSilence?.toFloat(),
        rule1MinUtteranceLength = rule1MinUtteranceLength?.toFloat(),
        rule2MustContainNonSilence = rule2MustContainNonSilence,
        rule2MinTrailingSilence = rule2MinTrailingSilence?.toFloat(),
        rule2MinUtteranceLength = rule2MinUtteranceLength?.toFloat(),
        rule3MustContainNonSilence = rule3MustContainNonSilence,
        rule3MinTrailingSilence = rule3MinTrailingSilence?.toFloat(),
        rule3MinUtteranceLength = rule3MinUtteranceLength?.toFloat()
      )
      val recognizer = OnlineRecognizer(assetManager = null, config = config)
      instances[instanceId] = OnlineSttInstance(recognizer = recognizer, config = config)
      promise.resolve(Arguments.createMap().apply { putBoolean("success", true) })
    } catch (e: Exception) {
      Log.e(logTag, "initializeOnlineStt failed: ${e.message}", e)
      promise.reject(SttErrorCodes.INIT_FAILED, "Online STT init failed: ${e.message}", e)
    }
  }


  fun unloadOnlineStt(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId) ?: run {
        promise.resolve(null)
        return
      }

      synchronized(inst) {
        val activePipelineId = inst.activePipelineId
        if (!activePipelineId.isNullOrBlank()) {
          StreamingPipelineRegistry.stop(activePipelineId)
          StreamingPipelineRegistry.remove(activePipelineId)
        }
        inst.activePipelineId = null
      }
      inst.recognizer.release()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "unloadOnlineStt failed: ${e.message}", e)
      promise.reject(SttErrorCodes.INTERNAL_ERROR, "unloadOnlineStt failed: ${e.message}", e)
    }
  }

  fun startSttPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    chunkSize: Int?,
    promise: Promise
  ) {
    try {
      val inst = getInstance(instanceId)
      if (inst == null) {
        promise.reject("STT_PIPELINE_INSTANCE_NOT_FOUND", "Online STT instance not found: $instanceId")
        return
      }

      val inputEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (inputEntry == null) {
        promise.reject("STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND", "Input live audio buffer not found: $audioInLiveBufferId")
        return
      }

      val outputEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (outputEntry == null) {
        promise.reject("STT_PIPELINE_TEXT_BUFFER_NOT_FOUND", "Output live text buffer not found: $textOutLiveBufferId")
        return
      }

      if (inputEntry.kind != "livePcmBuffer") {
        promise.reject("STT_PIPELINE_BUFFER_KIND_MISMATCH", "Input buffer must be a live audio buffer")
        return
      }

      if (inputEntry.state != LiveEntry.State.RECORDING) {
        promise.reject("STT_PIPELINE_BUFFER_NOT_RECORDING", "Input audio buffer is not in recording state")
        return
      }

      if (outputEntry.state != com.sherpaonnx.text.pipeline.LiveTextEntry.State.RECORDING) {
        promise.reject("STT_PIPELINE_BUFFER_NOT_RECORDING", "Output text buffer is not in recording state")
        return
      }

      val recognizerSampleRate = inst.config.featConfig.sampleRate
      if (inputEntry.sampleRate != recognizerSampleRate) {
        promise.reject(
          "STT_PIPELINE_SAMPLE_RATE_MISMATCH",
          "Input buffer sample rate (${inputEntry.sampleRate}) does not match recognizer sample rate ($recognizerSampleRate)"
        )
        return
      }

      synchronized(inst) {
        val existingPipelineId = inst.activePipelineId
        if (!existingPipelineId.isNullOrBlank()) {
          val existingWorker = StreamingPipelineRegistry.get(existingPipelineId)
          if (existingWorker != null && existingWorker.isRunning) {
            promise.reject("STT_PIPELINE_ALREADY_RUNNING", "STT pipeline already running for instance: $instanceId")
            return
          }
          StreamingPipelineRegistry.remove(existingPipelineId)
          inst.activePipelineId = null
        }
      }

      val pipelineId = UUID.randomUUID().toString()
      val stream = inst.recognizer.createStream()

      val worker = SttPipelineWorker(
        pipelineId = pipelineId,
        recognizer = inst.recognizer,
        stream = stream,
        inputEntry = inputEntry,
        outputEntry = outputEntry,
        chunkSize = chunkSize ?: 3200,
      )

      StreamingPipelineRegistry.registerAndStart(worker)

      synchronized(inst) {
        inst.activePipelineId = pipelineId
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startSttPipeline failed: ${e.message}", e)
      promise.reject("STREAMING_PIPELINE_ERROR", "Failed to start STT pipeline: ${e.message}", e)
    }
  }

  /** Call from Module.onCatalystInstanceDestroy to release all resources. */
  fun shutdown() {
    instances.keys.toList().forEach { instanceId ->
      try {
        val inst = instances.remove(instanceId) ?: return@forEach

        synchronized(inst) {
          val activePipelineId = inst.activePipelineId
          if (!activePipelineId.isNullOrBlank()) {
            StreamingPipelineRegistry.stop(activePipelineId)
            StreamingPipelineRegistry.remove(activePipelineId)
          }
          inst.activePipelineId = null
        }
        inst.recognizer.release()
      } catch (e: Exception) {
        Log.w(logTag, "shutdown: failed to release instance $instanceId: ${e.message}")
      }
    }
  }
}
