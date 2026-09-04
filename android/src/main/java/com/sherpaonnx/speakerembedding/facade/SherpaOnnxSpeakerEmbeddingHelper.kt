package com.sherpaonnx.speakerembedding.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.speakerembedding.config.SpeakerEmbeddingInitOptionsParser

internal class SherpaOnnxSpeakerEmbeddingHelper(
  private val nativeDetectSpeakerEmbeddingModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  fun shutdown() {
    nativeShutdownAll()
  }

  fun detectSpeakerEmbeddingModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    try {
      val result =
        nativeDetectSpeakerEmbeddingModel(modelDir, assetName, modelType ?: "auto")
      if (result == null) {
        promise.reject(DETECT_ERROR, "Speaker embedding model detection returned null")
        return
      }
      promise.resolve(detectResultToWritable(result))
    } catch (e: Exception) {
      Log.e(TAG, "Speaker embedding detection failed", e)
      promise.reject(
        DETECT_ERROR,
        "Speaker embedding model detection failed: ${e.message}",
        e,
      )
    }
  }

  fun initializeSpeakerEmbeddingExtractor(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(INIT_ERROR, "instanceId is required")
      return
    }
    val parsed = SpeakerEmbeddingInitOptionsParser.parse(options)
    if (parsed == null) {
      promise.reject(
        INIT_ERROR,
        if (options.hasKey("initMode") && options.getString("initMode") == "custom") {
          "custom init requires initMode, modelType, and modelPaths"
        } else {
          "auto init requires modelDir"
        },
      )
      return
    }
    try {
      if (parsed.initMode == "custom") {
        initializeExtractorCustom(instanceId, parsed, promise)
      } else {
        initializeExtractorAuto(instanceId, parsed, promise)
      }
    } catch (e: Exception) {
      Log.e(TAG, "Failed to initialize speaker embedding extractor", e)
      promise.reject(
        INIT_ERROR,
        "Failed to initialize speaker embedding extractor: ${e.message}",
        e,
      )
    }
  }

  private fun initializeExtractorCustom(
    instanceId: String,
    parsed: SpeakerEmbeddingInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelTypeStr = parsed.modelType.trim()
    if (modelTypeStr.isEmpty() || modelTypeStr == "auto") {
      promise.reject(INIT_ERROR, "custom init requires a concrete modelType")
      return
    }
    if (modelTypeStr !in SUPPORTED_TYPES) {
      promise.reject(INIT_ERROR, "Unsupported speaker embedding model type: $modelTypeStr")
      return
    }
    val pathStrings = parsed.modelPaths.orEmpty()
    if (pathStrings["model"].isNullOrBlank()) {
      promise.reject(INIT_ERROR, "custom init requires modelPaths.model")
      return
    }
    val result = nativeInitializeExtractorCustom(
      instanceId,
      modelTypeStr,
      HashMap(pathStrings),
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveInitResult(result, promise)
  }

  private fun initializeExtractorAuto(
    instanceId: String,
    parsed: SpeakerEmbeddingInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    if (modelDir.isBlank()) {
      promise.reject(INIT_ERROR, "modelDir is required for initMode auto")
      return
    }
    val result = nativeInitializeExtractorAuto(
      instanceId,
      modelDir,
      parsed.modelType,
      parsed.numThreads.toInt().coerceAtLeast(1),
      parsed.provider,
      parsed.debug,
    )
    resolveInitResult(result, promise)
  }

  private fun resolveInitResult(result: HashMap<String, Any>?, promise: Promise) {
    if (result == null) {
      promise.reject(INIT_ERROR, "Speaker embedding initialize returned null")
      return
    }
    val success = result["success"] as? Boolean == true
    if (!success) {
      val code = (result["errorCode"] as? String)?.takeIf { it.isNotBlank() } ?: INIT_ERROR
      val error = (result["error"] as? String)?.takeIf { it.isNotBlank() }
        ?: "Failed to initialize speaker embedding extractor"
      promise.reject(code, error)
      return
    }
    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putInt("dim", (result["dim"] as? Number)?.toInt() ?: 0)
    out.putString("modelType", (result["modelType"] as? String) ?: "unknown")
    promise.resolve(out)
  }

  fun computeSpeakerEmbeddingOffline(
    instanceId: String,
    audioBufferId: String,
    startSample: Double?,
    endSample: Double?,
    promise: Promise,
  ) {
    if (!audioBufferId.startsWith("off_")) {
      promise.reject(
        BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) , got: $audioBufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioInEntry == null) {
      promise.reject(BUFFER_NOT_FOUND, "Offline audio buffer not found: $audioBufferId")
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(BUFFER_EMPTY, "Input offline audio buffer is empty: $audioBufferId")
      return
    }

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted",
      )
      return
    }

    try {
      val inputSamples: FloatArray
      if (!hasStart) {
        inputSamples = audioInEntry.readAllSamples()
      } else {
        val start =
          kotlin.math
            .floor(startSample!!)
            .toInt()
            .coerceAtLeast(0)
        val endRaw =
          kotlin.math
            .floor(endSample!!)
            .toInt()
            .coerceAtLeast(start)
        val end = endRaw.coerceAtMost(audioInEntry.numSamples)
        val frameCount = (end - start).coerceAtLeast(0)
        if (frameCount == 0) {
          val out = Arguments.createMap()
          out.putArray("embedding", Arguments.createArray())
          promise.resolve(out)
          return
        }
        inputSamples = audioInEntry.readSlice(start, frameCount)
      }

      val result = nativeComputeEmbedding(
        instanceId,
        inputSamples,
        audioInEntry.sampleRate,
      )
      if (result == null || result["success"] as? Boolean != true) {
        val code =
          (result?.get("errorCode") as? String)?.takeIf { it.isNotBlank() } ?: COMPUTE_ERROR
        val error =
          (result?.get("error") as? String)?.takeIf { it.isNotBlank() }
            ?: "Speaker embedding compute failed"
        promise.reject(code, error)
        return
      }
      val embedding = result["embedding"] as? FloatArray ?: floatArrayOf()
      val arr = Arguments.createArray()
      for (v in embedding) {
        arr.pushDouble(v.toDouble())
      }
      val out = Arguments.createMap()
      out.putArray("embedding", arr)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(TAG, "Speaker embedding compute failed", e)
      promise.reject(COMPUTE_ERROR, "Speaker embedding compute failed: ${e.message}", e)
    }
  }

  fun identifySpeakerOffline(
    instanceId: String,
    managerId: String,
    audioBufferId: String,
    threshold: Double,
    startSample: Double?,
    endSample: Double?,
    promise: Promise,
  ) {
    if (!audioBufferId.startsWith("off_")) {
      promise.reject(
        BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) , got: $audioBufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioInEntry == null) {
      promise.reject(BUFFER_NOT_FOUND, "Offline audio buffer not found: $audioBufferId")
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(BUFFER_EMPTY, "Input offline audio buffer is empty: $audioBufferId")
      return
    }

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted",
      )
      return
    }

    try {
      val inputSamples: FloatArray
      if (!hasStart) {
        inputSamples = audioInEntry.readAllSamples()
      } else {
        val start =
          kotlin.math
            .floor(startSample!!)
            .toInt()
            .coerceAtLeast(0)
        val endRaw =
          kotlin.math
            .floor(endSample!!)
            .toInt()
            .coerceAtLeast(start)
        val end = endRaw.coerceAtMost(audioInEntry.numSamples)
        val frameCount = (end - start).coerceAtLeast(0)
        if (frameCount == 0) {
          val out = Arguments.createMap()
          out.putString("name", "")
          promise.resolve(out)
          return
        }
        inputSamples = audioInEntry.readSlice(start, frameCount)
      }

      val embedding =
        computeEmbeddingFromSamples(
          instanceId,
          inputSamples,
          audioInEntry.sampleRate,
        )
      val name = searchSpeaker(managerId, embedding, threshold.toFloat())
      val out = Arguments.createMap()
      out.putString("name", name)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(TAG, "Speaker identify offline failed", e)
      val message = e.message.orEmpty()
      val code =
        when {
          message.startsWith("SPEAKER_EMBEDDING_") ->
            message.substringBefore(':').trim().ifBlank { COMPUTE_ERROR }
          else -> COMPUTE_ERROR
        }
      val detail =
        when {
          message.contains(':') -> message.substringAfter(':').trim()
          message.isNotBlank() -> message
          else -> "Speaker identify offline failed"
        }
      promise.reject(code, detail, e)
    }
  }

  fun verifySpeakerOffline(
    instanceId: String,
    managerId: String,
    audioBufferId: String,
    name: String,
    threshold: Double,
    startSample: Double?,
    endSample: Double?,
    promise: Promise,
  ) {
    if (!audioBufferId.startsWith("off_")) {
      promise.reject(
        BUFFER_KIND_MISMATCH,
        "Expected offline audio buffer (off_*) , got: $audioBufferId",
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioInEntry == null) {
      promise.reject(BUFFER_NOT_FOUND, "Offline audio buffer not found: $audioBufferId")
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(BUFFER_EMPTY, "Input offline audio buffer is empty: $audioBufferId")
      return
    }

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted",
      )
      return
    }

    try {
      val inputSamples: FloatArray
      if (!hasStart) {
        inputSamples = audioInEntry.readAllSamples()
      } else {
        val start =
          kotlin.math
            .floor(startSample!!)
            .toInt()
            .coerceAtLeast(0)
        val endRaw =
          kotlin.math
            .floor(endSample!!)
            .toInt()
            .coerceAtLeast(start)
        val end = endRaw.coerceAtMost(audioInEntry.numSamples)
        val frameCount = (end - start).coerceAtLeast(0)
        if (frameCount == 0) {
          promise.resolve(okMap(false))
          return
        }
        inputSamples = audioInEntry.readSlice(start, frameCount)
      }

      val embedding =
        computeEmbeddingFromSamples(
          instanceId,
          inputSamples,
          audioInEntry.sampleRate,
        )
      val ok = verifySpeaker(managerId, name, embedding, threshold.toFloat())
      promise.resolve(okMap(ok))
    } catch (e: Exception) {
      Log.e(TAG, "Speaker verify offline failed", e)
      val message = e.message.orEmpty()
      val code =
        when {
          message.startsWith("SPEAKER_EMBEDDING_") ->
            message.substringBefore(':').trim().ifBlank { COMPUTE_ERROR }
          else -> COMPUTE_ERROR
        }
      val detail =
        when {
          message.contains(':') -> message.substringAfter(':').trim()
          message.isNotBlank() -> message
          else -> "Speaker verify offline failed"
        }
      promise.reject(code, detail, e)
    }
  }

  fun unloadSpeakerEmbeddingExtractor(instanceId: String, promise: Promise) {
    nativeUnloadExtractor(instanceId)
    promise.resolve(null)
  }

  fun createSpeakerEmbeddingManager(
    managerId: String,
    dim: Double,
    promise: Promise,
  ) {
    if (managerId.isBlank()) {
      promise.reject(MANAGER_ERROR, "managerId is required")
      return
    }
    val dimInt = dim.toInt()
    if (dimInt <= 0) {
      promise.reject(MANAGER_ERROR, "dim must be > 0")
      return
    }
    try {
      val result = nativeCreateManager(managerId, dimInt)
      if (result == null || result["success"] as? Boolean != true) {
        val error =
          (result?.get("error") as? String)?.takeIf { it.isNotBlank() }
            ?: "Failed to create speaker embedding manager"
        promise.reject(MANAGER_ERROR, error)
        return
      }
      val out = Arguments.createMap()
      out.putBoolean("success", true)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to create speaker embedding manager", e)
      promise.reject(
        MANAGER_ERROR,
        "Failed to create speaker embedding manager: ${e.message}",
        e,
      )
    }
  }

  fun speakerEmbeddingManagerAdd(
    managerId: String,
    name: String,
    embeddings: ReadableArray,
    count: Double,
    promise: Promise,
  ) {
    val countInt = count.toInt()
    if (countInt <= 0) {
      promise.reject(MANAGER_ERROR, "count must be > 0")
      return
    }
    try {
      val flat = FloatArray(embeddings.size()) { i -> embeddings.getDouble(i).toFloat() }
      val result = nativeManagerAdd(managerId, name, flat, countInt)
      promise.resolve(okMap(result?.get("ok") as? Boolean == true))
    } catch (e: Exception) {
      Log.e(TAG, "speakerEmbeddingManagerAdd failed", e)
      promise.reject(MANAGER_ERROR, "add failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerRemove(
    managerId: String,
    name: String,
    promise: Promise,
  ) {
    try {
      val result = nativeManagerRemove(managerId, name)
      promise.resolve(okMap(result?.get("ok") as? Boolean == true))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "remove failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerSearch(
    managerId: String,
    embedding: ReadableArray,
    threshold: Double,
    promise: Promise,
  ) {
    try {
      val emb = FloatArray(embedding.size()) { i -> embedding.getDouble(i).toFloat() }
      val result = nativeManagerSearch(managerId, emb, threshold.toFloat())
      val out = Arguments.createMap()
      out.putString("name", (result?.get("name") as? String).orEmpty())
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "search failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerVerify(
    managerId: String,
    name: String,
    embedding: ReadableArray,
    threshold: Double,
    promise: Promise,
  ) {
    try {
      val emb = FloatArray(embedding.size()) { i -> embedding.getDouble(i).toFloat() }
      val result = nativeManagerVerify(managerId, name, emb, threshold.toFloat())
      promise.resolve(okMap(result?.get("ok") as? Boolean == true))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "verify failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerContains(
    managerId: String,
    name: String,
    promise: Promise,
  ) {
    try {
      val result = nativeManagerContains(managerId, name)
      promise.resolve(okMap(result?.get("ok") as? Boolean == true))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "contains failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerNumSpeakers(managerId: String, promise: Promise) {
    try {
      promise.resolve(nativeManagerNumSpeakers(managerId))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "numSpeakers failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerAllSpeakerNames(managerId: String, promise: Promise) {
    try {
      val result = nativeManagerAllSpeakerNames(managerId)
      @Suppress("UNCHECKED_CAST")
      val namesList = result?.get("names") as? ArrayList<String> ?: arrayListOf()
      val names = Arguments.createArray()
      for (n in namesList) {
        names.pushString(n)
      }
      val out = Arguments.createMap()
      out.putArray("names", names)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "allSpeakerNames failed: ${e.message}", e)
    }
  }

  fun destroySpeakerEmbeddingManager(managerId: String, promise: Promise) {
    nativeDestroyManager(managerId)
    promise.resolve(null)
  }

  /**
   * Synchronous compute for offline-live workers (worker thread; not Promise/TM).
   */
  fun computeEmbeddingFromSamples(
    instanceId: String,
    samples: FloatArray,
    sampleRate: Int,
  ): FloatArray {
    val result = nativeComputeEmbedding(instanceId, samples, sampleRate)
      ?: throw IllegalStateException("Speaker embedding compute returned null")
    if (result["success"] as? Boolean != true) {
      val code =
        (result["errorCode"] as? String)?.takeIf { it.isNotBlank() } ?: COMPUTE_ERROR
      val error =
        (result["error"] as? String)?.takeIf { it.isNotBlank() }
          ?: "Speaker embedding compute failed"
      throw IllegalStateException("$code: $error")
    }
    val embedding = result["embedding"] as? FloatArray
      ?: throw IllegalStateException("Speaker embedding compute missing embedding")
    return embedding
  }

  /**
   * Synchronous search for offline-live workers (worker thread; not Promise/TM).
   * Returns empty string when no match.
   */
  fun searchSpeaker(
    managerId: String,
    embedding: FloatArray,
    threshold: Float,
  ): String {
    val result = nativeManagerSearch(managerId, embedding, threshold)
    return (result?.get("name") as? String).orEmpty()
  }

  /**
   * Synchronous verify for combined offline verify (worker / Helper; not Promise/TM).
   */
  fun verifySpeaker(
    managerId: String,
    name: String,
    embedding: FloatArray,
    threshold: Float,
  ): Boolean {
    val result = nativeManagerVerify(managerId, name, embedding, threshold)
    return result?.get("ok") as? Boolean == true
  }

  private fun okMap(ok: Boolean): WritableMap {
    val out = Arguments.createMap()
    out.putBoolean("ok", ok)
    return out
  }

  private fun detectResultToWritable(result: HashMap<String, Any>): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("success", result["success"] as? Boolean ?: false)
    map.putBoolean("isStreaming", result["isStreaming"] as? Boolean ?: false)
    val error = result["error"] as? String
    if (!error.isNullOrBlank()) map.putString("error", error)
    val mt = result["modelType"] as? String
    if (!mt.isNullOrBlank()) map.putString("modelType", mt)

    val models = Arguments.createArray()
    @Suppress("UNCHECKED_CAST")
    val detected = result["detectedModels"] as? ArrayList<HashMap<String, String>> ?: arrayListOf()
    for (entry in detected) {
      val m = Arguments.createMap()
      m.putString("type", entry["type"] ?: "")
      m.putString("modelDir", entry["modelDir"] ?: "")
      models.pushMap(m)
    }
    map.putArray("detectedModels", models)

    val languages = result["languages"] as? ArrayList<*>
    if (!languages.isNullOrEmpty()) {
      val arr = Arguments.createArray()
      for (entry in languages) {
        val value = entry as? String
        if (!value.isNullOrBlank()) arr.pushString(value)
      }
      if (arr.size() > 0) map.putArray("languages", arr)
    }

    val quantization = result["quantization"] as? String
    if (!quantization.isNullOrBlank()) map.putString("quantization", quantization)

    val detectionSources = result["detectionSources"] as? ArrayList<*>
    if (!detectionSources.isNullOrEmpty()) {
      val arr = Arguments.createArray()
      for (entry in detectionSources) {
        val value = entry as? String
        if (!value.isNullOrBlank()) arr.pushString(value)
      }
      if (arr.size() > 0) map.putArray("detectionSources", arr)
    }

    @Suppress("UNCHECKED_CAST")
    val paths = result["paths"] as? HashMap<String, Any?>
    if (paths != null) {
      val writablePaths = Arguments.createMap()
      val modelPath = paths["model"] as? String
      if (!modelPath.isNullOrBlank()) writablePaths.putString("model", modelPath)
      if (writablePaths.toHashMap().isNotEmpty()) {
        map.putMap("paths", writablePaths)
      }
    }

    return map
  }

  companion object {
    private const val TAG = "SherpaOnnxSpeakerEmbedding"
    private const val DETECT_ERROR = "SPEAKER_EMBEDDING_DETECT_ERROR"
    private const val INIT_ERROR = "SPEAKER_EMBEDDING_INIT_ERROR"
    private const val COMPUTE_ERROR = "SPEAKER_EMBEDDING_COMPUTE_ERROR"
    private const val MANAGER_ERROR = "SPEAKER_EMBEDDING_MANAGER_ERROR"
    private const val BUFFER_KIND_MISMATCH = "SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH"
    private const val BUFFER_NOT_FOUND = "SPEAKER_EMBEDDING_BUFFER_NOT_FOUND"
    private const val BUFFER_EMPTY = "SPEAKER_EMBEDDING_BUFFER_EMPTY"
    private const val INVALID_ARGUMENT = "SPEAKER_EMBEDDING_INVALID_ARGUMENT"
    private val SUPPORTED_TYPES = setOf("wespeaker", "3d-speaker", "nemo")

    @JvmStatic
    private external fun nativeInitializeExtractorAuto(
      instanceId: String,
      modelDir: String,
      modelType: String,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeInitializeExtractorCustom(
      instanceId: String,
      modelType: String,
      modelPaths: HashMap<String, String>,
      numThreads: Int,
      provider: String?,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeComputeEmbedding(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeUnloadExtractor(instanceId: String)

    @JvmStatic
    private external fun nativeCreateManager(
      managerId: String,
      dim: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerAdd(
      managerId: String,
      name: String,
      embeddings: FloatArray,
      count: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerRemove(
      managerId: String,
      name: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerSearch(
      managerId: String,
      embedding: FloatArray,
      threshold: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerVerify(
      managerId: String,
      name: String,
      embedding: FloatArray,
      threshold: Float,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerContains(
      managerId: String,
      name: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeManagerNumSpeakers(managerId: String): Int

    @JvmStatic
    private external fun nativeManagerAllSpeakerNames(
      managerId: String,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeDestroyManager(managerId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
