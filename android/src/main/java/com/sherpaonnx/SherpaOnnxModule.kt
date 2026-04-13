package com.sherpaonnx

import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.k2fsa.sherpa.onnx.WaveReader
import com.sherpaonnx.pcm.PcmPlayerService
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.stt.SttErrorCodes
import com.sherpaonnx.tts.core.SherpaOnnxTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxCommonTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOfflineTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOnlineTtsHelper
import java.io.File
import java.util.Locale

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  init {
    // Load onnxruntime first so libsherpa-onnx-jni.so can resolve OrtGetApiBase.
    // When the app adds com.xdcobra.sherpa:onnxruntime and uses pickFirst, this loads the AAR's version.
    try {
      System.loadLibrary("onnxruntime")
    } catch (e: UnsatisfiedLinkError) {
      android.util.Log.w(NAME, "onnxruntime not loaded (will use SDK copy if present): ${e.message}")
    }
    // Load sherpa-onnx JNI (from AAR; required for Kotlin API: OfflineRecognizer, OfflineTts, etc.)
    try {
      System.loadLibrary("sherpa-onnx-jni")
    } catch (e: UnsatisfiedLinkError) {
      throw RuntimeException("Failed to load sherpa-onnx-jni (from sherpa-onnx AAR): ${e.message}", e)
    }
    // Load sherpa-onnx C-API (from AAR; needed at runtime only if Zipvoice TTS is used).
    // Non-fatal: if the .so is missing, Zipvoice init will fail with a clear error later.
    try {
      System.loadLibrary("sherpa-onnx-c-api")
    } catch (e: UnsatisfiedLinkError) {
      android.util.Log.w("SherpaOnnx", "sherpa-onnx-c-api not available — Zipvoice TTS will not work: ${e.message}")
    }
    // Then load our library (Archive, FFmpeg, model detection, Zipvoice JNI wrapper)
    System.loadLibrary("sherpaonnx")
    instance = this
  }

  private val assetHelper = SherpaOnnxAssetHelper(reactApplicationContext, NAME)
  private val sttHelper = SherpaOnnxSttHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType, preferInt8, hasPreferInt8, debug ->
      Companion.nativeDetectSttModel(modelDir, assetName, modelType, preferInt8, hasPreferInt8, debug)
    },
    NAME
  )
  private val onlineSttHelper = SherpaOnnxOnlineSttHelper(reactApplicationContext, NAME)
  private val pcmPlayerService = PcmPlayerService()
  private val ttsHelper = SherpaOnnxTtsHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType -> Companion.nativeDetectTtsModel(modelDir, assetName, modelType) },
  )
  private val offlineTtsHelper = SherpaOnnxOfflineTtsHelper(ttsHelper)
  private val onlineTtsHelper = SherpaOnnxOnlineTtsHelper(ttsHelper)
  private val commonTtsHelper = SherpaOnnxCommonTtsHelper(ttsHelper)
  private val filesHelper = SherpaOnnxFilesHelper(reactApplicationContext)
  private val alignmentHelper = SherpaOnnxAlignmentHelper()
  private val enhancementHelper = SherpaOnnxEnhancementHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType -> Companion.nativeDetectEnhancementModel(modelDir, assetName, modelType) }
  )
  private val archiveHelper = SherpaOnnxArchiveHelper()
  private var micToLiveSink: com.sherpaonnx.audio.pipeline.MicToLiveBufferSink? = null

  private fun emitPipelineLiveAudioChunk(event: com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("liveBufferId", event.liveBufferId)
    payload.putString("source", event.source)
    payload.putInt("sampleRate", event.sampleRate)
    payload.putInt("frameCount", event.frameCount)
    payload.putDouble("totalSamplesWritten", event.totalSamplesWritten.toDouble())
    event.samples?.let { samples ->
      val arr = Arguments.createArray()
      for (s in samples) arr.pushDouble(s.toDouble())
      payload.putArray("samples", arr)
    }
    eventEmitter.emit("pipelineLiveAudioChunk", payload)
  }

  override fun getName(): String {
    return NAME
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    micToLiveSink?.stop()
    micToLiveSink = null
    onlineSttHelper.shutdown()
    commonTtsHelper.shutdown()
    alignmentHelper.shutdown()
    enhancementHelper.shutdown()
    pcmPlayerService.shutdown()
  }

  /**
   * Test method to verify sherpa-onnx native library is loaded.
   * This is a minimal "Hello World" test for Phase 1.
   */
  override fun testSherpaInit(promise: Promise) {
    try {
      val result = nativeTestSherpaInit()
      promise.resolve(result)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "INIT_ERROR: Failed to test sherpa-onnx initialization", e)
      promise.reject("INIT_ERROR", "Failed to test sherpa-onnx initialization", e)
    }
  }

  /** Asset path for embedded QNN test model (ORT testdata: qnn_multi_ctx_embed). */
  private val qnnTestModelAsset = "testModels/qnn_multi_ctx_embed.onnx"

  /**
   * QNN support (AccelerationSupport): providerCompiled, hasAccelerator (native HTP init), canInit (session test).
   * If modelBase64 is not provided, uses embedded test model from assets for canInit (same pattern as NNAPI/XNNPACK).
   */
  override fun getQnnSupport(modelBase64: String?, promise: Promise) {
    try {
      val providers = ai.onnxruntime.OrtEnvironment.getAvailableProviders()
      val providerCompiled = providers.any { it.name.contains("QNN", ignoreCase = true) }
      val hasAccelerator = try { nativeCanInitQnnHtp() } catch (_: Exception) { false }
      val modelSource = if (!modelBase64.isNullOrEmpty()) "user-provided modelBase64" else "embedded test model"
      val modelBytes = when {
        !modelBase64.isNullOrEmpty() -> try {
          android.util.Base64.decode(modelBase64, android.util.Base64.DEFAULT)
        } catch (_: Exception) { null }
        else -> loadTestModelFromAssets(qnnTestModelAsset)
      }
      val canInit = providerCompiled && modelBytes != null && canReallyUseQnn(modelBytes)
      val map = Arguments.createMap()
      map.putBoolean("providerCompiled", providerCompiled)
      map.putBoolean("hasAccelerator", hasAccelerator)
      map.putBoolean("canInit", canInit)
      android.util.Log.i(NAME, "QNN support: providerCompiled=$providerCompiled hasAccelerator=$hasAccelerator canInit=$canInit (canInit test: $modelSource)")
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "getQnnSupport failed", e)
      promise.reject("QNN_SUPPORT_ERROR", "Failed to get QNN support: ${e.message}", e)
    }
  }

  private fun canReallyUseQnn(modelBytes: ByteArray): Boolean {
    if (modelBytes.isEmpty()) return false
    return try {
      ai.onnxruntime.OrtSession.SessionOptions().use { opts ->
        opts.addQnn(emptyMap())
        ai.onnxruntime.OrtEnvironment.getEnvironment().createSession(modelBytes, opts).use { }
      }
      true
    } catch (_: Throwable) {
      false
    }
  }

  override fun getAvailableProviders(promise: Promise) {
    try {
      val providers = ai.onnxruntime.OrtEnvironment.getAvailableProviders()
      val list = Arguments.createArray()
      for (p in providers) {
        list.pushString(p.name)
      }
      promise.resolve(list)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "getAvailableProviders failed", e)
      promise.reject("PROVIDERS_ERROR", "Failed to get available providers: ${e.message}", e)
    }
  }

  override fun getDeviceQnnSoc(promise: Promise) {
    try {
      var soc: String? = null
      if (android.os.Build.VERSION.SDK_INT >= 31) {
        val buildClass = Class.forName("android.os.Build")
        val field = buildClass.getDeclaredField("SOC_MODEL")
        val value = field.get(null) as? String
        soc = value?.trim()?.takeIf { it.isNotEmpty() }
      }
      val isSupported = soc != null && soc.matches(Regex("^SM8\\d{3}$", RegexOption.IGNORE_CASE))
      val map = Arguments.createMap()
      map.putString("soc", soc)
      map.putBoolean("isSupported", isSupported)
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.w(NAME, "getDeviceQnnSoc: ${e.message}")
      val map = Arguments.createMap()
      map.putNull("soc")
      map.putBoolean("isSupported", false)
      promise.resolve(map)
    }
  }

  /** Asset path for embedded NNAPI test model (ORT testdata: nnapi_internal_uint8_support). */
  private val nnapiTestModelAsset = "testModels/nnapi_internal_uint8_support.onnx"

  /**
   * NNAPI support (AccelerationSupport): providerCompiled, hasAccelerator (native), canInit (session test).
   * If modelBase64 is not provided, uses embedded test model from assets for canInit.
   */
  override fun getNnapiSupport(modelBase64: String?, promise: Promise) {
    try {
      val providers = ai.onnxruntime.OrtEnvironment.getAvailableProviders()
      val providerCompiled = providers.any { it.name.contains("NNAPI", ignoreCase = true) }
      val hasAccelerator = try { nativeHasNnapiAccelerator(android.os.Build.VERSION.SDK_INT) } catch (_: Exception) { false }
      val modelSource = if (!modelBase64.isNullOrEmpty()) "user-provided modelBase64" else "embedded test model"
      val modelBytes = when {
        !modelBase64.isNullOrEmpty() -> try {
          android.util.Base64.decode(modelBase64, android.util.Base64.DEFAULT)
        } catch (_: Exception) { null }
        else -> loadTestModelFromAssets(nnapiTestModelAsset)
      }
      val canInit = providerCompiled && modelBytes != null && canReallyUseNnapi(modelBytes)
      val map = Arguments.createMap()
      map.putBoolean("providerCompiled", providerCompiled)
      map.putBoolean("hasAccelerator", hasAccelerator)
      map.putBoolean("canInit", canInit)
      android.util.Log.i(NAME, "NNAPI support: providerCompiled=$providerCompiled hasAccelerator=$hasAccelerator canInit=$canInit (canInit test: $modelSource)")
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "getNnapiSupport failed", e)
      promise.reject("NNAPI_SUPPORT_ERROR", "Failed to get NNAPI support: ${e.message}", e)
    }
  }

  private fun canReallyUseNnapi(modelBytes: ByteArray): Boolean {
    if (modelBytes.isEmpty()) return false
    return try {
      ai.onnxruntime.OrtSession.SessionOptions().use { opts ->
        opts.addNnapi()
        ai.onnxruntime.OrtEnvironment.getEnvironment().createSession(modelBytes, opts).use { }
      }
      true
    } catch (_: Throwable) {
      false
    }
  }

  /** Asset path for embedded XNNPACK test model (ORT testdata: add_mul_add). */
  private val xnnpackTestModelAsset = "testModels/add_mul_add.onnx"

  /**
   * XNNPACK support (AccelerationSupport): providerCompiled, hasAccelerator = true when compiled (CPU-optimized), canInit (session test).
   * If modelBase64 is not provided, uses embedded test model from assets for canInit.
   */
  override fun getXnnpackSupport(modelBase64: String?, promise: Promise) {
    try {
      val providers = ai.onnxruntime.OrtEnvironment.getAvailableProviders()
      val providerCompiled = providers.any { it.name.contains("XNNPACK", ignoreCase = true) }
      val modelSource = if (!modelBase64.isNullOrEmpty()) "user-provided modelBase64" else "embedded test model"
      val modelBytes = when {
        !modelBase64.isNullOrEmpty() -> try {
          android.util.Base64.decode(modelBase64, android.util.Base64.DEFAULT)
        } catch (_: Exception) { null }
        else -> loadTestModelFromAssets(xnnpackTestModelAsset)
      }
      val canInit = providerCompiled && modelBytes != null && canReallyUseXnnpack(modelBytes)
      val hasAccelerator = providerCompiled // XNNPACK: CPU-optimized
      val map = Arguments.createMap()
      map.putBoolean("providerCompiled", providerCompiled)
      map.putBoolean("hasAccelerator", hasAccelerator)
      map.putBoolean("canInit", canInit)
      android.util.Log.i(NAME, "XNNPACK support: providerCompiled=$providerCompiled hasAccelerator=$hasAccelerator canInit=$canInit (canInit test: $modelSource)")
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "getXnnpackSupport failed", e)
      promise.reject("XNNPACK_SUPPORT_ERROR", "Failed to get XNNPACK support: ${e.message}", e)
    }
  }

  /**
   * Load embedded ONNX test model from module assets (used for NNAPI/XNNPACK canInit when no modelBase64 is passed).
   */
  private fun loadTestModelFromAssets(assetPath: String): ByteArray? {
    return try {
      reactApplicationContext.assets.open(assetPath).use { it.readBytes() }
    } catch (e: Exception) {
      android.util.Log.w(NAME, "Could not load test model from assets: $assetPath", e)
      null
    }
  }

  private fun canReallyUseXnnpack(modelBytes: ByteArray): Boolean {
    if (modelBytes.isEmpty()) return false
    return try {
      ai.onnxruntime.OrtSession.SessionOptions().use { opts ->
        opts.addXnnpack(emptyMap())
        ai.onnxruntime.OrtEnvironment.getEnvironment().createSession(modelBytes, opts).use { }
      }
      true
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Core ML support (AccelerationSupport). Android: always false (Core ML is iOS-only).
   */
  override fun getCoreMlSupport(modelBase64: String?, promise: Promise) {
    try {
      val map = Arguments.createMap()
      map.putBoolean("providerCompiled", false)
      map.putBoolean("hasAccelerator", false)
      map.putBoolean("canInit", false)
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "getCoreMlSupport failed", e)
      promise.reject("COREML_SUPPORT_ERROR", "Failed to get Core ML support: ${e.message}", e)
    }
  }

  /**
   * Resolve model path based on configuration.
   * Handles asset paths, file system paths, and auto-detection.
   */
  override fun resolveModelPath(config: ReadableMap, promise: Promise) {
    assetHelper.resolveModelPath(config, promise)
  }

  override fun extractArchive(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    skipEntries: Double,
    operationId: String,
    showNotificationsEnabled: Boolean?,
    notificationTitle: String?,
    notificationText: String?,
    promise: Promise,
  ) {
    val notif = extractionNotificationOrNull(
      showNotificationsEnabled,
      notificationTitle,
      notificationText,
    )
    archiveHelper.extract(
      sourcePath,
      targetPath,
      force,
      skipEntries.toInt(),
      operationId,
      promise,
      { bytes, total, percent, entryIndex ->
        emitExtractProgress(operationId, sourcePath, bytes, total, percent, entryIndex)
      },
      notif,
    )
  }

  override fun cancelExtraction(operationId: String, promise: Promise) {
    archiveHelper.cancelOperation(operationId)
    promise.resolve(null)
  }

  override fun computeFileSha256(filePath: String, promise: Promise) {
    archiveHelper.computeFileSha256(filePath, promise)
  }

  private fun emitExtractProgress(
    operationId: String,
    sourcePath: String,
    bytes: Long,
    totalBytes: Long,
    percent: Double,
    entryIndex: Int,
  ) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("operationId", operationId)
    payload.putString("sourcePath", sourcePath)
    payload.putDouble("bytes", bytes.toDouble())
    payload.putDouble("totalBytes", totalBytes.toDouble())
    payload.putDouble("percent", percent)
    payload.putInt("entryIndex", entryIndex)
    eventEmitter.emit("extractArchiveProgress", payload)
  }

  /** Null when extraction notifications are disabled (`showNotificationsEnabled == false`). */
  private fun extractionNotificationOrNull(
    showNotificationsEnabled: Boolean?,
    notificationTitle: String?,
    notificationText: String?,
  ): SherpaOnnxExtractionNotificationHelper? {
    return SherpaOnnxExtractionNotificationHelper.maybeCreate(
      reactApplicationContext,
      showNotificationsEnabled,
      notificationTitle,
      notificationText,
    )
  }

  /**
   * Resolve asset path - copy from assets to internal storage if needed
   * Preserves the directory structure from assets (e.g., test_wavs/ stays as test_wavs/)
   */

  /**
   * Detect STT model type and structure without initializing the recognizer.
   */
  override fun detectSttModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    preferInt8: Boolean?,
    debug: Boolean?,
    promise: Promise
  ) {
    try {
      val result = Companion.nativeDetectSttModel(
        modelDir,
        assetName,
        modelType ?: "auto",
        preferInt8 ?: false,
        preferInt8 != null,
        debug ?: false
      )
      if (result == null) {
        android.util.Log.e(NAME, "DETECT_ERROR: STT model detection returned null")
        promise.reject("DETECT_ERROR", "STT model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val isHardwareSpecificUnsupported = result["isHardwareSpecificUnsupported"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String
      val detectionSources = result["detectionSources"] as? ArrayList<*>
      val languages = result["languages"] as? ArrayList<*>
      val quantization = result["quantization"] as? String
      val error = result["error"] as? String

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", success)
      resultMap.putBoolean("isHardwareSpecificUnsupported", isHardwareSpecificUnsupported)
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
      if (!error.isNullOrBlank()) {
        resultMap.putString("error", error)
      }
      if (detectionSources != null && detectionSources.isNotEmpty()) {
        val sourceArray = Arguments.createArray()
        for (source in detectionSources) {
          if (source is String && source.isNotBlank()) {
            sourceArray.pushString(source)
          }
        }
        resultMap.putArray("detectionSources", sourceArray)
      }
      if (languages != null && languages.isNotEmpty()) {
        val languagesArray = Arguments.createArray()
        for (lang in languages) {
          if (lang is String && lang.isNotBlank()) {
            languagesArray.pushString(lang)
          }
        }
        resultMap.putArray("languages", languagesArray)
      }
      if (!quantization.isNullOrBlank()) {
        resultMap.putString("quantization", quantization)
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "DETECT_ERROR: STT model detection failed: ${e.message}", e)
      promise.reject("DETECT_ERROR", "STT model detection failed: ${e.message}", e)
    }
  }

  /**
   * Initialize Speech-to-Text (STT) with model directory.
   */
  override fun initializeStt(
    instanceId: String,
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    hotwordsFile: String?,
    hotwordsScore: Double?,
    numThreads: Double?,
    provider: String?,
    ruleFsts: String?,
    ruleFars: String?,
    dither: Double?,
    modelOptions: ReadableMap?,
    modelingUnit: String?,
    bpeVocab: String?,
    promise: Promise
  ) {
    sttHelper.initializeStt(instanceId, modelDir, preferInt8, modelType, debug, hotwordsFile, hotwordsScore, numThreads, provider, ruleFsts, ruleFars, dither, modelOptions, modelingUnit, bpeVocab, promise)
  }

  /**
   * Release STT resources.
   */
  override fun unloadStt(instanceId: String, promise: Promise) {
    sttHelper.unloadStt(instanceId, promise)
  }

  // ==================== Online (streaming) STT Methods ====================

  override fun initializeOnlineSttWithOptions(instanceId: String, options: ReadableMap, promise: Promise) {
    val modelDir = options.getString("modelDir")
    if (modelDir.isNullOrEmpty()) {
      promise.reject("INIT_ERROR", "modelDir is required")
      return
    }
    val modelType = options.getString("modelType") ?: "transducer"
    val enableEndpoint = if (options.hasKey("enableEndpoint")) options.getBoolean("enableEndpoint") else true
    val decodingMethod = options.getString("decodingMethod") ?: "greedy_search"
    val maxActivePaths = if (options.hasKey("maxActivePaths")) options.getDouble("maxActivePaths").toInt() else 4
    val hotwordsFile = if (options.hasKey("hotwordsFile")) options.getString("hotwordsFile") else null
    val hotwordsScore = if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore") else null
    val numThreads = if (options.hasKey("numThreads")) options.getDouble("numThreads") else null
    val provider = if (options.hasKey("provider")) options.getString("provider") else null
    val ruleFsts = if (options.hasKey("ruleFsts")) options.getString("ruleFsts") else null
    val ruleFars = if (options.hasKey("ruleFars")) options.getString("ruleFars") else null
    val dither = if (options.hasKey("dither")) options.getDouble("dither") else null
    val blankPenalty = if (options.hasKey("blankPenalty")) options.getDouble("blankPenalty") else null
    val debug = if (options.hasKey("debug")) options.getBoolean("debug") else null
    val rule1MustContainNonSilence = if (options.hasKey("rule1MustContainNonSilence")) options.getBoolean("rule1MustContainNonSilence") else null
    val rule1MinTrailingSilence = if (options.hasKey("rule1MinTrailingSilence")) options.getDouble("rule1MinTrailingSilence") else null
    val rule1MinUtteranceLength = if (options.hasKey("rule1MinUtteranceLength")) options.getDouble("rule1MinUtteranceLength") else null
    val rule2MustContainNonSilence = if (options.hasKey("rule2MustContainNonSilence")) options.getBoolean("rule2MustContainNonSilence") else null
    val rule2MinTrailingSilence = if (options.hasKey("rule2MinTrailingSilence")) options.getDouble("rule2MinTrailingSilence") else null
    val rule2MinUtteranceLength = if (options.hasKey("rule2MinUtteranceLength")) options.getDouble("rule2MinUtteranceLength") else null
    val rule3MustContainNonSilence = if (options.hasKey("rule3MustContainNonSilence")) options.getBoolean("rule3MustContainNonSilence") else null
    val rule3MinTrailingSilence = if (options.hasKey("rule3MinTrailingSilence")) options.getDouble("rule3MinTrailingSilence") else null
    val rule3MinUtteranceLength = if (options.hasKey("rule3MinUtteranceLength")) options.getDouble("rule3MinUtteranceLength") else null
    onlineSttHelper.initializeOnlineStt(
      instanceId,
      modelDir,
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
      rule3MinUtteranceLength,
      promise
    )
  }

  override fun unloadOnlineStt(instanceId: String, promise: Promise) {
    onlineSttHelper.unloadOnlineStt(instanceId, promise)
  }

  override fun startSttPipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    chunkSize: Double?,
    promise: Promise
  ) {
    onlineSttHelper.startSttPipeline(
      instanceId = instanceId,
      audioInLiveBufferId = audioInLiveBufferId,
      textOutLiveBufferId = textOutLiveBufferId,
      chunkSize = chunkSize?.toInt(),
      promise = promise,
    )
  }

  // ==================== Pipeline Audio Buffers ====================

  override fun createOfflineAudioBufferFromFile(sourcePath: String, targetSampleRateHz: Double?, forceMono: Boolean?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createOfflineFromFile(
        sourcePath,
        targetSampleRateHz?.toInt(),
        forceMono
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createOfflineAudioBufferFromSamples(samples: ReadableArray, sampleRate: Double, channelCount: Double?, promise: Promise) {
    try {
      val floats = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.readableArrayToFloatArray(samples)
      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createOfflineFromSamples(
        floats,
        sampleRate.toInt(),
        channelCount?.toInt() ?: 1
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createOfflineAudioBufferFromLive(liveBufferId: String, mode: String?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createOfflineFromLive(
        liveBufferId,
        mode ?: "fullIfSpooled"
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createEmptyOfflineAudioBuffer(sampleRate: Double, channelCount: Double?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createEmptyOffline(
        sampleRate.toInt(),
        channelCount?.toInt() ?: 1
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createLiveAudioBuffer(options: ReadableMap, promise: Promise) {
    try {
      val sampleRate = options.getDouble("sampleRate").toInt()
      val channelCount = if (options.hasKey("channelCount")) options.getDouble("channelCount").toInt() else 1
      val windowSeconds = if (options.hasKey("windowSeconds")) options.getDouble("windowSeconds") else 60.0

      val emitAppendedEvents =
        options.hasKey("emitAppendedEvents") && !options.isNull("emitAppendedEvents") && options.getBoolean("emitAppendedEvents")
      val emitAppendedSamples =
        !options.hasKey("emitAppendedSamples") || options.isNull("emitAppendedSamples") || options.getBoolean("emitAppendedSamples")
      val appendEventMinIntervalMs =
        if (options.hasKey("appendEventMinIntervalMs") && !options.isNull("appendEventMinIntervalMs")) {
          options.getDouble("appendEventMinIntervalMs").toInt().coerceAtLeast(0)
        } else {
          0
        }

      val persistence = if (options.hasKey("persistencePath")) {
        val path = options.getString("persistencePath") ?: throw IllegalArgumentException("persistencePath must be a string")
        val formatStr = if (options.hasKey("persistenceFormat")) options.getString("persistenceFormat") else "wav_pcm_s16le"
        val format = when (formatStr) {
          "wav_pcm_float" -> com.sherpaonnx.audio.pipeline.SpoolFormat.WAV_PCM_FLOAT
          else -> com.sherpaonnx.audio.pipeline.SpoolFormat.WAV_PCM_S16LE
        }
        com.sherpaonnx.audio.pipeline.PersistenceConfig(path, format)
      } else null

      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createLive(
        sampleRate = sampleRate,
        channelCount = channelCount,
        windowSeconds = windowSeconds,
        persistence = persistence,
        appendEventConfig = com.sherpaonnx.audio.pipeline.LiveAppendEventConfig(
          enabled = emitAppendedEvents,
          includeSamples = emitAppendedSamples,
          minIntervalMs = appendEventMinIntervalMs,
        ),
        onFramesAppended = { event ->
          emitPipelineLiveAudioChunk(event)
        },
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun appendSamplesToLiveAudioBuffer(liveBufferId: String, samples: ReadableArray, sampleRate: Double, promise: Promise) {
    try {
      val floats = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.readableArrayToFloatArray(samples)
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.appendSamplesToLive(
        liveBufferId,
        floats,
        sampleRate.toInt(),
        com.sherpaonnx.audio.pipeline.LIVE_APPEND_SOURCE_APPEND,
      )
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.ALREADY_FINALIZED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun appendOfflineToLiveAudioBuffer(liveBufferId: String, offlineBufferId: String, promise: Promise) {
    try {
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.appendOfflineToLive(liveBufferId, offlineBufferId)
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.ALREADY_FINALIZED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun finalizeLiveAudioBuffer(liveBufferId: String, promise: Promise) {
    try {
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.finalizeLive(liveBufferId)
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun convertPipelineAudioBufferToFormat(
    bufferId: String,
    outputPath: String,
    format: String,
    outputSampleRateHz: Double?,
    promise: Promise
  ) {
    val rate = outputSampleRateHz?.toInt() ?: 0

    // Format validation
    val supportedFormats = setOf("wav", "mp3", "flac", "aac", "m4a", "opus", "webm", "mkv", "ogg")
    if (!supportedFormats.contains(format.lowercase())) {
      promise.reject("CONVERSION_UNSUPPORTED_FORMAT", "Unsupported format: $format")
      return
    }
    // Sample-rate validation
    if (rate < 0) {
      promise.reject("CONVERSION_INVALID_SAMPLE_RATE", "outputSampleRateHz must be >= 0")
      return
    }
    val fmt = format.lowercase()
    if (fmt == "mp3" && rate != 0 && rate != 32000 && rate != 44100 && rate != 48000) {
      promise.reject("CONVERSION_INVALID_SAMPLE_RATE", "MP3 output sample rate must be 32000, 44100, 48000, or 0. Received: $rate")
      return
    }
    if ((fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") && rate != 0 && rate !in setOf(8000, 12000, 16000, 24000, 48000)) {
      promise.reject("CONVERSION_INVALID_SAMPLE_RATE", "Opus output sample rate must be 8000, 12000, 16000, 24000, 48000, or 0. Received: $rate")
      return
    }

    try {
      if (bufferId.startsWith("off_")) {
        convertOfflineBuffer(bufferId, outputPath, fmt, rate)
      } else if (bufferId.startsWith("live_")) {
        convertLiveBuffer(bufferId, outputPath, fmt, rate)
      } else {
        promise.reject("CONVERSION_INVALID_ARGUMENT", "Invalid buffer ID prefix: expected off_ or live_")
        return
      }
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      val code = if (e.message?.contains("empty", ignoreCase = true) == true)
        "CONVERSION_BUFFER_EMPTY" else "CONVERSION_BUFFER_NOT_FOUND"
      promise.reject(code, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject("CONVERSION_BUFFER_NOT_FINALIZED", e.message, e)
    } catch (e: Exception) {
      promise.reject("CONVERSION_CONVERT_ERROR", e.message, e)
    }
  }

  private fun convertOfflineBuffer(bufferId: String, outputPath: String, format: String, rate: Int) {
    val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getOffline(bufferId)
      ?: throw IllegalArgumentException("Offline buffer not found: $bufferId")
    if (entry.numSamples == 0) throw IllegalArgumentException("Buffer is empty")

    when (entry) {
      is com.sherpaonnx.audio.pipeline.OfflineEntry.FileBacked -> {
        val err = Companion.nativeConvertAudioToFormat(entry.filePath, outputPath, format, rate)
        if (err.isNotEmpty()) throw RuntimeException(err)
      }
      is com.sherpaonnx.audio.pipeline.OfflineEntry.InMemory -> {
        val err = Companion.nativeConvertPcmToFormat(
          entry.samples, entry.sampleRate, entry.channelCount, outputPath, format, rate)
        if (err.isNotEmpty()) throw RuntimeException(err)
      }
    }
  }

  private fun convertLiveBuffer(bufferId: String, outputPath: String, format: String, rate: Int) {
    val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLive(bufferId)
      ?: throw IllegalArgumentException("Live buffer not found: $bufferId")
    if (entry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.FINISHED)
      throw IllegalStateException("Live buffer must be finalized before conversion")
    if (entry.numSamples == 0L) throw IllegalArgumentException("Buffer is empty")

    val spoolPath = entry.spoolFilePath
    if (spoolPath != null) {
      val err = Companion.nativeConvertAudioToFormat(spoolPath, outputPath, format, rate)
      if (err.isNotEmpty()) throw RuntimeException(err)
    } else {
      val snapshot = entry.snapshotRing()
      val err = Companion.nativeConvertPcmToFormat(
        snapshot, entry.sampleRate, 1, outputPath, format, rate)
      if (err.isNotEmpty()) throw RuntimeException(err)
    }
  }

  override fun getPipelineAudioBufferInfo(bufferId: String, promise: Promise) {
    try {
      val info = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getInfo(bufferId)
      promise.resolve(info)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun releasePipelineAudioBuffer(bufferId: String, promise: Promise) {
    com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.release(bufferId)
    promise.resolve(null)
  }

  override fun getLiveAudioBufferSamplesSlice(liveBufferId: String, startFrame: Double, frameCount: Double, promise: Promise) {
    try {
      val samples = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLiveSamplesSlice(
        liveBufferId, startFrame.toInt(), frameCount.toInt()
      )
      val arr = Arguments.createArray()
      for (s in samples) {
        arr.pushDouble(s.toDouble())
      }
      promise.resolve(arr)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun startMicToLiveAudioBuffer(liveBufferId: String, options: ReadableMap?, promise: Promise) {
    try {
      // Stop any existing mic sink
      micToLiveSink?.stop()
      micToLiveSink = null

      val liveEntry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLive(liveBufferId)
        ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")

      if (liveEntry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.RECORDING) {
        throw IllegalStateException("Live buffer is finalized, cannot capture into it")
      }

      // Compatibility option: emitToJs now toggles centralized append-event emission.
      if (options?.hasKey("emitToJs") == true && !options.isNull("emitToJs")) {
        val emitToJs = options.getBoolean("emitToJs")
        com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.configureLiveAppendEvents(
          liveBufferId = liveBufferId,
          enabled = emitToJs,
          includeSamples = emitToJs,
        )
      }

      val sink = com.sherpaonnx.audio.pipeline.MicToLiveBufferSink(
        liveEntry = liveEntry,
        onError = { msg ->
          val eventEmitter = reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          val payload = Arguments.createMap()
          payload.putString("message", msg)
          payload.putString("liveBufferId", liveBufferId)
          eventEmitter.emit("pipelineLiveAudioError", payload)
        },
        logTag = NAME
      )
      micToLiveSink = sink
      sink.start()
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.CAPTURE_ERROR, e.message, e)
    }
  }

  override fun stopMicToLiveAudioBuffer(promise: Promise) {
    try {
      micToLiveSink?.stop()
      micToLiveSink = null
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.CAPTURE_ERROR, e.message, e)
    }
  }

  // ==================== Pipeline Text Buffers ====================

  override fun createEmptyOfflineTextBuffer(promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createEmptyOffline()
      promise.resolve(entry.toWritableMap())
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createOfflineTextBufferFromLive(liveBufferId: String, mode: String?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createOfflineFromLive(liveBufferId, mode ?: "fullIfSpooled")
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createOfflineTextBufferFromText(text: String, options: ReadableMap?, promise: Promise) {
    try {
      if (text.isEmpty()) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INVALID_ARGUMENT, "text must not be empty")
        return
      }
      val lang = options?.getString("lang") ?: ""
      val emotion = options?.getString("emotion") ?: ""
      val event = options?.getString("event") ?: ""
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createOfflineFromText(text, lang, emotion, event)
      promise.resolve(entry.toWritableMap())
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createLiveTextBuffer(options: ReadableMap, promise: Promise) {
    try {
      val windowMaxChars = if (options.hasKey("windowMaxChars")) options.getDouble("windowMaxChars").toInt() else 65536
      val maxSegments = if (options.hasKey("maxSegments")) options.getDouble("maxSegments").toInt() else 1000
      val emitPartialEvents = if (options.hasKey("emitPartialEvents")) options.getBoolean("emitPartialEvents") else false
      val partialEventMinIntervalMs = if (options.hasKey("partialEventMinIntervalMs")) options.getDouble("partialEventMinIntervalMs").toLong() else 0L
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createLive(
        windowMaxChars = windowMaxChars,
        maxSegments = maxSegments,
        emitPartialEvents = emitPartialEvents,
        partialEventMinIntervalMs = partialEventMinIntervalMs
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createLiveTextBufferFromOffline(offlineBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createLiveFromOffline(offlineBufferId)
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun finalizeLiveTextBuffer(liveBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Live text buffer not found: $liveBufferId")
        return
      }
      entry.finalize_()
      promise.resolve(null)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.ALREADY_FINALIZED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getPipelineTextBufferInfo(bufferId: String, promise: Promise) {
    try {
      val offline = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (offline != null) {
        promise.resolve(offline.toWritableMap())
        return
      }
      val live = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(bufferId)
      if (live != null) {
        promise.resolve(live.toWritableMap())
        return
      }
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Text buffer not found: $bufferId")
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun releasePipelineTextBuffer(bufferId: String, promise: Promise) {
    try {
      com.sherpaonnx.text.pipeline.TextPipelineRegistry.release(bufferId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferTextSlice(bufferId: String, startUtf16: Double, maxUtf16: Double, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      val s = startUtf16.toInt()
      val m = maxUtf16.toInt()
      if (s < 0 || m <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args: start=$s, max=$m")
        return
      }
      if (m > com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_TOO_LARGE, "maxUtf16 $m exceeds max ${com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT}")
        return
      }
      val text = entry.text
      if (s >= text.length) {
        promise.resolve("")
        return
      }
      val end = minOf(s + m, text.length)
      promise.resolve(text.substring(s, end))
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferTokensSlice(bufferId: String, start: Double, maxCount: Double, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      val s = start.toInt()
      val m = maxCount.toInt()
      if (s < 0 || m <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args: start=$s, max=$m")
        return
      }
      if (m > com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_TOO_LARGE, "maxCount $m exceeds max ${com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT}")
        return
      }
      val tokens = entry.tokens
      if (s >= tokens.size) {
        promise.resolve(Arguments.createArray())
        return
      }
      val end = minOf(s + m, tokens.size)
      val arr = Arguments.createArray()
      for (i in s until end) arr.pushString(tokens[i])
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferTimestampsSlice(bufferId: String, start: Double, maxCount: Double, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      val s = start.toInt()
      val m = maxCount.toInt()
      if (s < 0 || m <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args")
        return
      }
      if (m > com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_TOO_LARGE, "maxCount exceeds max")
        return
      }
      val timestamps = entry.timestamps
      if (s >= timestamps.size) {
        promise.resolve(Arguments.createArray())
        return
      }
      val end = minOf(s + m, timestamps.size)
      val arr = Arguments.createArray()
      for (i in s until end) arr.pushDouble(timestamps[i].toDouble())
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferDurationsSlice(bufferId: String, start: Double, maxCount: Double, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      val s = start.toInt()
      val m = maxCount.toInt()
      if (s < 0 || m <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args")
        return
      }
      if (m > com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_TOO_LARGE, "maxCount exceeds max")
        return
      }
      val durations = entry.durations
      if (s >= durations.size) {
        promise.resolve(Arguments.createArray())
        return
      }
      val end = minOf(s + m, durations.size)
      val arr = Arguments.createArray()
      for (i in s until end) arr.pushDouble(durations[i].toDouble())
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferLang(bufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      promise.resolve(entry.lang)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferEmotion(bufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      promise.resolve(entry.emotion)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineTextBufferEvent(bufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Offline text buffer not found: $bufferId")
        return
      }
      promise.resolve(entry.event)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getLiveTextBufferPartialSlice(liveBufferId: String, startUtf16: Double, maxUtf16: Double, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Live text buffer not found: $liveBufferId")
        return
      }
      val s = startUtf16.toInt()
      val m = maxUtf16.toInt()
      if (s < 0 || m <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args")
        return
      }
      val text = entry.currentText
      if (s >= text.length) {
        promise.resolve("")
        return
      }
      val end = minOf(s + m, text.length)
      promise.resolve(text.substring(s, end))
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun appendLiveTextSegment(
    liveBufferId: String,
    text: String,
    tokens: ReadableArray?,
    timestamps: ReadableArray?,
    meta: ReadableMap?,
    promise: Promise
  ) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Live text buffer not found: $liveBufferId")
        return
      }

      val tokenArray = if (tokens != null) {
        Array(tokens.size()) { i -> tokens.getString(i) ?: "" }
      } else {
        emptyArray()
      }

      val timestampArray = if (timestamps != null) {
        FloatArray(timestamps.size()) { i -> timestamps.getDouble(i).toFloat() }
      } else {
        floatArrayOf()
      }

      val metaMap: Map<String, Any?>? = if (meta != null) {
        meta.toHashMap()
      } else {
        null
      }

      val segmentIndex = entry.commitSegment(
        text = text,
        tokens = tokenArray,
        timestamps = timestampArray,
        source = "append",
        meta = metaMap,
      )

      val out = Arguments.createMap()
      out.putInt("segmentIndex", segmentIndex)
      promise.resolve(out)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.ALREADY_FINALIZED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getLiveTextBufferSegments(
    liveBufferId: String,
    startIndex: Double,
    maxCount: Double,
    options: ReadableMap?,
    promise: Promise
  ) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Live text buffer not found: $liveBufferId")
        return
      }

      val start = startIndex.toInt()
      val count = maxCount.toInt()
      if (start < 0 || count <= 0) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_INVALID, "Invalid slice args: start=$start, maxCount=$count")
        return
      }
      if (count > com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT) {
        promise.reject(
          com.sherpaonnx.text.pipeline.TextErrorCodes.SLICE_TOO_LARGE,
          "maxCount $count exceeds max ${com.sherpaonnx.text.pipeline.TextErrorCodes.TEXT_MAX_SLICE_COUNT}"
        )
        return
      }

      val includeTokens = options?.hasKey("includeTokens") == true && options.getBoolean("includeTokens")
      val includeTimestamps = options?.hasKey("includeTimestamps") == true && options.getBoolean("includeTimestamps")
      val includeMeta = options?.hasKey("includeMeta") == true && options.getBoolean("includeMeta")

      val segments = entry.getSegments(start, count)
      val outSegments = Arguments.createArray()
      for (segment in segments) {
        val map = Arguments.createMap().apply {
          putString("text", segment.text)
          putString("source", segment.source)
          putInt("segmentIndex", segment.segmentIndex)
          if (includeTokens) {
            val tokenArr = Arguments.createArray()
            segment.tokens.forEach { tokenArr.pushString(it) }
            putArray("tokens", tokenArr)
          }
          if (includeTimestamps) {
            val tsArr = Arguments.createArray()
            segment.timestamps.forEach { tsArr.pushDouble(it.toDouble()) }
            putArray("timestamps", tsArr)
          }
          if (includeMeta && segment.meta != null) {
            val metaMap = Arguments.createMap()
            for ((key, value) in segment.meta) {
              when (value) {
                is String -> metaMap.putString(key, value)
                is Int -> metaMap.putInt(key, value)
                is Double -> metaMap.putDouble(key, value)
                is Float -> metaMap.putDouble(key, value.toDouble())
                is Boolean -> metaMap.putBoolean(key, value)
                is Number -> metaMap.putDouble(key, value.toDouble())
                null -> metaMap.putNull(key)
                else -> metaMap.putString(key, value.toString())
              }
            }
            putMap("meta", metaMap)
          }
        }
        outSegments.pushMap(map)
      }

      val out = Arguments.createMap()
      out.putArray("segments", outSegments)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getLiveTextBufferSegmentCount(liveBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND, "Live text buffer not found: $liveBufferId")
        return
      }
      promise.resolve(entry.segmentCount)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  // ==================== STT Methods ====================

  override fun transcribe(instanceId: String, bufferId: String, textOutBufferId: String, promise: Promise) {
    sttHelper.transcribe(instanceId, bufferId, textOutBufferId, promise)
  }

  override fun setSttConfig(instanceId: String, options: ReadableMap, promise: Promise) {
    sttHelper.setSttConfig(instanceId, options, promise)
  }

  // ==================== TTS Methods ====================

  /**
   * Initialize TTS with model directory.
   */
  override fun initializeTts(
    instanceId: String,
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Double?,
    silenceScale: Double?,
    provider: String?,
    promise: Promise
  ) {
    commonTtsHelper.initializeTts(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      debug,
      noiseScale,
      noiseScaleW,
      lengthScale,
      ruleFsts,
      ruleFars,
      maxNumSentences,
      silenceScale,
      provider,
      promise
    )
  }

  /**
   * Detect TTS model type and structure without initializing the engine.
   */
  override fun detectTtsModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise,
  ) {
    commonTtsHelper.detectTtsModel(modelDir, assetName, modelType, promise)
  }

  /**
   * Update TTS params by re-initializing with stored config.
   */
  override fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    offlineTtsHelper.updateTtsParams(instanceId, noiseScale, noiseScaleW, lengthScale, promise)
  }

  /**
   * Buffer-to-buffer TTS synthesis.
   */
  override fun synthesizeTts(instanceId: String, textInBufferId: String, audioOutBufferId: String, options: ReadableMap?, promise: Promise) {
    offlineTtsHelper.synthesizeTts(instanceId, textInBufferId, audioOutBufferId, options, promise)
  }

  override fun alignOfflineTextToAudio(
    textInBufferId: String,
    audioInBufferId: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    alignmentHelper.alignOfflineTextToAudio(
      textInBufferId,
      audioInBufferId,
      mode,
      granularity,
      options,
      promise
    )
  }

  /**
   * Start a streaming TTS pipeline worker.
   */
  override fun startTtsPipeline(
    instanceId: String,
    textInLiveBufferId: String,
    audioOutLiveBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) {
    onlineTtsHelper.startTtsPipeline(instanceId, textInLiveBufferId, audioOutLiveBufferId, options, promise)
  }

  override fun createPcmPlayer(
    playerId: String,
    audioBufferId: String,
    volume: Double,
    promise: Promise
  ) {
    pcmPlayerService.create(playerId, audioBufferId, volume, promise)
  }

  override fun pausePcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.pause(playerId, promise)
  }

  override fun resumePcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.resume(playerId, promise)
  }

  override fun destroyPcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.destroy(playerId, promise)
  }

  /**
   * Get TTS sample rate.
   */
  override fun getTtsSampleRate(instanceId: String, promise: Promise) {
    commonTtsHelper.getTtsSampleRate(instanceId, promise)
  }

  /**
   * Get number of speakers.
   */
  override fun getTtsNumSpeakers(instanceId: String, promise: Promise) {
    commonTtsHelper.getTtsNumSpeakers(instanceId, promise)
  }

  /**
   * Release TTS resources.
   */
  override fun unloadTts(instanceId: String, promise: Promise) {
    commonTtsHelper.unloadTts(instanceId, promise)
  }

  // ==================== Speech Enhancement Methods ====================

  override fun detectEnhancementModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    enhancementHelper.detectEnhancementModel(modelDir, assetName, modelType, promise)
  }

  override fun detectAlignmentModel(
    modelDir: String,
    modelType: String?,
    promise: Promise
  ) {
    try {
      val result = Companion.nativeDetectAlignmentModel(modelDir, modelType ?: "auto")
      if (result == null) {
        android.util.Log.e(NAME, "DETECT_ERROR: Alignment model detection returned null")
        promise.reject("DETECT_ERROR", "Alignment model detection returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      val detectedModels = result["detectedModels"] as? ArrayList<*>
        ?: arrayListOf<HashMap<String, String>>()
      val modelTypeStr = result["modelType"] as? String
      val paths = result["paths"] as? HashMap<*, *>

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
      val alignmentModelPath = paths?.get("model") as? String
      if (!alignmentModelPath.isNullOrBlank()) {
        val pathsMap = Arguments.createMap()
        pathsMap.putString("model", alignmentModelPath)
        resultMap.putMap("paths", pathsMap)
      }
      if (!success) {
        val error = result["error"] as? String
        if (!error.isNullOrBlank()) {
          resultMap.putString("error", error)
        }
      }
      promise.resolve(resultMap)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "DETECT_ERROR: Alignment model detection failed: ${e.message}", e)
      promise.reject("DETECT_ERROR", "Alignment model detection failed: ${e.message}", e)
    }
  }

  override fun initializeEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    enhancementHelper.initializeEnhancement(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      provider,
      debug,
      promise
    )
  }

  override fun enhanceOfflineAudioBuffers(
    instanceId: String,
    audioInBufferId: String,
    audioOutBufferId: String,
    promise: Promise
  ) {
    enhancementHelper.enhanceOfflineAudioBuffers(instanceId, audioInBufferId, audioOutBufferId, promise)
  }

  override fun getEnhancementSampleRate(instanceId: String, promise: Promise) {
    enhancementHelper.getSampleRate(instanceId, promise)
  }

  override fun unloadEnhancement(instanceId: String, promise: Promise) {
    enhancementHelper.unloadEnhancement(instanceId, promise)
  }

  override fun initializeOnlineEnhancement(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    enhancementHelper.initializeOnlineEnhancement(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      provider,
      debug,
      promise
    )
  }

  override fun unloadOnlineEnhancement(instanceId: String, promise: Promise) {
    enhancementHelper.unloadOnline(instanceId, promise)
  }

  // ==================== Enhancement Pipeline ====================

  override fun startEnhancementPipeline(
    instanceId: String,
    inputBufferId: String,
    outputBufferId: String,
    promise: Promise
  ) {
    enhancementHelper.startEnhancementPipeline(instanceId, inputBufferId, outputBufferId, promise)
  }

  // ==================== Streaming Pipeline Control (generic) ====================

  override fun stopStreamingPipeline(pipelineId: String, promise: Promise) {
    try {
      StreamingPipelineRegistry.stop(pipelineId)
      StreamingPipelineRegistry.remove(pipelineId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("PIPELINE_ERROR", e.message, e)
    }
  }

  override fun flushStreamingPipeline(pipelineId: String, promise: Promise) {
    try {
      StreamingPipelineRegistry.flush(pipelineId).whenComplete { _, error ->
        if (error != null) {
          promise.reject("PIPELINE_FLUSH_ERROR", error.message, error)
        } else {
          promise.resolve(null)
        }
      }
    } catch (e: Exception) {
      promise.reject("PIPELINE_ERROR", e.message, e)
    }
  }

  override fun resetStreamingPipeline(pipelineId: String, promise: Promise) {
    try {
      StreamingPipelineRegistry.reset(pipelineId).whenComplete { _, error ->
        if (error != null) {
          promise.reject("PIPELINE_RESET_ERROR", error.message, error)
        } else {
          promise.resolve(null)
        }
      }
    } catch (e: Exception) {
      promise.reject("PIPELINE_ERROR", e.message, e)
    }
  }

  override fun getStreamingPipelineStatus(pipelineId: String, promise: Promise) {
    try {
      val status = StreamingPipelineRegistry.getStatus(pipelineId)
      if (status == null) {
        promise.reject("PIPELINE_NOT_FOUND", "Streaming pipeline '$pipelineId' not found")
        return
      }
      val map = Arguments.createMap().apply {
        putString("pipelineId", pipelineId)
        putBoolean("isRunning", status.isRunning)
        putDouble("chunksProcessed", status.chunksProcessed.toDouble())
        putDouble("unitsRead", status.unitsRead.toDouble())
        putDouble("unitsWritten", status.unitsWritten.toDouble())
        if (status.error != null) {
          putString("error", status.error)
        } else {
          putNull("error")
        }
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("PIPELINE_ERROR", e.message, e)
    }
  }

  /**
   * Copy a local file into a document under a SAF directory URI (format-agnostic).
   */
  override fun copyFileToContentUri(
    filePath: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    filesHelper.copyFileToContentUri(filePath, directoryUri, filename, mimeType, promise)
  }

  override fun saveTextToContentUri(
    text: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    filesHelper.saveTextToContentUri(text, directoryUri, filename, mimeType, promise)
  }

  override fun copyContentUriToCache(
    fileUri: String,
    filename: String,
    promise: Promise
  ) {
    filesHelper.copyContentUriToCache(fileUri, filename, promise)
  }

  override fun shareAudioFile(fileUri: String, mimeType: String, promise: Promise) {
    filesHelper.shareAudioFile(fileUri, mimeType, promise)
  }

  /**
   * List all model folders in the assets/models directory.
   * Scans the platform-specific model directory and returns folder names.
   */
  override fun listAssetModels(promise: Promise) {
    assetHelper.listAssetModels(promise)
  }

  /**
   * List model folders under a specific filesystem path.
   */
  override fun listModelsAtPath(path: String, recursive: Boolean, promise: Promise) {
    assetHelper.listModelsAtPath(path, recursive, promise)
  }

  override fun getAssetPackPath(packName: String, promise: Promise) {
    assetHelper.getAssetPackPath(packName, promise)
  }

  override fun listBundledArchiveAssetPaths(packName: String, promise: Promise) {
    assetHelper.listBundledArchiveAssetPaths(packName, promise)
  }

  override fun extractArchiveFromAsset(
    assetPath: String,
    targetPath: String,
    force: Boolean,
    skipEntries: Double,
    operationId: String,
    showNotificationsEnabled: Boolean?,
    notificationTitle: String?,
    notificationText: String?,
    promise: Promise,
  ) {
    val notif = extractionNotificationOrNull(
      showNotificationsEnabled,
      notificationTitle,
      notificationText,
    )
    archiveHelper.extractFromAsset(
      reactApplicationContext,
      assetPath,
      targetPath,
      force,
      skipEntries.toInt(),
      operationId,
      promise,
      { bytes, total, percent, entryIndex ->
        emitExtractProgress(operationId, assetPath, bytes, total, percent, entryIndex)
      },
      notif,
    )
  }

  override fun readAssetFileAsUtf8(assetPath: String, promise: Promise) {
    // Validate assetPath to prevent path traversal: reject paths containing
    // "..", starting with "/" or "\", or containing backslashes.
    if (assetPath.contains("..") ||
        assetPath.startsWith("/") ||
        assetPath.startsWith("\\") ||
        assetPath.contains("\\")) {
      promise.reject("ASSET_READ_ERROR", "Invalid asset path: $assetPath")
      return
    }
    try {
      val content = reactApplicationContext.assets.open(assetPath).bufferedReader().use { it.readText() }
      promise.resolve(content)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "Failed to read asset $assetPath: ${e.message}", e)
      promise.reject("ASSET_READ_ERROR", "Failed to read asset $assetPath: ${e.message}", e)
    }
  }

  companion object {
    const val NAME = "SherpaOnnx"

    @Volatile
    private var instance: SherpaOnnxModule? = null

    // Native JNI methods
    @JvmStatic
    private external fun nativeTestSherpaInit(): String

    /** True if QNN HTP backend can be initialized (QnnBackend_create + free). */
    @JvmStatic
    private external fun nativeCanInitQnnHtp(): Boolean

    /** True if the device has an NNAPI accelerator (GPU/DSP). Android API 29+. */
    @JvmStatic
    private external fun nativeHasNnapiAccelerator(sdkInt: Int): Boolean

    /** Model detection for STT: returns HashMap with success, error, detectedModels, modelType, paths (for Kotlin API config). */
    @JvmStatic
    private external fun nativeDetectSttModel(
      modelDir: String?,
      assetName: String?,
      modelType: String,
      preferInt8: Boolean,
      hasPreferInt8: Boolean,
      debug: Boolean
    ): HashMap<String, Any>?

    /** Model detection for TTS: optional directory and/or asset name; returns HashMap (for Kotlin API config). */
    @JvmStatic
    private external fun nativeDetectTtsModel(
      modelDir: String,
      assetName: String?,
      modelType: String?,
    ): HashMap<String, Any>?

    /** Model detection for speech enhancement: optional directory and/or asset name. */
    @JvmStatic
    private external fun nativeDetectEnhancementModel(
      modelDir: String?,
      assetName: String?,
      modelType: String
    ): HashMap<String, Any>?

    /** Model detection for subtitles/alignment: returns HashMap with success, error, detectedModels, modelType, paths. */
    @JvmStatic
    private external fun nativeDetectAlignmentModel(modelDir: String, modelType: String): HashMap<String, Any>?

    /** Convert arbitrary audio file to requested format (e.g. "mp3", "flac", "wav").
     * outputSampleRateHz: for MP3 use 32000/44100/48000, 0 = default 44100. Ignored for WAV/FLAC.
     * Returns empty string on success, or an error message otherwise. Requires FFmpeg prebuilts when called on Android.
     */
    @JvmStatic
    private external fun nativeConvertAudioToFormat(inputPath: String, outputPath: String, format: String, outputSampleRateHz: Int): String

    /** Mono float32 little-endian raw PCM file to output format (requires FFmpeg). Empty = success. */
    @JvmStatic
    private external fun nativeConvertFloat32MonoFileToFormat(
      rawPath: String,
      pcmSampleRate: Int,
      outputPath: String,
      format: String,
      outputSampleRateHz: Int
    ): String

    /** Encode raw float32 PCM buffer to output format (requires FFmpeg). Empty = success. */
    @JvmStatic
    private external fun nativeConvertPcmToFormat(
      samples: FloatArray,
      sampleRate: Int,
      channelCount: Int,
      outputPath: String,
      format: String,
      outputSampleRateHz: Int
    ): String
  }
}
