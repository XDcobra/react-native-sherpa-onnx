package com.sherpaonnx

import android.content.Context
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.KeywordSpotterResult
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Helper for keyword spotting using sherpa-onnx KeywordSpotter + OnlineStream.
 * Manages spotter instances and streams; resolves model paths by scanning the model directory.
 */
internal class SherpaOnnxKwsHelper(
  private val context: Context,
  private val logTag: String
) {

  private data class KwsInstance(
    val spotter: KeywordSpotter,
    val config: KeywordSpotterConfig,
    val streams: MutableMap<String, OnlineStream> = mutableMapOf()
  )

  private val instances = ConcurrentHashMap<String, KwsInstance>()
  private val streamToInstance = ConcurrentHashMap<String, String>()

  private fun getInstance(instanceId: String): KwsInstance? = instances[instanceId]

  private fun getStream(streamId: String): Pair<KwsInstance, OnlineStream>? {
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

  /**
   * Scan model directory for files matching the KWS model.
   * Returns a map with keys: encoder, decoder, joiner (chunk-based), tokens, keywords.
   */
  private fun scanKwsModelPaths(modelDir: String): Map<String, String> {
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
    val keywordsPath = files.firstOrNull { it.name == "keywords.txt" }?.absolutePath ?: ""

    return mapOf(
      "encoder" to firstFile("encoder"),
      "decoder" to firstFile("decoder"),
      "joiner" to firstFile("joiner"),
      "tokens" to tokensPath,
      "keywords" to keywordsPath
    ).also { paths ->
      if ((paths["encoder"]?.isEmpty() != false) || (paths["decoder"]?.isEmpty() != false) || (paths["joiner"]?.isEmpty() != false)) {
        throw IllegalArgumentException("KWS model requires encoder, decoder, and joiner .onnx files in $modelDir")
      }
    }
  }

  private fun buildKeywordSpotterConfig(
    modelDir: String,
    keywordsFile: String?,
    keywordsScore: Float?,
    keywordsThreshold: Float?,
    numTrailingBlanks: Int?,
    maxActivePaths: Int?,
    numThreads: Int?,
    provider: String?,
    debug: Boolean?
  ): KeywordSpotterConfig {
    val paths = scanKwsModelPaths(modelDir)

    val modelConfig = OnlineModelConfig(
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

    var resolvedKeywordsFile = keywordsFile?.trim().orEmpty()
    if (resolvedKeywordsFile.isEmpty()) {
      resolvedKeywordsFile = paths["keywords"] ?: ""
    }
    if (resolvedKeywordsFile.isNotEmpty()) {
      try {
        resolvedKeywordsFile = resolveContentUriToFile(resolvedKeywordsFile, "kws_keywords")
      } catch (_: Exception) {
        // Continue with the original path if resolution fails
      }
    }

    return KeywordSpotterConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80, dither = 0f),
      modelConfig = modelConfig,
      keywordsFile = resolvedKeywordsFile,
      keywordsScore = keywordsScore ?: 1.5f,
      keywordsThreshold = keywordsThreshold ?: 0.25f,
      numTrailingBlanks = numTrailingBlanks ?: 2,
      maxActivePaths = maxActivePaths ?: 4
    )
  }

  fun initializeKws(
    instanceId: String,
    modelDir: String,
    keywordsFile: String?,
    keywordsScore: Double?,
    keywordsThreshold: Double?,
    numTrailingBlanks: Double?,
    maxActivePaths: Double?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val config = buildKeywordSpotterConfig(
        modelDir = modelDir,
        keywordsFile = keywordsFile,
        keywordsScore = keywordsScore?.toFloat(),
        keywordsThreshold = keywordsThreshold?.toFloat(),
        numTrailingBlanks = numTrailingBlanks?.toInt(),
        maxActivePaths = maxActivePaths?.toInt(),
        numThreads = numThreads?.toInt(),
        provider = provider,
        debug = debug
      )
      val spotter = KeywordSpotter(context.assets, config)
      val inst = KwsInstance(spotter, config)
      instances[instanceId] = inst
      val map = Arguments.createMap()
      map.putBoolean("success", true)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(logTag, "initializeKws failed: ${e.message}", e)
      val map = Arguments.createMap()
      map.putBoolean("success", false)
      map.putString("error", e.message ?: "Unknown error")
      promise.resolve(map)
    }
  }

  fun createKwsStream(
    instanceId: String,
    streamId: String,
    keywords: String?,
    promise: Promise
  ) {
    try {
      val inst = getInstance(instanceId) ?: run {
        promise.reject("INSTANCE_ERROR", "Instance not found: $instanceId")
        return
      }
      val stream = if (keywords?.isNotEmpty() == true) {
        inst.spotter.createStream(keywords)
      } else {
        inst.spotter.createStream()
      }
      inst.streams[streamId] = stream
      streamToInstance[streamId] = instanceId
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "createKwsStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "createKwsStream failed: ${e.message}", e)
    }
  }

  fun acceptKwsWaveform(
    streamId: String,
    samples: ReadableArray,
    sampleRate: Int,
    promise: Promise
  ) {
    try {
      val (_, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      val floatSamples = readableArrayToFloatArray(samples)
      stream.acceptWaveform(floatSamples, sampleRate)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "acceptKwsWaveform failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "acceptKwsWaveform failed: ${e.message}", e)
    }
  }

  fun decodeKwsStream(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      inst.spotter.decode(stream)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "decodeKwsStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "decodeKwsStream failed: ${e.message}", e)
    }
  }

  fun isKwsStreamReady(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      val ready = inst.spotter.isReady(stream)
      promise.resolve(ready)
    } catch (e: Exception) {
      Log.e(logTag, "isKwsStreamReady failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "isKwsStreamReady failed: ${e.message}", e)
    }
  }

  fun getKwsStreamResult(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      val result = inst.spotter.getResult(stream)
      val map = resultToKwsWritableMap(result)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(logTag, "getKwsStreamResult failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "getKwsStreamResult failed: ${e.message}", e)
    }
  }

  fun resetKwsStream(streamId: String, promise: Promise) {
    try {
      val (inst, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      inst.spotter.reset(stream)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "resetKwsStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "resetKwsStream failed: ${e.message}", e)
    }
  }

  fun releaseKwsStream(streamId: String, promise: Promise) {
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
      Log.e(logTag, "releaseKwsStream failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "releaseKwsStream failed: ${e.message}", e)
    }
  }

  fun unloadKws(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId) ?: run {
        promise.resolve(null)
        return
      }
      val streamIds = inst.streams.keys.toList()
      inst.streams.values.forEach { it.release() }
      inst.streams.clear()
      streamIds.forEach { streamToInstance.remove(it) }
      inst.spotter.release()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "unloadKws failed: ${e.message}", e)
      promise.reject("RELEASE_ERROR", "unloadKws failed: ${e.message}", e)
    }
  }

  /**
   * Convenience: accept waveform, then while (isReady) decode, then getResult.
   * Automatically resets stream if keyword is detected.
   */
  fun processKwsAudioChunk(
    streamId: String,
    samples: ReadableArray,
    sampleRate: Int,
    promise: Promise
  ) {
    try {
      val (inst, stream) = getStream(streamId) ?: run {
        promise.reject("STREAM_ERROR", "Stream not found: $streamId")
        return
      }
      val floatSamples = readableArrayToFloatArray(samples)
      stream.acceptWaveform(floatSamples, sampleRate)
      while (inst.spotter.isReady(stream)) {
        inst.spotter.decode(stream)
      }
      val result = inst.spotter.getResult(stream)
      if (result.keyword.isNotEmpty()) {
        inst.spotter.reset(stream)
      }
      val map = resultToKwsWritableMap(result)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(logTag, "processKwsAudioChunk failed: ${e.message}", e)
      promise.reject("STREAM_ERROR", "processKwsAudioChunk failed: ${e.message}", e)
    }
  }

  /** Call from Module.onCatalystInstanceDestroy to release all resources. */
  fun shutdown() {
    instances.keys.toList().forEach { instanceId ->
      try {
        val inst = instances.remove(instanceId) ?: return@forEach
        val streamIds = inst.streams.keys.toList()
        inst.streams.values.forEach { it.release() }
        inst.streams.clear()
        streamIds.forEach { streamToInstance.remove(it) }
        inst.spotter.release()
      } catch (e: Exception) {
        Log.w(logTag, "shutdown: failed to release instance $instanceId: ${e.message}")
      }
    }
    streamToInstance.clear()
  }

  private fun resultToKwsWritableMap(result: KeywordSpotterResult): WritableMap {
    val map = Arguments.createMap()
    map.putString("keyword", result.keyword)
    val tokensArray = Arguments.createArray()
    for (token in result.tokens) {
      tokensArray.pushString(token)
    }
    map.putArray("tokens", tokensArray)
    val timestampsArray = Arguments.createArray()
    for (timestamp in result.timestamps) {
      timestampsArray.pushDouble(timestamp.toDouble())
    }
    map.putArray("timestamps", timestampsArray)
    return map
  }
}
