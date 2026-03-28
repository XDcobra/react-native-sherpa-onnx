package com.sherpaonnx

import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.DenoisedAudio
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserDpdfNetModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxEnhancementHelper(
  private val context: ReactApplicationContext,
  private val nativeDetectEnhancementModel: (modelDir: String, modelType: String) -> HashMap<String, Any>?
) {
  private data class EnhancementInstance(
    @Volatile var denoiser: OfflineSpeechDenoiser? = null
  ) {
    fun release() {
      denoiser?.release()
      denoiser = null
    }
  }

  private data class OnlineEnhancementInstance(
    @Volatile var denoiser: OnlineSpeechDenoiser? = null
  ) {
    fun release() {
      denoiser?.release()
      denoiser = null
    }
  }

  private val instances = ConcurrentHashMap<String, EnhancementInstance>()
  private val onlineInstances = ConcurrentHashMap<String, OnlineEnhancementInstance>()

  fun shutdown() {
    instances.values.forEach { it.release() }
    instances.clear()
    onlineInstances.values.forEach { it.release() }
    onlineInstances.clear()
  }

  private fun path(map: Map<String, String>, key: String): String = map[key].orEmpty()

  private fun toEnhancedAudioMap(audio: DenoisedAudio): WritableMap {
    val samples = Arguments.createArray()
    for (sample in audio.samples) {
      samples.pushDouble(sample.toDouble())
    }
    val out = Arguments.createMap()
    out.putArray("samples", samples)
    out.putInt("sampleRate", audio.sampleRate)
    return out
  }

  private fun readableArrayToFloatArray(samples: ReadableArray): FloatArray {
    val out = FloatArray(samples.size())
    for (i in 0 until samples.size()) {
      out[i] = samples.getDouble(i).toFloat()
    }
    return out
  }

  private fun copyContentUriToTemp(path: String, prefix: String): Pair<String, File?> {
    if (!path.startsWith("content://")) return Pair(path, null)
    val uri = Uri.parse(path)
    val tmp = File(context.cacheDir, "${prefix}_${System.nanoTime()}.wav")
    context.contentResolver.openInputStream(uri)?.use { input ->
      tmp.outputStream().use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("File is not readable: $path")
    return Pair(tmp.absolutePath, tmp)
  }

  fun detectEnhancementModel(
    modelDir: String,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, modelType ?: "auto")
      if (result == null) {
        promise.reject("DETECT_ERROR", "Enhancement model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", success)
      val modelsArray = Arguments.createArray()
      for (model in detectedModels) {
        val modelMap = model as? HashMap<*, *>
        if (modelMap != null) {
          val entry = Arguments.createMap()
          entry.putString("type", modelMap["type"] as? String ?: "")
          entry.putString("modelDir", modelMap["modelDir"] as? String ?: "")
          modelsArray.pushMap(entry)
        }
      }
      resultMap.putArray("detectedModels", modelsArray)
      if (modelTypeStr != null) {
        resultMap.putString("modelType", modelTypeStr)
      }
      if (!success) {
        val error = result["error"] as? String
        if (!error.isNullOrBlank()) {
          resultMap.putString("error", error)
        }
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxEnhancement", "Enhancement detection failed", e)
      promise.reject("DETECT_ERROR", "Enhancement model detection failed: ${e.message}", e)
    }
  }

  fun initializeEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject("ENHANCEMENT_INIT_ERROR", reason)
        return
      }
      val modelTypeStr = result["modelType"] as? String ?: "gtcrn"
      val paths = (result["paths"] as? Map<*, *>)
        ?.mapValues { (_, v) -> (v as? String).orEmpty() }
        ?.mapKeys { it.key.toString() }
        ?: emptyMap()

      val offlineModelConfig = when (modelTypeStr) {
        "gtcrn" -> OfflineSpeechDenoiserModelConfig(
          gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        "dpdfnet" -> OfflineSpeechDenoiserModelConfig(
          dpdfnet = OfflineSpeechDenoiserDpdfNetModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        else -> {
          promise.reject("ENHANCEMENT_INIT_ERROR", "Unsupported enhancement model type: $modelTypeStr")
          return
        }
      }

      val inst = instances.getOrPut(instanceId) { EnhancementInstance() }
      inst.release()
      val denoiser = OfflineSpeechDenoiser(
        config = OfflineSpeechDenoiserConfig(model = offlineModelConfig)
      )
      inst.denoiser = denoiser

      val modelsArray = Arguments.createArray()
      val detectedModels = result["detectedModels"] as? ArrayList<*>
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putArray("detectedModels", modelsArray)
      out.putString("modelType", modelTypeStr)
      out.putInt("sampleRate", denoiser.sampleRate)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e("SherpaOnnxEnhancement", "Failed to initialize enhancement", e)
      promise.reject("ENHANCEMENT_INIT_ERROR", "Failed to initialize enhancement: ${e.message}", e)
    }
  }

  fun enhanceSamples(
    instanceId: String,
    samples: ReadableArray,
    sampleRate: Double,
    promise: Promise
  ) {
    val inst = instances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ENHANCEMENT_ERROR", "Enhancement instance not found: $instanceId")
      return
    }
    try {
      val audio = denoiser.run(readableArrayToFloatArray(samples), sampleRate.toInt())
      promise.resolve(toEnhancedAudioMap(audio))
    } catch (e: Exception) {
      promise.reject("ENHANCEMENT_ERROR", "Failed to enhance samples: ${e.message}", e)
    }
  }

  fun enhanceFile(
    instanceId: String,
    inputPath: String,
    outputPath: String?,
    promise: Promise
  ) {
    val inst = instances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ENHANCEMENT_ERROR", "Enhancement instance not found: $instanceId")
      return
    }

    var tmpInput: File? = null
    try {
      val (resolvedInputPath, tmp) = copyContentUriToTemp(inputPath, "enhancement_in")
      tmpInput = tmp
      val wave = WaveReader.readWave(resolvedInputPath)
      val audio = denoiser.run(wave.samples, wave.sampleRate)
      if (!outputPath.isNullOrBlank()) {
        audio.save(outputPath)
      }
      promise.resolve(toEnhancedAudioMap(audio))
    } catch (e: Exception) {
      promise.reject("ENHANCEMENT_ERROR", "Failed to enhance file: ${e.message}", e)
    } finally {
      tmpInput?.delete()
    }
  }

  fun getSampleRate(instanceId: String, promise: Promise) {
    val inst = instances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ENHANCEMENT_ERROR", "Enhancement instance not found: $instanceId")
      return
    }
    promise.resolve(denoiser.sampleRate)
  }

  fun unloadEnhancement(instanceId: String, promise: Promise) {
    instances.remove(instanceId)?.release()
    promise.resolve(null)
  }

  fun initializeOnlineEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val result = nativeDetectEnhancementModel(modelDir, modelType ?: "auto")
      if (result == null || result["success"] as? Boolean != true) {
        val reason = result?.get("error") as? String ?: "Failed to detect enhancement model"
        promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", reason)
        return
      }
      val modelTypeStr = result["modelType"] as? String ?: "gtcrn"
      val paths = (result["paths"] as? Map<*, *>)
        ?.mapValues { (_, v) -> (v as? String).orEmpty() }
        ?.mapKeys { it.key.toString() }
        ?: emptyMap()

      val offlineModelConfig = when (modelTypeStr) {
        "gtcrn" -> OfflineSpeechDenoiserModelConfig(
          gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        "dpdfnet" -> OfflineSpeechDenoiserModelConfig(
          dpdfnet = OfflineSpeechDenoiserDpdfNetModelConfig(model = path(paths, "model")),
          numThreads = numThreads?.toInt() ?: 1,
          provider = provider ?: "cpu",
          debug = debug ?: false
        )
        else -> {
          promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", "Unsupported enhancement model type: $modelTypeStr")
          return
        }
      }

      val inst = onlineInstances.getOrPut(instanceId) { OnlineEnhancementInstance() }
      inst.release()
      val denoiser = OnlineSpeechDenoiser(
        config = OnlineSpeechDenoiserConfig(model = offlineModelConfig)
      )
      inst.denoiser = denoiser

      val out = Arguments.createMap()
      out.putBoolean("success", true)
      out.putInt("sampleRate", denoiser.sampleRate)
      out.putInt("frameShiftInSamples", denoiser.frameShiftInSamples)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("ONLINE_ENHANCEMENT_INIT_ERROR", "Failed to initialize online enhancement: ${e.message}", e)
    }
  }

  fun feedSamples(
    instanceId: String,
    samples: ReadableArray,
    sampleRate: Double,
    promise: Promise
  ) {
    val inst = onlineInstances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Online enhancement instance not found: $instanceId")
      return
    }
    try {
      val audio = denoiser.run(readableArrayToFloatArray(samples), sampleRate.toInt())
      promise.resolve(toEnhancedAudioMap(audio))
    } catch (e: Exception) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Failed to feed enhancement samples: ${e.message}", e)
    }
  }

  fun flushOnline(instanceId: String, promise: Promise) {
    val inst = onlineInstances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Online enhancement instance not found: $instanceId")
      return
    }
    try {
      promise.resolve(toEnhancedAudioMap(denoiser.flush()))
    } catch (e: Exception) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Failed to flush online enhancement: ${e.message}", e)
    }
  }

  fun resetOnline(instanceId: String, promise: Promise) {
    val inst = onlineInstances[instanceId]
    val denoiser = inst?.denoiser
    if (denoiser == null) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Online enhancement instance not found: $instanceId")
      return
    }
    try {
      denoiser.reset()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ONLINE_ENHANCEMENT_ERROR", "Failed to reset online enhancement: ${e.message}", e)
    }
  }

  fun unloadOnline(instanceId: String, promise: Promise) {
    onlineInstances.remove(instanceId)?.release()
    promise.resolve(null)
  }
}
