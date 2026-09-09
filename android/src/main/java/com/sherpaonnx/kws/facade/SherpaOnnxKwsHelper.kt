package com.sherpaonnx.kws.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.util.concurrent.ConcurrentHashMap

internal class SherpaOnnxKwsHelper {
  private val instances = ConcurrentHashMap<String, KeywordSpotter>()

  fun initializeKeywordSpotting(
    instanceId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (instanceId.isBlank()) {
      promise.reject(ERROR_INIT, "instanceId is required")
      return
    }

    val paths = listOf("encoder", "decoder", "joiner", "tokens", "keywords")
      .associateWith { key ->
        if (options.hasKey(key) && !options.isNull(key)) {
          options.getString(key)?.trim().orEmpty()
        } else {
          ""
        }
      }
    val missing = paths.filterValues { it.isEmpty() }.keys
    if (missing.isNotEmpty()) {
      promise.reject(ERROR_INIT, "Missing required KWS paths: ${missing.joinToString(", ")}")
      return
    }

    if (instances.containsKey(instanceId)) {
      promise.reject(ERROR_INIT, "Keyword spotting instance already exists: $instanceId")
      return
    }

    try {
      val modelConfig = OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = paths.getValue("encoder"),
          decoder = paths.getValue("decoder"),
          joiner = paths.getValue("joiner"),
        ),
        tokens = paths.getValue("tokens"),
        numThreads = optionInt(options, "numThreads", 1).coerceAtLeast(1),
        debug = optionBoolean(options, "debug", false),
        provider = optionString(options, "provider", "cpu"),
        modelType = "zipformer2",
      )
      val config = KeywordSpotterConfig(
        featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
        modelConfig = modelConfig,
        maxActivePaths = optionInt(options, "maxActivePaths", 4),
        keywordsFile = paths.getValue("keywords"),
        keywordsScore = optionFloat(options, "keywordsScore", 1.5f),
        keywordsThreshold = optionFloat(options, "keywordsThreshold", 0.25f),
        numTrailingBlanks = optionInt(options, "numTrailingBlanks", 2),
      )
      val spotter = KeywordSpotter(assetManager = null, config = config)
      val existing = instances.putIfAbsent(instanceId, spotter)
      if (existing != null) {
        spotter.release()
        promise.reject(ERROR_INIT, "Keyword spotting instance already exists: $instanceId")
        return
      }

      Log.i(TAG, "$PREFIX initialized instanceId=$instanceId")
      promise.resolve(Arguments.createMap().apply { putBoolean("success", true) })
    } catch (e: Exception) {
      Log.e(TAG, "$PREFIX initialize failed instanceId=$instanceId: ${e.message}", e)
      promise.reject(ERROR_INIT, "Keyword spotting init failed: ${e.message}", e)
    }
  }

  fun unloadKeywordSpotting(instanceId: String, promise: Promise) {
    try {
      val spotter = instances.remove(instanceId)
      spotter?.release()
      Log.i(TAG, "$PREFIX unloaded instanceId=$instanceId found=${spotter != null}")
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "$PREFIX unload failed instanceId=$instanceId: ${e.message}", e)
      promise.reject(ERROR_INTERNAL, "Keyword spotting unload failed: ${e.message}", e)
    }
  }

  fun shutdown() {
    instances.keys.toList().forEach { instanceId ->
      try {
        instances.remove(instanceId)?.release()
      } catch (e: Exception) {
        Log.w(TAG, "$PREFIX shutdown release failed instanceId=$instanceId: ${e.message}")
      }
    }
  }

  private fun optionString(options: ReadableMap, key: String, fallback: String): String =
    if (options.hasKey(key) && !options.isNull(key)) {
      options.getString(key)?.trim().orEmpty().ifEmpty { fallback }
    } else {
      fallback
    }

  private fun optionInt(options: ReadableMap, key: String, fallback: Int): Int =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key).toInt() else fallback

  private fun optionFloat(options: ReadableMap, key: String, fallback: Float): Float =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key).toFloat() else fallback

  private fun optionBoolean(options: ReadableMap, key: String, fallback: Boolean): Boolean =
    if (options.hasKey(key) && !options.isNull(key)) options.getBoolean(key) else fallback

  companion object {
    private const val TAG = "SherpaOnnxKws"
    private const val PREFIX = "[SherpaOnnx:kws]"
    private const val ERROR_INIT = "KWS_INIT_FAILED"
    private const val ERROR_INTERNAL = "KWS_INTERNAL_ERROR"
  }
}
