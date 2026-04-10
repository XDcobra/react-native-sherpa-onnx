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
import com.sherpaonnx.stt.SttErrorCodes
import com.sherpaonnx.tts.core.SherpaOnnxTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxCommonTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOfflineTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOnlineTtsHelper
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

@ReactModule(name = SherpaOnnxModule.NAME)
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
  NativeSherpaOnnxSpec(reactContext) {

  private data class SttAlignmentRecord(
    val alignmentId: Long,
    val segments: List<SttAlignmentSegment>,
    val tokenCount: Int?,
  )

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
    { instanceId, requestId, samples, sampleRate, progress, isFinal -> emitTtsStreamChunk(instanceId, requestId, samples, sampleRate, progress, isFinal) },
    { instanceId, requestId, message -> emitTtsStreamError(instanceId, requestId, message) },
    { instanceId, requestId, cancelled -> emitTtsStreamEnd(instanceId, requestId, cancelled) },
    { instanceId, requestId, message, path -> emitTtsStreamFileError(instanceId, requestId, message, path) },
    { instanceId, requestId, cancelled, path, bytesWritten, sampleRate -> emitTtsStreamFileEnd(instanceId, requestId, cancelled, path, bytesWritten, sampleRate) },
    { rawPath, pcmSr, outPath, fmt, outHz ->
      Companion.nativeConvertFloat32MonoFileToFormat(rawPath, pcmSr, outPath, fmt, outHz)
    },
    pcmPlayerService
  )
  private val offlineTtsHelper = SherpaOnnxOfflineTtsHelper(ttsHelper)
  private val onlineTtsHelper = SherpaOnnxOnlineTtsHelper(ttsHelper)
  private val commonTtsHelper = SherpaOnnxCommonTtsHelper(ttsHelper)
  private val filesHelper = SherpaOnnxFilesHelper(reactApplicationContext)
  private val alignmentHelper = SherpaOnnxAlignmentHelper(
    reactApplicationContext,
    { instanceId, generation -> ttsHelper.getBatchSinkSnapshot(instanceId, generation) }
  )
  private val enhancementHelper = SherpaOnnxEnhancementHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType -> Companion.nativeDetectEnhancementModel(modelDir, assetName, modelType) }
  )
  private val archiveHelper = SherpaOnnxArchiveHelper()
  private val sttAlignmentStore = ConcurrentHashMap<Long, SttAlignmentRecord>()
  private val sttAlignmentIdCounter = AtomicLong(0)
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
    pcmCapture?.stop()
    pcmCapture = null
    onlineSttHelper.shutdown()
    commonTtsHelper.shutdown()
    alignmentHelper.shutdown()
    sttAlignmentStore.clear()
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

  override fun createSttStream(instanceId: String, streamId: String, hotwords: String?, promise: Promise) {
    onlineSttHelper.createSttStream(instanceId, streamId, hotwords, promise)
  }

  override fun acceptSttWaveform(streamId: String, samples: ReadableArray, sampleRate: Double, promise: Promise) {
    onlineSttHelper.acceptSttWaveform(streamId, samples, sampleRate.toInt(), promise)
  }

  override fun sttStreamInputFinished(streamId: String, promise: Promise) {
    onlineSttHelper.sttStreamInputFinished(streamId, promise)
  }

  override fun decodeSttStream(streamId: String, promise: Promise) {
    onlineSttHelper.decodeSttStream(streamId, promise)
  }

  override fun isSttStreamReady(streamId: String, promise: Promise) {
    onlineSttHelper.isSttStreamReady(streamId, promise)
  }

  override fun getSttStreamResult(streamId: String, promise: Promise) {
    onlineSttHelper.getSttStreamResult(streamId, promise)
  }

  override fun isSttStreamEndpoint(streamId: String, promise: Promise) {
    onlineSttHelper.isSttStreamEndpoint(streamId, promise)
  }

  override fun resetSttStream(streamId: String, promise: Promise) {
    onlineSttHelper.resetSttStream(streamId, promise)
  }

  override fun releaseSttStream(streamId: String, promise: Promise) {
    onlineSttHelper.releaseSttStream(streamId, promise)
  }

  override fun unloadOnlineStt(instanceId: String, promise: Promise) {
    onlineSttHelper.unloadOnlineStt(instanceId, promise)
  }

  override fun processSttAudioChunk(streamId: String, samples: ReadableArray, sampleRate: Double, promise: Promise) {
    onlineSttHelper.processSttAudioChunk(streamId, samples, sampleRate.toInt(), promise)
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

  override fun saveOfflineAudioBufferToWav(bufferId: String, outputPath: String, promise: Promise) {
    try {
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.saveOfflineToWav(bufferId, outputPath)
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.FILE_WRITE_ERROR, e.message, e)
    }
  }

  override fun saveLiveAudioBufferToWav(liveBufferId: String, outputPath: String, promise: Promise) {
    try {
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.saveLiveToWav(liveBufferId, outputPath)
      promise.resolve(null)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.FILE_WRITE_ERROR, e.message, e)
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

  // ==================== STT Methods ====================

  override fun transcribeFile(instanceId: String, filePath: String, promise: Promise) {
    sttHelper.transcribeFile(instanceId, filePath, promise)
  }

  override fun transcribeSamples(instanceId: String, samples: ReadableArray, sampleRate: Double, promise: Promise) {
    sttHelper.transcribeSamples(instanceId, samples, sampleRate.toInt(), promise)
  }

  override fun transcribeFromAudioBuffer(instanceId: String, bufferId: String, sourceTag: String?, promise: Promise) {
    sttHelper.transcribeFromAudioBuffer(instanceId, bufferId, sourceTag, promise)
  }

  // ==================== STT Result Getters ====================

  override fun getSttResultText(instanceId: String, resultId: Double, promise: Promise) {
    sttHelper.getSttResultText(instanceId, resultId, promise)
  }

  override fun getSttResultTokens(instanceId: String, resultId: Double, start: Double, maxCount: Double, promise: Promise) {
    sttHelper.getSttResultTokens(instanceId, resultId, start.toInt(), maxCount.toInt(), promise)
  }

  override fun getSttResultTimestamps(instanceId: String, resultId: Double, start: Double, maxCount: Double, promise: Promise) {
    sttHelper.getSttResultTimestamps(instanceId, resultId, start.toInt(), maxCount.toInt(), promise)
  }

  override fun getSttResultDurations(instanceId: String, resultId: Double, start: Double, maxCount: Double, promise: Promise) {
    sttHelper.getSttResultDurations(instanceId, resultId, start.toInt(), maxCount.toInt(), promise)
  }

  override fun getSttResultLang(instanceId: String, resultId: Double, promise: Promise) {
    sttHelper.getSttResultLang(instanceId, resultId, promise)
  }

  override fun getSttResultEmotion(instanceId: String, resultId: Double, promise: Promise) {
    sttHelper.getSttResultEmotion(instanceId, resultId, promise)
  }

  override fun getSttResultEvent(instanceId: String, resultId: Double, promise: Promise) {
    sttHelper.getSttResultEvent(instanceId, resultId, promise)
  }

  override fun releaseSttResult(instanceId: String, promise: Promise) {
    sttHelper.releaseSttResult(instanceId, promise)
  }

  override fun setSttConfig(instanceId: String, options: ReadableMap, promise: Promise) {
    sttHelper.setSttConfig(instanceId, options, promise)
  }

  // ==================== Alignment Stage ====================

  override fun alignSttResult(instanceId: String, resultId: Double, bufferId: String, alignmentModelId: String?, granularity: String?, promise: Promise) {
    val sttInput = sttHelper.getAlignmentInput(instanceId, resultId, promise) ?: return
    val entry = PipelineAudioRegistry.getOffline(bufferId)
    if (entry == null) {
      promise.reject(SttErrorCodes.BUFFER_NOT_FOUND, "Offline audio buffer not found: $bufferId")
      return
    }

    if (sttInput.sampleRate != entry.sampleRate) {
      promise.reject(
        SttErrorCodes.ALIGNMENT_INPUT_MISMATCH,
        "STT result sampleRate (${sttInput.sampleRate}) does not match buffer sampleRate (${entry.sampleRate})"
      )
      return
    }

    val alignmentGranularity = try {
      sttGranularityToAlignmentGranularity(granularity)
    } catch (e: IllegalArgumentException) {
      promise.reject(SttErrorCodes.INVALID_ARGUMENT, e.message, e)
      return
    }

    val mode = if (alignmentModelId.isNullOrBlank()) "proportional" else "accurate"

    val samples = entry.readAllSamples()
    alignmentHelper.alignTextToPcmForStt(
      text = sttInput.text,
      samples = samples,
      sampleRate = entry.sampleRate,
      mode = mode,
      granularity = alignmentGranularity,
      alignmentModelPath = alignmentModelId,
      onSuccess = { segments, _ ->
        val alignmentId = sttAlignmentIdCounter.incrementAndGet()
        sttAlignmentStore[alignmentId] = SttAlignmentRecord(
          alignmentId = alignmentId,
          segments = segments,
          tokenCount = sttInput.tokenCount,
        )
        val map = Arguments.createMap()
        map.putBoolean("success", true)
        map.putDouble("alignmentId", alignmentId.toDouble())
        map.putInt("segmentCount", segments.size)
        map.putInt("tokenCount", sttInput.tokenCount)
        promise.resolve(map)
      },
      onError = { message, error ->
        promise.reject(SttErrorCodes.ALIGNMENT_FAILED, message, error)
      }
    )
  }

  override fun alignTextToBuffer(text: String, bufferId: String, alignmentModelId: String?, granularity: String?, promise: Promise) {
    if (text.isBlank()) {
      promise.reject(SttErrorCodes.INVALID_ARGUMENT, "text is required")
      return
    }

    val entry = PipelineAudioRegistry.getOffline(bufferId)
    if (entry == null) {
      promise.reject(SttErrorCodes.BUFFER_NOT_FOUND, "Offline audio buffer not found: $bufferId")
      return
    }

    val alignmentGranularity = try {
      sttGranularityToAlignmentGranularity(granularity)
    } catch (e: IllegalArgumentException) {
      promise.reject(SttErrorCodes.INVALID_ARGUMENT, e.message, e)
      return
    }

    val mode = if (alignmentModelId.isNullOrBlank()) "proportional" else "accurate"

    val samples = entry.readAllSamples()
    alignmentHelper.alignTextToPcmForStt(
      text = text,
      samples = samples,
      sampleRate = entry.sampleRate,
      mode = mode,
      granularity = alignmentGranularity,
      alignmentModelPath = alignmentModelId,
      onSuccess = { segments, _ ->
        val alignmentId = sttAlignmentIdCounter.incrementAndGet()
        sttAlignmentStore[alignmentId] = SttAlignmentRecord(
          alignmentId = alignmentId,
          segments = segments,
          tokenCount = null,
        )
        val map = Arguments.createMap()
        map.putBoolean("success", true)
        map.putDouble("alignmentId", alignmentId.toDouble())
        map.putInt("segmentCount", segments.size)
        promise.resolve(map)
      },
      onError = { message, error ->
        promise.reject(SttErrorCodes.ALIGNMENT_FAILED, message, error)
      }
    )
  }

  override fun getAlignmentSegments(alignmentId: Double, start: Double, maxCount: Double, promise: Promise) {
    val id = alignmentId.toLong()
    val record = sttAlignmentStore[id]
    if (record == null) {
      promise.reject(SttErrorCodes.ALIGNMENT_NOT_FOUND, "Alignment not found: $id")
      return
    }

    val s = start.toInt()
    val mc = maxCount.toInt()
    if (s < 0) {
      promise.reject(SttErrorCodes.ALIGNMENT_SLICE_INVALID, "start must be >= 0, got $s")
      return
    }
    if (mc <= 0) {
      promise.reject(SttErrorCodes.ALIGNMENT_SLICE_INVALID, "maxCount must be > 0, got $mc")
      return
    }
    if (mc > SttErrorCodes.ALIGNMENT_MAX_SLICE_COUNT) {
      promise.reject(
        SttErrorCodes.ALIGNMENT_SLICE_TOO_LARGE,
        "maxCount $mc exceeds max ${SttErrorCodes.ALIGNMENT_MAX_SLICE_COUNT}"
      )
      return
    }

    if (s >= record.segments.size) {
      promise.resolve(Arguments.createArray())
      return
    }

    val end = kotlin.math.min(s + mc, record.segments.size)
    val out = Arguments.createArray()
    for (i in s until end) {
      val seg = record.segments[i]
      val m = Arguments.createMap()
      m.putString("text", seg.text)
      m.putDouble("startSec", seg.startSec)
      m.putDouble("endSec", seg.endSec)
      out.pushMap(m)
    }
    promise.resolve(out)
  }

  override fun saveAlignment(alignmentId: Double, targetPath: String, format: String?, promise: Promise) {
    val id = alignmentId.toLong()
    val record = sttAlignmentStore[id]
    if (record == null) {
      promise.reject(SttErrorCodes.ALIGNMENT_NOT_FOUND, "Alignment not found: $id")
      return
    }

    try {
      val normalizedFormat = (format ?: "json").trim().lowercase(Locale.US)
      val target = File(targetPath)
      target.parentFile?.mkdirs()

      when (normalizedFormat) {
        "json" -> writeAlignmentAsJson(record, target)
        "srt" -> writeAlignmentAsSrt(record, target)
        "vtt" -> writeAlignmentAsVtt(record, target)
        else -> {
          promise.reject(SttErrorCodes.INVALID_ARGUMENT, "Unsupported alignment format: $normalizedFormat")
          return
        }
      }

      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(SttErrorCodes.ALIGNMENT_FAILED, e.message ?: "Failed to save alignment", e)
    }
  }

  override fun releaseAlignment(alignmentId: Double, promise: Promise) {
    sttAlignmentStore.remove(alignmentId.toLong())
    promise.resolve(null)
  }

  private fun sttGranularityToAlignmentGranularity(granularity: String?): String {
    val g = granularity?.trim()?.lowercase(Locale.US) ?: "segment"
    return when (g) {
      "segment" -> "sentence"
      "word" -> "word"
      "token" -> "character"
      else -> throw IllegalArgumentException("Unsupported granularity: $granularity")
    }
  }

  private fun writeAlignmentAsJson(record: SttAlignmentRecord, target: File) {
    val sb = StringBuilder()
    sb.append("[")
    record.segments.forEachIndexed { index, seg ->
      if (index > 0) sb.append(',')
      sb.append("{\"text\":\"")
      sb.append(seg.text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n"))
      sb.append("\",\"startSec\":")
      sb.append(seg.startSec)
      sb.append(",\"endSec\":")
      sb.append(seg.endSec)
      sb.append('}')
    }
    sb.append(']')
    target.writeText(sb.toString())
  }

  private fun writeAlignmentAsSrt(record: SttAlignmentRecord, target: File) {
    val sb = StringBuilder()
    record.segments.forEachIndexed { index, seg ->
      sb.append(index + 1)
      sb.append('\n')
      sb.append(formatSubtitleTimestamp(seg.startSec, useDotSeparator = false))
      sb.append(" --> ")
      sb.append(formatSubtitleTimestamp(seg.endSec, useDotSeparator = false))
      sb.append('\n')
      sb.append(seg.text)
      sb.append("\n\n")
    }
    target.writeText(sb.toString())
  }

  private fun writeAlignmentAsVtt(record: SttAlignmentRecord, target: File) {
    val sb = StringBuilder()
    sb.append("WEBVTT\n\n")
    record.segments.forEach { seg ->
      sb.append(formatSubtitleTimestamp(seg.startSec, useDotSeparator = true))
      sb.append(" --> ")
      sb.append(formatSubtitleTimestamp(seg.endSec, useDotSeparator = true))
      sb.append('\n')
      sb.append(seg.text)
      sb.append("\n\n")
    }
    target.writeText(sb.toString())
  }

  private fun formatSubtitleTimestamp(seconds: Double, useDotSeparator: Boolean): String {
    val totalMs = (seconds.coerceAtLeast(0.0) * 1000.0).toLong()
    val hours = totalMs / 3_600_000
    val minutes = (totalMs % 3_600_000) / 60_000
    val secs = (totalMs % 60_000) / 1_000
    val millis = totalMs % 1_000
    val separator = if (useDotSeparator) '.' else ','
    return String.format(Locale.US, "%02d:%02d:%02d%c%03d", hours, minutes, secs, separator, millis)
  }

  /**
   * If inputPath is a content:// URI, copies it to a temp file via ContentResolver.openInputStream.
   * Caller deletes the returned temp file in a finally block.
   */
  private fun resolveInputForConvert(inputPath: String): Pair<String, java.io.File?> {
    if (!inputPath.startsWith("content://")) return Pair(inputPath, null)
    val uri = Uri.parse(inputPath)
    val resolver = reactApplicationContext.contentResolver
    val ext = android.webkit.MimeTypeMap.getSingleton()
      .getExtensionFromMimeType(resolver.getType(uri)) ?: "tmp"
    val tmp = java.io.File(reactApplicationContext.cacheDir, "convert_${System.nanoTime()}.$ext")
    resolver.openInputStream(uri)?.use { input ->
      tmp.outputStream().use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("Content URI not readable: $inputPath")
    return Pair(tmp.absolutePath, tmp)
  }

  /**
   * Convert any supported audio file to a requested format using native FFmpeg prebuilts.
   * Accepts file paths and content:// URIs. Content URIs are transparently copied to a
   * temp file first (via ContentResolver), converted, then the temp file is deleted.
   */
  override fun convertAudioToFormat(inputPath: String, outputPath: String, format: String, outputSampleRateHz: Double?, promise: Promise) {
    var tmpFile: java.io.File? = null
    try {
      var rate = outputSampleRateHz?.toInt() ?: 0

      if (rate < 0) {
        promise.reject("CONVERT_ERROR", "Invalid outputSampleRateHz: must be >= 0")
        return
      }

      if (format.equals("mp3", ignoreCase = true)) {
        val allowed = setOf(0, 32000, 44100, 48000)
        if (!allowed.contains(rate)) {
          promise.reject("CONVERT_ERROR", "MP3 output sample rate must be one of 32000, 44100, 48000, or 0 (default). Received: $rate")
          return
        }
      } else if (format.equals("opus", ignoreCase = true) || format.equals("oggm", ignoreCase = true) || format.equals("webm", ignoreCase = true) || format.equals("mkv", ignoreCase = true) || format.equals("ogg", ignoreCase = true)) {
        val allowed = setOf(0, 8000, 12000, 16000, 24000, 48000)
        if (!allowed.contains(rate)) {
          promise.reject("CONVERT_ERROR", "Opus output sample rate must be 8000, 12000, 16000, 24000, 48000, or 0 (default). Received: $rate")
          return
        }
      } else {
        rate = rate.coerceIn(0, 48000)
      }

      val (pathToUse, tmp) = resolveInputForConvert(inputPath)
      tmpFile = tmp
      val err = Companion.nativeConvertAudioToFormat(pathToUse, outputPath, format, rate)
      if (err.isEmpty()) {
        promise.resolve(null)
      } else {
        android.util.Log.e(NAME, "CONVERT_ERROR: $err (inputPath=$inputPath)")
        promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      android.util.Log.e(NAME, "CONVERT_EXCEPTION: Failed to convert audio: ${e.message}", e)
      promise.reject("CONVERT_EXCEPTION", "Failed to convert audio: ${e.message}", e)
    } finally {
      tmpFile?.delete()
    }
  }

  /**
   * Convert any supported audio file to WAV 16 kHz mono 16-bit PCM using native FFmpeg prebuilts.
   * Accepts file paths and content:// URIs. Content URIs are copied to a temp file first.
   */
  override fun convertAudioToWav16k(inputPath: String, outputPath: String, promise: Promise) {
    var tmpFile: java.io.File? = null
    try {
      val (pathToUse, tmp) = resolveInputForConvert(inputPath)
      tmpFile = tmp
      val err = Companion.nativeConvertAudioToWav16k(pathToUse, outputPath)
      if (err.isEmpty()) {
        promise.resolve(null)
      } else {
        android.util.Log.e(NAME, "CONVERT_ERROR: $err")
        promise.reject("CONVERT_ERROR", err)
      }
    } catch (e: Exception) {
      android.util.Log.e(NAME, "CONVERT_EXCEPTION: Failed to convert audio to WAV16k: ${e.message}", e)
      promise.reject("CONVERT_EXCEPTION", "Failed to convert audio to WAV16k: ${e.message}", e)
    } finally {
      tmpFile?.delete()
    }
  }

  /**
   * Decode audio to mono float samples (approx. [-1, 1]) and effective sample rate.
   * Same path/URI handling as [convertAudioToFormat]. WAV may use [WaveReader] when no resample is requested.
   */
  override fun decodeAudioFileToFloatSamples(inputPath: String, targetSampleRateHz: Double?, promise: Promise) {
    var tmpFile: java.io.File? = null
    try {
      val targetHz = (targetSampleRateHz ?: 0.0).toInt()
      if (targetHz < 0) {
        promise.reject("DECODE_ERROR", "targetSampleRateHz must be >= 0")
        return
      }
      val (pathToUse, tmp) = resolveInputForConvert(inputPath)
      tmpFile = tmp

      if (pathToUse.endsWith(".wav", ignoreCase = true)) {
        try {
          val wave = WaveReader.readWave(pathToUse)
          val s = wave.samples
          if (s != null && s.isNotEmpty() && wave.sampleRate > 0 && (targetHz == 0 || targetHz == wave.sampleRate)) {
            val map = Arguments.createMap()
            val arr = Arguments.createArray()
            for (i in s.indices) {
              arr.pushDouble(s[i].toDouble())
            }
            map.putArray("samples", arr)
            map.putInt("sampleRate", wave.sampleRate)
            promise.resolve(map)
            return
          }
        } catch (_: Throwable) {
          // Fall through to FFmpeg/native path (e.g. odd WAV or resample requested).
        }
      }

      val result = Companion.nativeDecodeAudioFileToFloatSamples(pathToUse, targetHz)
      if (result.size == 1 && result[0] is String) {
        promise.reject("DECODE_ERROR", result[0] as String)
        return
      }
      if (result.size != 2 || result[0] !is FloatArray) {
        promise.reject("DECODE_ERROR", "Unexpected native decode result")
        return
      }
      val floats = result[0] as FloatArray
      val rateObj = result.getOrNull(1) as? Number ?: run {
        promise.reject("DECODE_ERROR", "Unexpected sample rate in native decode result")
        return
      }
      val sr = rateObj.toInt()
      val map = Arguments.createMap()
      val arr = Arguments.createArray()
      for (i in floats.indices) {
        arr.pushDouble(floats[i].toDouble())
      }
      map.putArray("samples", arr)
      map.putInt("sampleRate", sr)
      promise.resolve(map)
    } catch (e: Exception) {
      android.util.Log.e(NAME, "DECODE_EXCEPTION: ${e.message}", e)
      promise.reject("DECODE_EXCEPTION", e.message ?: "Failed to decode audio", e)
    } finally {
      tmpFile?.delete()
    }
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
   * Generate speech from text.
   */
  override fun generateTts(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    offlineTtsHelper.generateTts(instanceId, text, options, promise)
  }

  /**
   * Generate speech with subtitle/timestamp metadata.
   */
  override fun generateTtsWithTimestamps(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    offlineTtsHelper.generateTtsWithTimestamps(instanceId, text, options, promise)
  }

  /**
   * Retrieve PCM samples from the native sink for a given generation.
   */
  override fun getTtsSamples(instanceId: String, generation: Double, promise: Promise) {
    offlineTtsHelper.getTtsSamples(instanceId, generation, promise)
  }

  /**
   * Save TTS audio directly from the native sink (no JS PCM round-trip).
   */
  override fun saveTtsAudioFromSink(
    instanceId: String,
    generation: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) {
    offlineTtsHelper.saveTtsAudioFromSink(
      instanceId, generation, destinationType, pathOrDirectoryUri,
      filename, format, outputSampleRateHz, promise
    )
  }

  override fun playTtsFromSink(instanceId: String, generation: Double, sampleRate: Double, promise: Promise) {
    offlineTtsHelper.playTtsFromSink(instanceId, generation, sampleRate, promise)
  }

  override fun getAudioDuration(
    audioPath: String,
    promise: Promise,
  ) {
    alignmentHelper.getAudioDuration(audioPath, promise)
  }

  override fun alignTextToAudioFromPath(
    text: String,
    audioPath: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    alignmentHelper.alignTextToAudioFromPath(
      text,
      audioPath,
      mode,
      granularity,
      options,
      promise
    )
  }

  override fun alignTextToAudioFromPcm(
    text: String,
    samples: ReadableArray,
    sampleRate: Double,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    alignmentHelper.alignTextToAudioFromPcm(
      text,
      samples,
      sampleRate,
      mode,
      granularity,
      options,
      promise
    )
  }

  override fun alignTextToTtsSink(
    generatedAudio: ReadableMap,
    text: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    alignmentHelper.alignTextToTtsSink(
      generatedAudio,
      text,
      mode,
      granularity,
      options,
      promise
    )
  }

  /**
   * Generate speech in streaming mode (emits chunk events).
   */
  override fun generateTtsStream(instanceId: String, requestId: String, text: String, options: ReadableMap?, promise: Promise) {
    onlineTtsHelper.generateTtsStream(instanceId, requestId, text, options, promise)
  }

  override fun generateTtsStreamToFile(
    instanceId: String,
    requestId: String,
    text: String,
    options: ReadableMap?,
    fileOptions: ReadableMap?,
    promise: Promise
  ) {
    onlineTtsHelper.generateTtsStreamToFile(
      instanceId,
      requestId,
      text,
      options,
      fileOptions,
      promise
    )
  }

  /**
   * Cancel ongoing streaming TTS.
   */
  override fun cancelTtsStream(instanceId: String, promise: Promise) {
    onlineTtsHelper.cancelTtsStream(instanceId, promise)
  }

  override fun createPcmPlayer(
    playerId: String,
    sampleRate: Double,
    channels: Double,
    feed: String,
    ttsInstanceId: String?,
    promise: Promise
  ) {
    pcmPlayerService.create(playerId, sampleRate, channels, feed, ttsInstanceId, promise)
  }

  override fun writePcmChunk(playerId: String, samples: ReadableArray, promise: Promise) {
    pcmPlayerService.write(playerId, samples, promise)
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

  private fun emitTtsStreamChunk(
    instanceId: String,
    requestId: String,
    samples: FloatArray,
    sampleRate: Int,
    progress: Float,
    isFinal: Boolean
  ) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    // Encode float PCM as base64 little-endian bytes (4 bytes per sample).
    // This replaces per-element pushDouble and avoids O(n) bridge marshalling.
    val pcmBase64 = if (samples.isNotEmpty()) {
      val bb = java.nio.ByteBuffer.allocate(samples.size * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN)
      bb.asFloatBuffer().put(samples)
      Base64.encodeToString(bb.array(), Base64.NO_WRAP)
    } else {
      ""
    }
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("requestId", requestId)
    payload.putString("pcmBase64", pcmBase64)
    payload.putInt("sampleRate", sampleRate)
    payload.putDouble("progress", progress.toDouble())
    payload.putBoolean("isFinal", isFinal)
    eventEmitter.emit("ttsStreamChunk", payload)
  }

  private fun emitTtsStreamError(instanceId: String, requestId: String, message: String) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("requestId", requestId)
    payload.putString("message", message)
    eventEmitter.emit("ttsStreamError", payload)
  }

  private fun emitTtsStreamEnd(instanceId: String, requestId: String, cancelled: Boolean) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("requestId", requestId)
    payload.putBoolean("cancelled", cancelled)
    eventEmitter.emit("ttsStreamEnd", payload)
  }

  private fun emitTtsStreamFileError(
    instanceId: String,
    requestId: String,
    message: String,
    path: String?
  ) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("requestId", requestId)
    payload.putString("message", message)
    if (!path.isNullOrBlank()) {
      payload.putString("path", path)
    }
    eventEmitter.emit("ttsStreamFileError", payload)
  }

  private fun emitTtsStreamFileEnd(
    instanceId: String,
    requestId: String,
    cancelled: Boolean,
    path: String,
    bytesWritten: Long,
    sampleRate: Int
  ) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("instanceId", instanceId)
    payload.putString("requestId", requestId)
    payload.putBoolean("cancelled", cancelled)
    payload.putString("path", path)
    payload.putDouble("bytesWritten", bytesWritten.toDouble())
    payload.putInt("sampleRate", sampleRate)
    eventEmitter.emit("ttsStreamFileEnd", payload)
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

  override fun enhanceFile(
    instanceId: String,
    inputPath: String,
    outputPath: String?,
    promise: Promise
  ) {
    enhancementHelper.enhanceFile(instanceId, inputPath, outputPath, promise)
  }

  override fun enhanceSamples(
    instanceId: String,
    samples: ReadableArray,
    sampleRate: Double,
    promise: Promise
  ) {
    enhancementHelper.enhanceSamples(instanceId, samples, sampleRate, promise)
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

  override fun feedEnhancementSamples(
    instanceId: String,
    samples: ReadableArray,
    sampleRate: Double,
    promise: Promise
  ) {
    enhancementHelper.feedSamples(instanceId, samples, sampleRate, promise)
  }

  override fun flushOnlineEnhancement(instanceId: String, promise: Promise) {
    enhancementHelper.flushOnline(instanceId, promise)
  }

  override fun resetOnlineEnhancement(instanceId: String, promise: Promise) {
    enhancementHelper.resetOnline(instanceId, promise)
  }

  override fun unloadOnlineEnhancement(instanceId: String, promise: Promise) {
    enhancementHelper.unloadOnline(instanceId, promise)
  }

  override fun saveTtsAudioFromPCM(
    samples: ReadableArray,
    sampleRate: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) {
    offlineTtsHelper.saveTtsAudioFromPCM(
      samples,
      sampleRate,
      destinationType,
      pathOrDirectoryUri,
      filename,
      format,
      outputSampleRateHz,
      promise
    )
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

    /** Convert any supported audio file to WAV 16 kHz mono 16-bit PCM. Returns empty string on success, error message otherwise. Requires FFmpeg prebuilts. */
    @JvmStatic
    private external fun nativeConvertAudioToWav16k(inputPath: String, outputPath: String): String

    /**
     * On success: [FloatArray samples, Integer sampleRate]. On error: [String message].
     */
    @JvmStatic
    private external fun nativeDecodeAudioFileToFloatSamples(inputPath: String, targetSampleRateHz: Int): Array<Any>

    /** Mono float32 little-endian raw PCM file to output format (requires FFmpeg). Empty = success. */
    @JvmStatic
    private external fun nativeConvertFloat32MonoFileToFormat(
      rawPath: String,
      pcmSampleRate: Int,
      outputPath: String,
      format: String,
      outputSampleRateHz: Int
    ): String
  }
}
