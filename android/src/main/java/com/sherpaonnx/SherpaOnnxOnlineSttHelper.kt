package com.sherpaonnx

import android.content.Context
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizerResult
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineToneCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import java.io.File
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
    val streams: MutableMap<String, OnlineStream> = mutableMapOf()
  )

  private val instances = ConcurrentHashMap<String, OnlineSttInstance>()
  private val streamToInstance = ConcurrentHashMap<String, String>()

  private fun getInstance(instanceId: String): OnlineSttInstance? = instances[instanceId]

  private fun getStream(streamId: String): Pair<OnlineSttInstance, OnlineStream>? {
    val instanceId = streamToInstance[streamId] ?: return null
    val inst = instances[instanceId] ?: return null
    val stream = inst.streams[streamId] ?: return null
    return inst to stream
  }

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
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80, dither = 0f),
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
      promise.reject("INIT_ERROR", "Online STT init failed: ${e.message}", e)
    }
  }

  fun createSttStream(instanceId: String, streamId: String, hotwords: String?, promise: Promise) {
    try {
      val inst = getInstance(instanceId)
        ?: run {
          promise.reject("STREAM_ERROR", "Online STT instance not found: $instanceId")
          return
        }
      if (inst.streams.containsKey(streamId)) {
        promise.reject("STREAM_ERROR", "Stream already exists: $streamId")
        return
      }
      val stream = inst.recognizer.createStream(hotwords = hotwords?.trim().orEmpty())
      inst.streams[streamId] = stream
      streamToInstance[streamId] = instanceId
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "createSttStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "Create stream failed: ${e.message}", e)
    }
  }

  private fun readableArrayToFloatArray(arr: ReadableArray): FloatArray =
    FloatArray(arr.size()) { i -> arr.getDouble(i).toFloat() }

  fun acceptSttWaveform(streamId: String, samples: ReadableArray, sampleRate: Int, promise: Promise) {
    try {
      val (_, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      val floatSamples = readableArrayToFloatArray(samples)
      stream.acceptWaveform(floatSamples, sampleRate)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "acceptSttWaveform failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "acceptSttWaveform failed: ${e.message}", e)
    }
  }

  fun sttStreamInputFinished(streamId: String, promise: Promise) {
    try {
      val (_, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      stream.inputFinished()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "sttStreamInputFinished failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "sttStreamInputFinished failed: ${e.message}", e)
    }
  }

  fun decodeSttStream(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      inst.recognizer.decode(stream)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "decodeSttStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "decodeSttStream failed: ${e.message}", e)
    }
  }

  fun isSttStreamReady(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      val ready = inst.recognizer.isReady(stream)
      promise.resolve(ready)
    } catch (e: Exception) {
      Log.e(logTag, "isSttStreamReady failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "isSttStreamReady failed: ${e.message}", e)
    }
  }

  private fun resultToWritableMap(result: OnlineRecognizerResult): WritableMap {
    val map = Arguments.createMap()
    map.putString("text", result.text)
    val tokensArray = Arguments.createArray()
    for (t in result.tokens) tokensArray.pushString(t)
    map.putArray("tokens", tokensArray)
    val timestampsArray = Arguments.createArray()
    for (t in result.timestamps) timestampsArray.pushDouble(t.toDouble())
    map.putArray("timestamps", timestampsArray)
    return map
  }

  fun getSttStreamResult(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      val result = inst.recognizer.getResult(stream)
      promise.resolve(resultToWritableMap(result))
    } catch (e: Exception) {
      Log.e(logTag, "getSttStreamResult failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "getSttStreamResult failed: ${e.message}", e)
    }
  }

  fun isSttStreamEndpoint(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      val endpoint = inst.recognizer.isEndpoint(stream)
      promise.resolve(endpoint)
    } catch (e: Exception) {
      Log.e(logTag, "isSttStreamEndpoint failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "isSttStreamEndpoint failed: ${e.message}", e)
    }
  }

  fun resetSttStream(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      inst.recognizer.reset(stream)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "resetSttStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "resetSttStream failed: ${e.message}", e)
    }
  }

  fun releaseSttStream(streamId: String, promise: Promise) {
    try {
      val instanceId = streamToInstance.remove(streamId) ?: run {
        promise.resolve(null)
        return
      }
      val inst = instances[instanceId] ?: run {
        promise.resolve(null)
        return
      }
      inst.streams.remove(streamId)?.release()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "releaseSttStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "releaseSttStream failed: ${e.message}", e)
    }
  }

  fun unloadOnlineStt(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId) ?: run {
        promise.resolve(null)
        return
      }
      inst.streams.values.forEach { it.release() }
      inst.streams.clear()
      inst.streams.keys.forEach { streamToInstance.remove(it) }
      inst.recognizer.release()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "unloadOnlineStt failed: ${e.message}", e)
      promise.reject("RELEASE_ERROR", "unloadOnlineStt failed: ${e.message}", e)
    }
  }

  /**
   * Convenience: accept waveform, then while (isReady) decode, then getResult and isEndpoint.
   */
  fun processSttAudioChunk(
    streamId: String,
    samples: ReadableArray,
    sampleRate: Int,
    promise: Promise
  ) {
    try {
      val (inst, stream) = getStream(streamId)
        ?: run {
          promise.reject("STREAM_ERROR", "Stream not found: $streamId")
          return
        }
      val floatSamples = readableArrayToFloatArray(samples)
      stream.acceptWaveform(floatSamples, sampleRate)
      while (inst.recognizer.isReady(stream)) {
        inst.recognizer.decode(stream)
      }
      val result = inst.recognizer.getResult(stream)
      val isEndpoint = inst.recognizer.isEndpoint(stream)
      val map = resultToWritableMap(result)
      map.putBoolean("isEndpoint", isEndpoint)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(logTag, "processSttAudioChunk failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "processSttAudioChunk failed: ${e.message}", e)
    }
  }

  /** Call from Module.onCatalystInstanceDestroy to release all resources. */
  fun shutdown() {
    instances.keys.toList().forEach { instanceId ->
      try {
        val inst = instances.remove(instanceId) ?: return@forEach
        inst.streams.values.forEach { it.release() }
        inst.streams.clear()
        inst.streams.keys.forEach { streamToInstance.remove(it) }
        inst.recognizer.release()
      } catch (e: Exception) {
        Log.w(logTag, "shutdown: failed to release instance $instanceId: ${e.message}")
      }
    }
    streamToInstance.clear()
  }
}
