package com.sherpaonnx.speakerembedding.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingManager
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.detect.ModelPathValidationNative
import com.sherpaonnx.speakerembedding.config.SpeakerEmbeddingInitOptionsParser
import com.sherpaonnx.speakerembedding.core.SpeakerEmbeddingExtractorInstance
import com.sherpaonnx.speakerembedding.core.SpeakerEmbeddingManagerInstance
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxSpeakerEmbeddingHelper(
  private val nativeDetectSpeakerEmbeddingModel: (
    modelDir: String?,
    assetName: String?,
    modelType: String,
  ) -> HashMap<String, Any>?,
) {
  private val extractors =
    ConcurrentHashMap<String, SpeakerEmbeddingExtractorInstance>()
  private val managers =
    ConcurrentHashMap<String, SpeakerEmbeddingManagerInstance>()

  fun shutdown() {
    extractors.values.forEach { it.release() }
    extractors.clear()
    managers.values.forEach { it.release() }
    managers.clear()
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
    ModelPathValidationNative.validate(
      "speakerEmbedding",
      modelTypeStr,
      pathStrings,
    )?.let { errorMsg ->
      promise.reject(INIT_ERROR, errorMsg)
      return
    }
    val modelPath = pathStrings["model"].orEmpty()
    if (modelPath.isBlank()) {
      promise.reject(INIT_ERROR, "custom init requires modelPaths.model")
      return
    }
    finishInitializeExtractor(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      modelPath = modelPath,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun initializeExtractorAuto(
    instanceId: String,
    parsed: SpeakerEmbeddingInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val modelDir = parsed.modelDir.orEmpty()
    val result = nativeDetectSpeakerEmbeddingModel(modelDir, null, parsed.modelType)
    if (result == null || result["success"] as? Boolean != true) {
      val reason = result?.get("error") as? String
        ?: "Failed to detect speaker embedding model"
      promise.reject(INIT_ERROR, reason)
      return
    }
    val modelTypeStr = (result["modelType"] as? String)?.trim().orEmpty()
    if (modelTypeStr.isEmpty() || modelTypeStr == "unknown") {
      promise.reject(INIT_ERROR, "Speaker embedding detect did not return a modelType")
      return
    }
    @Suppress("UNCHECKED_CAST")
    val paths = result["paths"] as? HashMap<String, Any?>
    val modelPath = (paths?.get("model") as? String)?.trim().orEmpty()
    if (modelPath.isEmpty()) {
      promise.reject(INIT_ERROR, "Speaker embedding detect did not return paths.model")
      return
    }
    finishInitializeExtractor(
      instanceId = instanceId,
      modelTypeStr = modelTypeStr,
      modelPath = modelPath,
      parsed = parsed,
      promise = promise,
    )
  }

  private fun finishInitializeExtractor(
    instanceId: String,
    modelTypeStr: String,
    modelPath: String,
    parsed: SpeakerEmbeddingInitOptionsParser.Parsed,
    promise: Promise,
  ) {
    val config = SpeakerEmbeddingExtractorConfig(
      model = modelPath,
      numThreads = parsed.numThreads.toInt().coerceAtLeast(1),
      debug = parsed.debug,
      provider = parsed.provider?.takeIf { it.isNotBlank() } ?: "cpu",
    )
    val inst = extractors.getOrPut(instanceId) { SpeakerEmbeddingExtractorInstance() }
    inst.release()
    val extractor = SpeakerEmbeddingExtractor(assetManager = null, config = config)
    val dim = extractor.dim()
    if (dim <= 0) {
      extractor.release()
      promise.reject(INIT_ERROR, "Speaker embedding extractor returned invalid dim=$dim")
      return
    }
    inst.extractor = extractor
    inst.dim = dim

    val out = Arguments.createMap()
    out.putBoolean("success", true)
    out.putInt("dim", dim)
    out.putString("modelType", modelTypeStr)
    promise.resolve(out)
  }

  fun computeSpeakerEmbeddingOffline(
    instanceId: String,
    audioBufferId: String,
    promise: Promise,
  ) {
    val extractor = extractors[instanceId]?.extractor
    if (extractor == null) {
      promise.reject(COMPUTE_ERROR, "Speaker embedding extractor not found: $instanceId")
      return
    }
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
    try {
      val inputSamples = audioInEntry.readAllSamples()
      val stream = extractor.createStream()
      try {
        stream.acceptWaveform(inputSamples, audioInEntry.sampleRate)
        stream.inputFinished()
        if (!extractor.isReady(stream)) {
          promise.reject(COMPUTE_ERROR, "Speaker embedding extractor is not ready")
          return
        }
        val embedding = extractor.compute(stream)
        val arr = Arguments.createArray()
        for (v in embedding) {
          arr.pushDouble(v.toDouble())
        }
        val out = Arguments.createMap()
        out.putArray("embedding", arr)
        promise.resolve(out)
      } finally {
        stream.release()
      }
    } catch (e: Exception) {
      Log.e(TAG, "Speaker embedding compute failed", e)
      promise.reject(COMPUTE_ERROR, "Speaker embedding compute failed: ${e.message}", e)
    }
  }

  fun unloadSpeakerEmbeddingExtractor(instanceId: String, promise: Promise) {
    extractors.remove(instanceId)?.release()
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
      val inst = managers.getOrPut(managerId) { SpeakerEmbeddingManagerInstance() }
      inst.release()
      inst.manager = SpeakerEmbeddingManager(dimInt)
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
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    val dim = manager.dim
    val countInt = count.toInt()
    if (countInt <= 0) {
      promise.reject(MANAGER_ERROR, "count must be > 0")
      return
    }
    if (embeddings.size() != countInt * dim) {
      promise.reject(
        MANAGER_ERROR,
        "embeddings length ${embeddings.size()} does not match count*dim=${countInt * dim}",
      )
      return
    }
    try {
      val list = Array(countInt) { i ->
        FloatArray(dim) { j ->
          embeddings.getDouble(i * dim + j).toFloat()
        }
      }
      val ok = if (countInt == 1) {
        manager.add(name, list[0])
      } else {
        manager.add(name, list)
      }
      promise.resolve(okMap(ok))
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
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      promise.resolve(okMap(manager.remove(name)))
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
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      val emb = readableArrayToFloatArray(embedding, manager.dim)
      val name = manager.search(emb, threshold.toFloat())
      val out = Arguments.createMap()
      out.putString("name", name ?: "")
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
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      val emb = readableArrayToFloatArray(embedding, manager.dim)
      promise.resolve(okMap(manager.verify(name, emb, threshold.toFloat())))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "verify failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerContains(
    managerId: String,
    name: String,
    promise: Promise,
  ) {
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      promise.resolve(okMap(manager.contains(name)))
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "contains failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerNumSpeakers(managerId: String, promise: Promise) {
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      promise.resolve(manager.numSpeakers())
    } catch (e: Exception) {
      promise.reject(MANAGER_ERROR, "numSpeakers failed: ${e.message}", e)
    }
  }

  fun speakerEmbeddingManagerAllSpeakerNames(managerId: String, promise: Promise) {
    val manager = managers[managerId]?.manager
    if (manager == null) {
      promise.reject(MANAGER_ERROR, "Speaker embedding manager not found: $managerId")
      return
    }
    try {
      val names = Arguments.createArray()
      for (n in manager.allSpeakerNames()) {
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
    managers.remove(managerId)?.release()
    promise.resolve(null)
  }

  private fun readableArrayToFloatArray(arr: ReadableArray, dim: Int): FloatArray {
    if (arr.size() != dim) {
      throw IllegalArgumentException(
        "embedding length ${arr.size()} does not match manager dim $dim",
      )
    }
    return FloatArray(dim) { i -> arr.getDouble(i).toFloat() }
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
    private val SUPPORTED_TYPES = setOf("wespeaker", "3d-speaker", "nemo")
  }
}
