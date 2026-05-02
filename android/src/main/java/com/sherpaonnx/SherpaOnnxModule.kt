package com.sherpaonnx

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
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
import com.sherpaonnx.alignment.facade.SherpaOnnxAlignmentHelper
import com.sherpaonnx.archive.core.SherpaOnnxExtractionNotificationHelper
import com.sherpaonnx.archive.facade.SherpaOnnxArchiveHelper
import com.sherpaonnx.assets.facade.SherpaOnnxAssetHelper
import com.sherpaonnx.enhancement.facade.SherpaOnnxEnhancementHelper
import com.sherpaonnx.punctuation.facade.SherpaOnnxOnlinePunctuationHelper
import com.sherpaonnx.punctuation.facade.SherpaOnnxPunctuationHelper
import com.sherpaonnx.fileio.FileIOErrorCodes
import com.sherpaonnx.fileio.FileIOException
import com.sherpaonnx.stt.core.SttErrorCodes
import com.sherpaonnx.stt.facade.SherpaOnnxOnlineSttHelper
import com.sherpaonnx.stt.facade.SherpaOnnxSttHelper
import com.sherpaonnx.tts.core.SherpaOnnxTtsCoordinator
import com.sherpaonnx.tts.facade.SherpaOnnxCommonTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOfflineTtsHelper
import com.sherpaonnx.tts.facade.SherpaOnnxOnlineTtsHelper
import com.sherpaonnx.vad.facade.SherpaOnnxVadHelper
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

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
    com.sherpaonnx.segment.pipeline.SegmentBufferEventBridge.emitSegmentAppended = { segmentBufferId, rec, segIdx, totalSeg ->
      try {
        val eventEmitter = reactApplicationContext
          .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        val annotation = com.sherpaonnx.segment.engine.SegmentationEngineRegistry
          .peekSegmentAnnotation(rec.id)
        val m = com.facebook.react.bridge.Arguments.createMap()
        m.putString("segmentBufferId", segmentBufferId)
        m.putString("segmentId", rec.id)
        m.putInt("segmentIndex", segIdx)
        m.putInt("totalSegments", totalSeg)
        m.putString("sourceAudioBufferId", rec.sourceAudioBufferId)
        m.putInt("startSample", rec.startSample)
        m.putInt("endSample", rec.endSample)
        m.putInt("sampleRate", rec.sampleRate)
        m.putInt("durationMs", rec.durationMs)
        if (annotation != null) {
          m.putString("reason", annotation.reason)
          m.putString("source", annotation.source)
          m.putDouble("createdAtMs", annotation.createdAtMs.toDouble())
        } else {
          m.putString("reason", "manual_commit")
          m.putString("source", "manual")
          m.putDouble("createdAtMs", System.currentTimeMillis().toDouble())
        }
        rec.confidence?.let { m.putDouble("confidence", it) }
        if (!rec.payloadJson.isNullOrEmpty()) {
          try {
            val jo = org.json.JSONObject(rec.payloadJson)
            val p = com.sherpaonnx.segment.pipeline.JsonToReactUtils.jsonObjectToWritableMap(jo)
            m.putMap("payload", p)
          } catch (_: Exception) {
          }
        }
        eventEmitter.emit("pipelineLiveSegmentAppended", m)
      } catch (_: Exception) {
      }
    }
    tryInstallJsiBindings()
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
  private val pcmPlayerService = PcmPlayerService(reactApplicationContext).also {
    it.onPlayerEnded = { playerId, bufferId ->
      try {
        val eventEmitter = reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        val payload = Arguments.createMap()
        payload.putString("playerId", playerId)
        payload.putString("bufferId", bufferId)
        eventEmitter.emit("pcmPlayerEnded", payload)
      } catch (_: Exception) {
        // JS context may be torn down
      }
    }
  }
  private val ttsHelper = SherpaOnnxTtsCoordinator(
    reactApplicationContext,
    { modelDir, assetName, modelType -> Companion.nativeDetectTtsModel(modelDir, assetName, modelType) },
  )
  private val offlineTtsHelper = SherpaOnnxOfflineTtsHelper(ttsHelper)
  private val onlineTtsHelper = SherpaOnnxOnlineTtsHelper(ttsHelper)
  private val commonTtsHelper = SherpaOnnxCommonTtsHelper(ttsHelper)
  private val fileIOHelper = com.sherpaonnx.fileio.FileIOHelper(reactApplicationContext)
  private val alignmentHelper = SherpaOnnxAlignmentHelper()
  private val enhancementHelper = SherpaOnnxEnhancementHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType -> Companion.nativeDetectEnhancementModel(modelDir, assetName, modelType) }
  )
  private val archiveHelper = SherpaOnnxArchiveHelper()
  private val vadHelper = SherpaOnnxVadHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType ->
      Companion.nativeDetectVadModel(modelDir, assetName, modelType)
    }
  )
  private val punctuationHelper = SherpaOnnxPunctuationHelper(
    { modelDir, assetName, modelType ->
      Companion.nativeDetectPunctuationModel(modelDir, assetName, modelType)
    }
  )
  private val onlinePunctuationHelper = SherpaOnnxOnlinePunctuationHelper(
    reactApplicationContext,
    { modelDir, assetName, modelType ->
      Companion.nativeDetectPunctuationModel(modelDir, assetName, modelType)
    }
  )
  private var micToLiveSink: com.sherpaonnx.audio.pipeline.MicToLiveBufferSink? = null
  private val liveTextPartialLastEmitAtMs = ConcurrentHashMap<String, Long>()
  private val maxEventTextChars = 4096

  private fun truncateSegmentEventText(text: String): Pair<String, Boolean> {
    if (text.length <= maxEventTextChars) {
      return Pair(text, false)
    }
    return Pair(text.substring(0, maxEventTextChars), true)
  }

  private fun maybeEmitLiveTextPartial(
    entry: com.sherpaonnx.text.pipeline.LiveTextEntry,
    source: String,
  ) {
    if (!entry.emitPartialEvents) return

    val now = SystemClock.elapsedRealtime()
    val minInterval = entry.partialEventMinIntervalMs.coerceAtLeast(0L)
    val last = liveTextPartialLastEmitAtMs[entry.bufferId] ?: 0L
    if (minInterval > 0L && last > 0L && (now - last) < minInterval) {
      return
    }
    liveTextPartialLastEmitAtMs[entry.bufferId] = now

    try {
      val eventEmitter = reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val payload = Arguments.createMap()
      payload.putString("liveBufferId", entry.bufferId)
      payload.putString("source", source)
      payload.putString("partialText", entry.currentText)
      payload.putInt("revision", entry.revision)
      eventEmitter.emit("pipelineLiveTextPartial", payload)
    } catch (_: Exception) {
      // JS bridge may be unavailable during teardown.
    }
  }

  private fun emitLiveTextSegment(
    liveBufferId: String,
    segment: com.sherpaonnx.text.pipeline.TextSegment,
    totalSegments: Int,
  ) {
    try {
      val eventEmitter = reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val (eventText, textTruncated) = truncateSegmentEventText(segment.text)
      val payload = Arguments.createMap().apply {
        putString("liveBufferId", liveBufferId)
        putInt("totalSegments", totalSegments)
        putString("text", eventText)
        if (textTruncated) {
          putBoolean("textTruncated", true)
        }
        putString("source", segment.source)
        putInt("segmentIndex", segment.segmentIndex)

        if (segment.tokens.isNotEmpty()) {
          val tokenArray = Arguments.createArray()
          segment.tokens.forEach { tokenArray.pushString(it) }
          putArray("tokens", tokenArray)
        }

        if (segment.timestamps.isNotEmpty()) {
          val tsArray = Arguments.createArray()
          segment.timestamps.forEach { tsArray.pushDouble(it.toDouble()) }
          putArray("timestamps", tsArray)
        }

        segment.meta?.let { rawMeta ->
          try {
            putMap("meta", Arguments.makeNativeMap(HashMap(rawMeta)))
          } catch (_: Exception) {
            // Ignore non-serializable meta values.
          }
        }
      }
      eventEmitter.emit("pipelineLiveTextSegmentAppended", payload)
    } catch (_: Exception) {
      // JS bridge may be unavailable during teardown.
    }
  }

  private fun normalizeInputDeviceKind(type: Int): String {
    return when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built_in_mic"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
      AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
      AudioDeviceInfo.TYPE_HDMI,
      AudioDeviceInfo.TYPE_HDMI_ARC,
      AudioDeviceInfo.TYPE_HDMI_EARC -> "hdmi"
      AudioDeviceInfo.TYPE_FM_TUNER -> "fm"
      AudioDeviceInfo.TYPE_LINE_ANALOG,
      AudioDeviceInfo.TYPE_LINE_DIGITAL -> "line"
      else -> "unknown"
    }
  }

  private external fun nativeInstallJSI(jsiRuntimePointer: Long, registry: Any): Boolean

  private fun tryInstallJsiBindings(): Boolean {
    return try {
      val jsContextHolder = reactApplicationContext.javaScriptContextHolder ?: return false
      val jsContext = jsContextHolder.get()
      if (jsContext == 0L) {
        false
      } else {
        nativeInstallJSI(jsContext, PipelineAudioRegistry)
      }
    } catch (_: Exception) {
      false
    }
  }

  override fun initialize() {
    super.initialize()
    tryInstallJsiBindings()
    com.sherpaonnx.audio.session.PaAudioSessionCoordinator.initialize(reactApplicationContext)
    PipelineAudioRegistry.initializeWithCacheDir(
      reactApplicationContext,
      reactApplicationContext.cacheDir
    )
    com.sherpaonnx.text.pipeline.TextPipelineRegistry.initializeWithCacheDir(
      reactApplicationContext.cacheDir
    )
    com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.initializeWithCacheDir(
      reactApplicationContext.cacheDir
    )
  }

  private fun emitPipelineLiveAudioChunk(event: com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent) {
    val eventEmitter = reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    val payload = Arguments.createMap()
    payload.putString("liveBufferId", event.liveBufferId)
    payload.putString("source", event.source)
    payload.putInt("sampleRate", event.sampleRate)
    payload.putInt("frameCount", event.frameCount)
    payload.putDouble("totalSamplesWritten", event.totalSamplesWritten.toDouble())
    eventEmitter.emit("pipelineLiveAudioChunk", payload)
  }

  override fun installJSI(): Boolean {
    return tryInstallJsiBindings()
  }

  override fun getName(): String {
    return NAME
  }

  override fun invalidate() {
    super.invalidate()
    micToLiveSink?.stop()
    micToLiveSink = null
    liveTextPartialLastEmitAtMs.clear()
    onlineSttHelper.shutdown()
    commonTtsHelper.shutdown()
    alignmentHelper.shutdown()
    enhancementHelper.shutdown()
    punctuationHelper.shutdown()
    onlinePunctuationHelper.shutdown()
    vadHelper.shutdown()
    pcmPlayerService.shutdown()
    com.sherpaonnx.audio.session.PaAudioSessionCoordinator.resetAll()
    com.sherpaonnx.segment.engine.SegmentationEngineRegistry.releaseAll()
    com.sherpaonnx.text.pipeline.TextPipelineRegistry.releaseAll()
    com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.releaseAll()
    com.sherpaonnx.segment.core.SegmentLinkMapRegistry.releaseAll()
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

  // ── Pipeline Audio Session Coordinator ──────────────────────────────────────

  override fun configurePipelineAudioSession(config: ReadableMap?, promise: Promise) {
    try {
      val keepActiveWhenIdle = config?.takeIf { it.hasKey("keepActiveWhenIdle") && !it.isNull("keepActiveWhenIdle") }
        ?.getBoolean("keepActiveWhenIdle") ?: false
      com.sherpaonnx.audio.session.PaAudioSessionCoordinator.configurePolicy(keepActiveWhenIdle)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("AUDIO_SESSION_CONFIG_ERROR", e.message, e)
    }
  }

  override fun setPipelineAudioRoutePreference(inputDeviceId: String?, outputDeviceId: String?, promise: Promise) {
    try {
      val inputId = inputDeviceId?.trim()?.takeIf { it.isNotEmpty() }?.toIntOrNull()
      val outputId = outputDeviceId?.trim()?.takeIf { it.isNotEmpty() }?.toIntOrNull()
      com.sherpaonnx.audio.session.PaAudioSessionCoordinator.setRoutePreference(inputId, outputId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("AUDIO_SESSION_ROUTE_ERROR", e.message, e)
    }
  }

  override fun clearPipelineAudioRoutePreference(promise: Promise) {
    try {
      com.sherpaonnx.audio.session.PaAudioSessionCoordinator.clearRoutePreference()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("AUDIO_SESSION_ROUTE_ERROR", e.message, e)
    }
  }

  override fun getPipelineAudioSessionState(promise: Promise) {
    try {
      val snapshot = com.sherpaonnx.audio.session.PaAudioSessionCoordinator.stateSnapshot()
      val map = Arguments.createMap()
      map.putBoolean("active", snapshot["active"] as? Boolean ?: false)
      map.putString("profile", snapshot["profile"] as? String ?: "inactive")
      map.putInt("activeMicOwners", snapshot["activeMicOwners"] as? Int ?: 0)
      map.putInt("activePcmOwners", snapshot["activePcmOwners"] as? Int ?: 0)
      val prefInput = snapshot["preferredInputDeviceId"] as? String
      if (prefInput != null) map.putString("preferredInputDeviceId", prefInput) else map.putNull("preferredInputDeviceId")
      val prefOutput = snapshot["preferredOutputDeviceId"] as? String
      if (prefOutput != null) map.putString("preferredOutputDeviceId", prefOutput) else map.putNull("preferredOutputDeviceId")
      val curInput = snapshot["currentInputDeviceId"] as? String
      if (curInput != null) map.putString("currentInputDeviceId", curInput) else map.putNull("currentInputDeviceId")
      val curOutput = snapshot["currentOutputDeviceId"] as? String
      if (curOutput != null) map.putString("currentOutputDeviceId", curOutput) else map.putNull("currentOutputDeviceId")
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("AUDIO_SESSION_STATE_ERROR", e.message, e)
    }
  }

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

  // ─── FileSource helpers ──────────────────────────────────────────────

  override fun resolveAppBaseDir(base: String, promise: Promise) {
    try {
      val dir = when (base) {
        "cache" -> reactApplicationContext.cacheDir
        "documents" -> java.io.File(reactApplicationContext.filesDir, "docs")
        "files" -> reactApplicationContext.filesDir
        "tmp" -> java.io.File(reactApplicationContext.cacheDir, "tmp")
        "externalFiles" -> reactApplicationContext.getExternalFilesDir(null)
          ?: throw FileIOException(
            FileIOErrorCodes.UNSUPPORTED_ON_PLATFORM,
            "No external files directory available"
          )
        else -> throw FileIOException(
          FileIOErrorCodes.UNSUPPORTED_LOCATION_KIND,
          "Unknown AppBaseDir: $base"
        )
      }

      if (!dir.exists() && !dir.mkdirs() && !dir.exists()) {
        throw FileIOException(
          FileIOErrorCodes.WRITE_ERROR,
          "Failed to create app base directory: ${dir.absolutePath}"
        )
      }

      promise.resolve(dir.absolutePath)
    } catch (e: FileIOException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(
        FileIOErrorCodes.RESOLVE_ERROR,
        "Failed to resolve app base directory: ${e.message}",
        e
      )
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
      val isStreaming = result["isStreaming"] as? Boolean ?: false
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
      resultMap.putBoolean("isStreaming", isStreaming)
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

  // Map of operationId → cancel flag for active decode operations
  private val decodeCancelFlags = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicBoolean>()
  // Map of ingestId → ingest status for active file ingest operations
  private val fileIngestStatuses = java.util.concurrent.ConcurrentHashMap<String, FileIngestStatus>()
  private val decodeExecutor = java.util.concurrent.Executors.newCachedThreadPool()

  private data class FileIngestStatus(
    @Volatile var isRunning: Boolean = true,
    @Volatile var framesIngested: Long = 0,
    @Volatile var totalFramesEstimate: Long = 0,
    @Volatile var percent: Int = 0,
    @Volatile var error: String? = null,
  )

  private fun emitDecodeProgress(
    operationId: String,
    framesDecoded: Long,
    totalFramesEstimate: Long,
    percent: Int,
    sourceSampleRate: Int,
    sourceChannels: Int,
  ) {
    try {
      val eventEmitter = reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val payload = Arguments.createMap()
      payload.putString("operationId", operationId)
      payload.putDouble("framesDecoded", framesDecoded.toDouble())
      payload.putDouble("totalFramesEstimate", totalFramesEstimate.toDouble())
      payload.putInt("percent", percent)
      payload.putInt("sourceSampleRate", sourceSampleRate)
      payload.putInt("sourceChannels", sourceChannels)
      eventEmitter.emit("decodeProgress", payload)
    } catch (_: Exception) {
      // Ignore event emission failures (e.g. bridge teardown)
    }
  }

  private fun emitDecodeComplete(
    operationId: String,
    success: Boolean,
    error: String? = null,
    errorCode: String? = null,
    totalFramesIngested: Long = 0,
    sourceSampleRate: Int = 0,
    sourceChannels: Int = 0,
    autoFinalized: Boolean = false,
  ) {
    try {
      val eventEmitter = reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val payload = Arguments.createMap()
      payload.putString("operationId", operationId)
      payload.putBoolean("success", success)
      if (error != null) payload.putString("error", error)
      if (errorCode != null) payload.putString("errorCode", errorCode)
      payload.putDouble("totalFramesIngested", totalFramesIngested.toDouble())
      payload.putInt("sourceSampleRate", sourceSampleRate)
      payload.putInt("sourceChannels", sourceChannels)
      payload.putBoolean("autoFinalized", autoFinalized)
      eventEmitter.emit("decodeComplete", payload)
    } catch (_: Exception) {
      // Ignore event emission failures
    }
  }

  private data class DecodableSource(
    val path: String?,
    val fd: Int,
    val tempFile: File? = null,
  )

  private fun resolveDecodableSource(
    handle: com.sherpaonnx.fileio.FileIOResolver.ReadHandle
  ): DecodableSource {
    return when (handle) {
      is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.FilePath ->
        DecodableSource(path = handle.file.absolutePath, fd = -1)
      is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.FileDescriptor ->
        DecodableSource(path = null, fd = handle.pfd.fd)
      is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.Stream -> {
        val tmpFile = File(
          reactApplicationContext.cacheDir,
          "decode_stream_${java.util.UUID.randomUUID()}"
        )
        try {
          tmpFile.outputStream().use { out ->
            handle.inputStream.copyTo(out, 65536)
          }
        } catch (e: Exception) {
          try { tmpFile.delete() } catch (_: Exception) {}
          throw FileIOException(
            FileIOErrorCodes.READ_ERROR,
            "Failed to materialize stream source for decode",
            e
          )
        }
        DecodableSource(path = tmpFile.absolutePath, fd = -1, tempFile = tmpFile)
      }
    }
  }

  override fun decodeFileToOfflineBuffer(source: ReadableMap, targetSampleRateHz: Double, forceMono: Boolean, operationId: String, promise: Promise) {
    val cancelFlag = java.util.concurrent.atomic.AtomicBoolean(false)
    decodeCancelFlags[operationId] = cancelFlag

    decodeExecutor.execute {
      var readHandle: com.sherpaonnx.fileio.FileIOResolver.ReadHandle? = null
      var tempSourceFile: File? = null

      try {
        readHandle = fileIOHelper.resolveSource(source)
        val decodableSource = resolveDecodableSource(
          readHandle ?: throw IllegalStateException("Resolved read handle is null")
        )
        val sourcePath = decodableSource.path
        val sourceFd = decodableSource.fd
        tempSourceFile = decodableSource.tempFile

        val targetRate = if (targetSampleRateHz > 0) targetSampleRateHz.toInt() else 0

        // Use AudioDecodeSession via JNI (C++ FFmpeg + WAV fast path)
        val cancelFlagAddr = nativeAllocateCancelFlag()
        if (cancelFlag.get()) {
          nativeFreeCancelFlag(cancelFlagAddr)
          throw RuntimeException("DECODE_CANCELLED: Operation cancelled")
        }
        // Link our AtomicBoolean to the native flag
        val cancelChecker = Thread {
          while (!cancelFlag.get()) {
            try { Thread.sleep(50) } catch (_: InterruptedException) { break }
          }
          nativeSetCancelFlag(cancelFlagAddr, true)
        }
        cancelChecker.isDaemon = true
        cancelChecker.start()

        try {
          // Streaming decode: write float32 chunks directly to a temp .f32 file,
          // avoiding any large heap allocation (OOM fix for big files).
          val dir = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.cacheDir
            ?: reactApplicationContext.cacheDir
          val tmpF32 = java.io.File(dir, "pa_off_decode_${java.util.UUID.randomUUID()}.f32")

          @Suppress("UNCHECKED_CAST")
          val result = nativeDecodeFileToMmapFile(
            sourcePath,
            sourceFd,
            targetRate,
            forceMono,
            8192,
            cancelFlagAddr,
            tmpF32.absolutePath
          ) as? HashMap<String, Any> ?: throw RuntimeException("DECODE_INTERNAL_ERROR: Null result from native decode")

          cancelChecker.interrupt()

          val numSamples = (result["numSamples"] as? Long)?.toInt() ?: 0
          val srcSampleRate = (result["sourceSampleRate"] as? Int) ?: 0
          val outputRate = if (targetRate > 0) targetRate else srcSampleRate

          if (numSamples <= 0) {
            tmpF32.delete()
            throw RuntimeException("DECODE_EMPTY: No samples decoded")
          }

          val rawSize = numSamples.toLong() * 4
          val threshold = com.sherpaonnx.audio.pipeline.MmapThresholdPolicy.thresholdBytes(
            com.sherpaonnx.audio.pipeline.ThresholdPathType.FILE_ORIGIN
          )
          val entry = if (rawSize >= threshold) {
            // Large file: mmap the temp .f32 directly (zero heap copy)
            com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createOfflineFromMmapFile(
              tmpF32.absolutePath, numSamples, outputRate, 1
            )
          } else {
            // Small file: read into heap and delete temp file
            val samples = FloatArray(numSamples)
            java.io.RandomAccessFile(tmpF32, "r").use { raf ->
              val buf = java.nio.ByteBuffer.allocate(numSamples * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN)
              raf.channel.read(buf)
              buf.flip()
              buf.asFloatBuffer().get(samples)
            }
            tmpF32.delete()
            com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createOfflineFromFloatArray(
              samples, outputRate, 1
            )
          }

          promise.resolve(entry.toWritableMap())
        } finally {
          nativeFreeCancelFlag(cancelFlagAddr)
          cancelChecker.interrupt()
        }
      } catch (e: com.sherpaonnx.fileio.FileIOException) {
        promise.reject(e.code, e.message, e)
      } catch (e: RuntimeException) {
        val msg = e.message ?: ""
        val code = if (msg.startsWith("DECODE_")) msg.substringBefore(":").trim() else "DECODE_INTERNAL_ERROR"
        promise.reject(code, msg, e)
      } catch (e: Exception) {
        promise.reject("DECODE_INTERNAL_ERROR", e.message, e)
      } finally {
        decodeCancelFlags.remove(operationId)
        try { readHandle?.close() } catch (_: Exception) {}
        try { tempSourceFile?.delete() } catch (_: Exception) {}
      }
    }
  }

  override fun startFileIngestToLiveBuffer(
    liveBufferId: String,
    source: ReadableMap,
    targetSampleRateHz: Double,
    forceMono: Boolean,
    autoFinalize: Boolean,
    backpressure: String,
    operationId: String,
    promise: Promise
  ) {
    val ingestId = "ingest_${java.util.UUID.randomUUID()}"
    val cancelFlag = java.util.concurrent.atomic.AtomicBoolean(false)
    decodeCancelFlags[operationId] = cancelFlag
    val status = FileIngestStatus()
    fileIngestStatuses[ingestId] = status

    // Validate buffer exists and is RECORDING before resolving file
    val liveEntry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLive(liveBufferId)
    if (liveEntry == null) {
      if (com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.isInvalidatedLiveBuffer(liveBufferId)) {
        promise.reject(
          com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED,
          "Live buffer was transferred and is invalidated: $liveBufferId"
        )
      } else {
        promise.reject("AUDIO_BUFFER_NOT_FOUND", "Live buffer not found: $liveBufferId")
      }
      return
    }
    if (liveEntry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.RECORDING) {
      promise.reject("AUDIO_INVALID_STATE", "Live buffer must be in RECORDING state for file ingest")
      return
    }
    val useBackpressure = when (backpressure) {
      "block" -> true
      "none" -> false
      else -> {
        promise.reject(
          com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT,
          "backpressure must be 'block' or 'none'"
        )
        return
      }
    }

    // Ensure spool is active — create a temporary one if the buffer was created without persistencePath
    if (!liveEntry.hasActiveSpool) {
      try {
        val tmpSpoolPath = File(
          reactApplicationContext.cacheDir,
          "ingest_spool_${java.util.UUID.randomUUID()}.wav"
        ).absolutePath
        liveEntry.enableSpool(
          com.sherpaonnx.audio.pipeline.PersistenceConfig(tmpSpoolPath),
          temporary = true
        )
      } catch (e: Exception) {
        promise.reject("AUDIO_SPOOL_ERROR", "Failed to create temporary spool for file ingest: ${e.message}", e)
        return
      }
    }

    // Resolve file source synchronously, then run decode on background thread
    val readHandle: com.sherpaonnx.fileio.FileIOResolver.ReadHandle
    var sourcePath: String? = null
    var sourceFd: Int = -1
    var tempSourceFile: File? = null
    try {
      readHandle = fileIOHelper.resolveSource(source)
      val decodableSource = resolveDecodableSource(readHandle)
      sourcePath = decodableSource.path
      sourceFd = decodableSource.fd
      tempSourceFile = decodableSource.tempFile
    } catch (e: com.sherpaonnx.fileio.FileIOException) {
      decodeCancelFlags.remove(operationId)
      fileIngestStatuses.remove(ingestId)
      promise.reject(e.code, e.message, e)
      return
    } catch (e: Exception) {
      decodeCancelFlags.remove(operationId)
      fileIngestStatuses.remove(ingestId)
      promise.reject("DECODE_INTERNAL_ERROR", e.message, e)
      return
    }

    // Resolve promise immediately with ingestId, then run decode on background
    val resultMap = Arguments.createMap()
    resultMap.putString("ingestId", ingestId)
    promise.resolve(resultMap)

    decodeExecutor.execute {
      val cancelFlagAddr = nativeAllocateCancelFlag()
      val cancelChecker = Thread {
        while (!cancelFlag.get()) {
          try { Thread.sleep(50) } catch (_: InterruptedException) { break }
        }
        nativeSetCancelFlag(cancelFlagAddr, true)
      }
      cancelChecker.isDaemon = true
      cancelChecker.start()

      var srcSampleRate = 0
      var srcChannels = 0

      try {
        val targetRate = if (targetSampleRateHz > 0) targetSampleRateHz.toInt() else 0

        // Streaming decode: chunks are appended to live buffer as they arrive
        val chunkCallback = object {
          fun onChunk(samples: FloatArray, frameCount: Int) {
            if (cancelFlag.get()) return
            try {
              when (
                liveEntry.tryAppendSamples(
                  samples,
                  liveEntry.sampleRate,
                  com.sherpaonnx.audio.pipeline.LIVE_APPEND_SOURCE_FILE_INGEST,
                  backpressure = useBackpressure
                )
              ) {
                com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.APPENDED -> {
                  status.framesIngested += frameCount
                }
                com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.BUFFER_FINALIZED -> {
                  cancelFlag.set(true)
                }
              }
            } catch (_: Throwable) {
              // Listener/spool/segmentation hooks must not crash native decode thread / JNI.
              cancelFlag.set(true)
            }
          }
        }

        val progressCallback = object {
          fun onProgress(framesDecoded: Long, totalEstimate: Long, percent: Int, sourceSr: Int, sourceCh: Int) {
            srcSampleRate = sourceSr
            srcChannels = sourceCh
            status.totalFramesEstimate = totalEstimate
            status.percent = percent
            emitDecodeProgress(operationId, framesDecoded, totalEstimate, percent, sourceSr, sourceCh)
          }
        }

        @Suppress("UNCHECKED_CAST")
        val result = nativeDecodeFileStreaming(
          sourcePath,
          sourceFd,
          targetRate,
          forceMono,
          8192,
          cancelFlagAddr,
          chunkCallback,
          progressCallback
        ) as? HashMap<String, Any>

        if (result != null) {
          srcSampleRate = (result["sourceSampleRate"] as? Int) ?: srcSampleRate
          srcChannels = (result["sourceChannels"] as? Int) ?: srcChannels
        }

        if (autoFinalize) {
          liveEntry.finalize_()
        }

        status.isRunning = false
        status.percent = 100

        emitDecodeComplete(
          operationId = operationId,
          success = true,
          totalFramesIngested = status.framesIngested,
          sourceSampleRate = srcSampleRate,
          sourceChannels = srcChannels,
          autoFinalized = autoFinalize,
        )
      } catch (e: RuntimeException) {
        val msg = e.message ?: "Unknown error"
        val code = if (msg.startsWith("DECODE_")) msg.substringBefore(":").trim() else "DECODE_INTERNAL_ERROR"
        status.isRunning = false
        status.error = msg

        emitDecodeComplete(
          operationId = operationId,
          success = false,
          error = msg,
          errorCode = code,
        )
      } catch (e: Exception) {
        status.isRunning = false
        status.error = e.message

        emitDecodeComplete(
          operationId = operationId,
          success = false,
          error = e.message,
          errorCode = "DECODE_INTERNAL_ERROR",
        )
      } finally {
        nativeFreeCancelFlag(cancelFlagAddr)
        cancelChecker.interrupt()
        decodeCancelFlags.remove(operationId)
        try { readHandle.close() } catch (_: Exception) {}
        try { tempSourceFile?.delete() } catch (_: Exception) {}
      }
    }
  }

  override fun getFileIngestStatus(ingestId: String, promise: Promise) {
    val status = fileIngestStatuses[ingestId]
    if (status == null) {
      val resultMap = Arguments.createMap()
      resultMap.putBoolean("isRunning", false)
      resultMap.putDouble("framesIngested", 0.0)
      resultMap.putDouble("totalFramesEstimate", 0.0)
      resultMap.putInt("percent", 0)
      resultMap.putString("error", "Ingest not found: $ingestId")
      promise.resolve(resultMap)
      return
    }
    val resultMap = Arguments.createMap()
    resultMap.putBoolean("isRunning", status.isRunning)
    resultMap.putDouble("framesIngested", status.framesIngested.toDouble())
    resultMap.putDouble("totalFramesEstimate", status.totalFramesEstimate.toDouble())
    resultMap.putInt("percent", status.percent)
    if (status.error != null) resultMap.putString("error", status.error)
    promise.resolve(resultMap)
  }

  override fun cancelDecode(operationId: String, promise: Promise) {
    val flag = decodeCancelFlags[operationId]
    if (flag != null) {
      flag.set(true)
    }
    promise.resolve(null)
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
    } catch (e: com.sherpaonnx.audio.pipeline.BufferInvalidatedException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun transferOfflineAudioBufferFromLive(liveBufferId: String, mode: String?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.transferOfflineFromLive(
        liveBufferId,
        mode ?: "fullIfSpooled"
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.audio.pipeline.TransferException) {
      promise.reject(e.code, e.message, e)
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

  override fun populateOfflineAudioBufferIfEmpty(
    targetBufferId: String,
    sourceBufferId: String,
    _options: ReadableMap?,
    promise: Promise,
  ) {
    try {
      com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.populateOfflineIfEmpty(
        targetBufferId = targetBufferId,
        sourceBufferId = sourceBufferId,
      )
      promise.resolve(null)
    } catch (e: IllegalStateException) {
      promise.reject(
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE,
        e.message,
        e
      )
    } catch (e: IllegalArgumentException) {
      val msg = e.message ?: ""
      val code = if (
        msg.contains("not found", ignoreCase = true)
      ) {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND
      } else {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT
      }
      promise.reject(code, e.message, e)
    } catch (e: Exception) {
      promise.reject(
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR,
        e.message,
        e
      )
    }
  }

  override fun createEmptyLiveAudioBuffer(options: ReadableMap, promise: Promise) {
    try {
      val sampleRate = options.getDouble("sampleRate").toInt()
      val channelCount = if (options.hasKey("channelCount")) options.getDouble("channelCount").toInt() else 1
      val ringSeconds = if (options.hasKey("ringSeconds")) options.getDouble("ringSeconds") else 60.0

      val emitAppendedEvents =
        options.hasKey("emitAppendedEvents") && !options.isNull("emitAppendedEvents") && options.getBoolean("emitAppendedEvents")
      val appendEventMinIntervalMs =
        if (options.hasKey("appendEventMinIntervalMs") && !options.isNull("appendEventMinIntervalMs")) {
          options.getDouble("appendEventMinIntervalMs").toInt().coerceAtLeast(0)
        } else {
          0
        }

      // Parse retention options
      val retentionModeStr = if (options.hasKey("retentionMode") && !options.isNull("retentionMode"))
        options.getString("retentionMode") else "auto"
      val retentionSeconds = if (options.hasKey("retentionSeconds") && !options.isNull("retentionSeconds"))
        options.getDouble("retentionSeconds") else 0.0
      val retentionPath = if (options.hasKey("retentionPath") && !options.isNull("retentionPath"))
        options.getString("retentionPath") else null

      val persistence: com.sherpaonnx.audio.pipeline.PersistenceConfig? = when (retentionModeStr) {
        "none" -> null
        "auto" -> {
          // Auto currently keeps session-long spool data (trim enforcement not implemented yet).
          val tempDir = reactApplicationContext.cacheDir
          val tempPath = java.io.File(tempDir, "live_spool_${System.currentTimeMillis()}.wav").absolutePath
          com.sherpaonnx.audio.pipeline.PersistenceConfig(
            filePath = tempPath,
            retentionMode = com.sherpaonnx.audio.pipeline.RetentionMode.AUTO,
          )
        }
        "session" -> {
          val path = retentionPath ?: run {
            val tempDir = reactApplicationContext.cacheDir
            java.io.File(tempDir, "live_spool_${System.currentTimeMillis()}.wav").absolutePath
          }
          com.sherpaonnx.audio.pipeline.PersistenceConfig(
            filePath = path,
            retentionMode = com.sherpaonnx.audio.pipeline.RetentionMode.SESSION,
          )
        }
        "maxSeconds" -> {
          if (retentionSeconds <= 0.0) {
            throw IllegalArgumentException("retention mode 'maxSeconds' requires retentionSeconds > 0")
          }
          val path = retentionPath ?: run {
            val tempDir = reactApplicationContext.cacheDir
            java.io.File(tempDir, "live_spool_${System.currentTimeMillis()}.wav").absolutePath
          }
          com.sherpaonnx.audio.pipeline.PersistenceConfig(
            filePath = path,
            retentionMode = com.sherpaonnx.audio.pipeline.RetentionMode.MAX_SECONDS,
            retentionSeconds = retentionSeconds,
          )
        }
        "path" -> {
          val path = retentionPath ?: throw IllegalArgumentException("retention mode 'path' requires a retentionPath")
          val trimStr = if (options.hasKey("retentionTrim") && !options.isNull("retentionTrim"))
            options.getString("retentionTrim") else "session"
          val mode = when (trimStr) {
            "auto" -> com.sherpaonnx.audio.pipeline.RetentionMode.AUTO
            "maxSeconds" -> com.sherpaonnx.audio.pipeline.RetentionMode.MAX_SECONDS
            "session" -> com.sherpaonnx.audio.pipeline.RetentionMode.SESSION
            else -> throw IllegalArgumentException("Unknown retentionTrim '$trimStr'. Valid values are: 'auto', 'maxSeconds', 'session'.")
          }
          val trimMaxSeconds = if (trimStr == "maxSeconds" && options.hasKey("retentionTrimMaxSeconds") && !options.isNull("retentionTrimMaxSeconds"))
            options.getDouble("retentionTrimMaxSeconds") else 0.0
          if (trimStr == "maxSeconds" && trimMaxSeconds <= 0.0) {
            throw IllegalArgumentException("retentionTrim 'maxSeconds' requires retentionTrimMaxSeconds > 0")
          }
          com.sherpaonnx.audio.pipeline.PersistenceConfig(
            filePath = path,
            retentionMode = mode,
            retentionSeconds = trimMaxSeconds,
          )
        }
        else -> throw IllegalArgumentException("Unknown retentionMode '$retentionModeStr'")
      }

      val isTemporary = retentionModeStr != "path" && persistence != null

      val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.createLive(
        sampleRate = sampleRate,
        channelCount = channelCount,
        windowSeconds = ringSeconds,
        persistence = persistence,
        appendEventConfig = com.sherpaonnx.audio.pipeline.LiveAppendEventConfig(
          enabled = emitAppendedEvents,
          minIntervalMs = appendEventMinIntervalMs,
        ),
        onFramesAppended = { event ->
          emitPipelineLiveAudioChunk(event)
        },
        isTemporarySpool = isTemporary,
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message, e)
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
      val code = if ((e.message ?: "").contains("invalidated", ignoreCase = true)) {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED
      } else {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.ALREADY_FINALIZED
      }
      promise.reject(code, e.message, e)
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
    } catch (e: IllegalStateException) {
      val code = if ((e.message ?: "").contains("invalidated", ignoreCase = true)) {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED
      } else {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE
      }
      promise.reject(code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  // Map of operationId → cancel flag for active audio save operations
  private val saveCancelFlags = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicBoolean>()

  private fun validateAudioSaveParams(format: String, rate: Int, promise: Promise): Boolean {
    val supportedFormats = setOf("wav", "mp3", "flac", "aac", "m4a", "opus", "webm", "mkv", "ogg")
    if (!supportedFormats.contains(format.lowercase())) {
      promise.reject("AUDIO_SAVE_UNSUPPORTED_FORMAT", "Unsupported format: $format")
      return false
    }
    if (rate < 0) {
      promise.reject("AUDIO_SAVE_INVALID_SAMPLE_RATE", "outputSampleRateHz must be >= 0")
      return false
    }
    val fmt = format.lowercase()
    if (fmt == "mp3" && rate != 0 && rate != 32000 && rate != 44100 && rate != 48000) {
      promise.reject("AUDIO_SAVE_INVALID_SAMPLE_RATE", "MP3 output sample rate must be 32000, 44100, 48000, or 0. Received: $rate")
      return false
    }
    if ((fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") && rate != 0 && rate !in setOf(8000, 12000, 16000, 24000, 48000)) {
      promise.reject("AUDIO_SAVE_INVALID_SAMPLE_RATE", "Opus output sample rate must be 8000, 12000, 16000, 24000, 48000, or 0. Received: $rate")
      return false
    }
    return true
  }

  private data class ResolvedDestination(
    val outputPath: String,
    val outputKind: String,
    val resolvedOutputPath: String,
    val writeHandle: com.sherpaonnx.fileio.FileIOResolver.WriteHandle,
    val tmpFile: File?
  )

  private fun resolveDestinationForSave(destination: ReadableMap, fmt: String): ResolvedDestination {
    val writeHandle = fileIOHelper.resolveDestination(
      destination = destination,
      mode = com.sherpaonnx.fileio.FileIOResolver.WriteMode.SEEKABLE,
      overwrite = true,
      createParentDirectories = false,
    )

    val outputPath: String
    val outputKind: String
    val resolvedOutputPath: String
    var tmpFile: File? = null

    when (val handle = writeHandle) {
      is com.sherpaonnx.fileio.FileIOResolver.WriteHandle.FilePath -> {
        outputPath = handle.file.absolutePath
        outputKind = "fs"
        resolvedOutputPath = handle.file.absolutePath
      }
      is com.sherpaonnx.fileio.FileIOResolver.WriteHandle.FileDescriptor -> {
        outputPath = handle.fdPath
        outputKind = "contentUri"
        resolvedOutputPath = handle.resultUri.toString()
      }
      is com.sherpaonnx.fileio.FileIOResolver.WriteHandle.Stream -> {
        val fallbackTmp = File(reactApplicationContext.cacheDir, "fileio_save_${java.util.UUID.randomUUID()}.$fmt")
        tmpFile = fallbackTmp
        outputPath = fallbackTmp.absolutePath
        outputKind = "contentUri"
        resolvedOutputPath = handle.resultUri.toString()
      }
    }

    return ResolvedDestination(outputPath, outputKind, resolvedOutputPath, writeHandle, tmpFile)
  }

  private fun copyTmpToStreamIfNeeded(dest: ResolvedDestination) {
    if (dest.tmpFile != null) {
      val streamHandle = dest.writeHandle as? com.sherpaonnx.fileio.FileIOResolver.WriteHandle.Stream
        ?: throw RuntimeException("Expected stream write handle for temp-file fallback")
      java.io.FileInputStream(dest.tmpFile).use { input ->
        com.sherpaonnx.fileio.FileIOStreamCopy.copy(input, streamHandle.outputStream)
      }
    }
  }

  private fun cleanupSaveDestination(dest: ResolvedDestination?) {
    try { dest?.writeHandle?.close() } catch (_: Exception) {}
    try { dest?.tmpFile?.delete() } catch (_: Exception) {}
  }

  private fun cleanupOutputFile(path: String?) {
    if (path == null) return
    try { File(path).delete() } catch (_: Exception) {}
  }

  private fun encodeViaPcm(
    samples: FloatArray, sampleRate: Int, channelCount: Int,
    outputPath: String, format: String, outputSampleRateHz: Int,
    bitrate: Int, quality: Int, operationId: String,
    cancelFlagAddr: Long
  ) {
    val sessionPtr = nativeEncodeSessionCreate(
      outputPath, format, sampleRate, channelCount,
      outputSampleRateHz, bitrate, quality,
      samples.size.toLong() / channelCount,
      cancelFlagAddr
    )
    if (sessionPtr == 0L) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: Failed to create encode session")

    try {
      val chunkFrames = 4096
      var offset = 0
      val totalFrames = samples.size / channelCount
      while (offset < totalFrames) {
        val end = minOf(offset + chunkFrames, totalFrames)
        val chunkSampleCount = (end - offset) * channelCount
        val chunk = FloatArray(chunkSampleCount)
        System.arraycopy(samples, offset * channelCount, chunk, 0, chunkSampleCount)
        val err = nativeEncodeSessionFeedChunk(sessionPtr, chunk, end - offset)
        if (err.isNotEmpty()) {
          if (err.contains("CANCELLED")) throw RuntimeException("AUDIO_SAVE_CANCELLED: $err")
          throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $err")
        }
        offset = end
      }
      val finishErr = nativeEncodeSessionFinish(sessionPtr)
      if (finishErr.isNotEmpty()) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $finishErr")
    } finally {
      nativeEncodeSessionRelease(sessionPtr)
    }
  }

  private fun encodeViaOfflineReader(
    entry: com.sherpaonnx.audio.pipeline.OfflineEntry,
    outputPath: String, format: String, outputSampleRateHz: Int,
    bitrate: Int, quality: Int, operationId: String,
    cancelFlagAddr: Long
  ) {
    val channelCount = entry.channelCount
    if (channelCount <= 0 || (entry.numSamples % channelCount) != 0) {
      throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: Invalid channel/sample alignment")
    }
    val totalFrames = entry.numSamples / channelCount
    val sessionPtr = nativeEncodeSessionCreate(
      outputPath, format, entry.sampleRate, channelCount,
      outputSampleRateHz, bitrate, quality,
      totalFrames.toLong(),
      cancelFlagAddr
    )
    if (sessionPtr == 0L) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: Failed to create encode session")

    try {
      val chunkFrames = 4096
      val chunkSamples = chunkFrames * channelCount
      val scratch = FloatArray(chunkSamples)
      entry.createReader().use { reader ->
        while (true) {
          val samplesRead = reader.readSamples(scratch, 0, chunkSamples)
          if (samplesRead <= 0) break
          if ((samplesRead % channelCount) != 0) {
            throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: Invalid read alignment")
          }
          val framesRead = samplesRead / channelCount
          val chunk = if (samplesRead == scratch.size) scratch else scratch.copyOf(samplesRead)
          val err = nativeEncodeSessionFeedChunk(sessionPtr, chunk, framesRead)
          if (err.isNotEmpty()) {
            if (err.contains("CANCELLED")) throw RuntimeException("AUDIO_SAVE_CANCELLED: $err")
            throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $err")
          }
        }
      }
      val finishErr = nativeEncodeSessionFinish(sessionPtr)
      if (finishErr.isNotEmpty()) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $finishErr")
    } finally {
      nativeEncodeSessionRelease(sessionPtr)
    }
  }

  private fun encodeViaDecodeFile(
    inputPath: String?, inputFd: Int, outputPath: String, format: String,
    outputSampleRateHz: Int, bitrate: Int, quality: Int,
    operationId: String, cancelFlagAddr: Long
  ) {
    // First, probe the file to get sample rate. We do a streaming decode that
    // feeds chunks directly into the encode session.
    var encodeSessionPtr = 0L
    var encodeSessionCreated = false

    try {
      @Suppress("UNCHECKED_CAST")
      val decodeResult = nativeDecodeFileStreaming(
        inputPath,
        inputFd,
        0, // keep source sample rate
        true, // force mono
        8192,
        cancelFlagAddr,
        object {
          fun onChunk(samples: FloatArray, frameCount: Int) {
            if (!encodeSessionCreated) {
              // Lazily create encode session on first chunk — we now know the source rate.
              // The source sample rate is embedded in the decode callback context;
              // we use 0 as default and let the encode session use the input rate.
              return // Samples from first callback accumulated below
            }
            if (encodeSessionPtr != 0L) {
              val err = nativeEncodeSessionFeedChunk(encodeSessionPtr, samples, frameCount)
              if (err.isNotEmpty() && !err.contains("CANCELLED")) {
                throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $err")
              }
            }
          }
        },
        null // no separate progress callback
      ) as? HashMap<String, Any> ?: throw RuntimeException("AUDIO_SAVE_SOURCE_NOT_FOUND: Null result from native decode")

      val sourceSampleRate = (decodeResult["sourceSampleRate"] as? Int) ?: 16000
      val totalFramesDecoded = (decodeResult["totalFramesDecoded"] as? Long) ?: 0L

      // For the streaming approach, we need to re-decode since we couldn't create
      // the encode session without knowing the source sample rate.
      // Instead, use batch decode + encode.
      val batchResult = nativeDecodeFileToBuffer(
        inputPath,
        inputFd,
        0,
        true,
        8192,
        cancelFlagAddr
      ) as? HashMap<String, Any> ?: throw RuntimeException("AUDIO_SAVE_SOURCE_NOT_FOUND: Decode failed")

      val samples = batchResult["samples"] as? FloatArray ?: FloatArray(0)
      val srcRate = (batchResult["sourceSampleRate"] as? Int) ?: 16000
      if (samples.isEmpty()) throw RuntimeException("AUDIO_SAVE_SOURCE_NOT_FOUND: Decoded file is empty")

      encodeSessionPtr = nativeEncodeSessionCreate(
        outputPath, format, srcRate, 1,
        outputSampleRateHz, bitrate, quality,
        samples.size.toLong(),
        cancelFlagAddr
      )
      encodeSessionCreated = true
      if (encodeSessionPtr == 0L) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: Failed to create encode session")

      val chunkFrames = 4096
      var offset = 0
      while (offset < samples.size) {
        val end = minOf(offset + chunkFrames, samples.size)
        val chunk = FloatArray(end - offset)
        System.arraycopy(samples, offset, chunk, 0, end - offset)
        val err = nativeEncodeSessionFeedChunk(encodeSessionPtr, chunk, end - offset)
        if (err.isNotEmpty()) {
          if (err.contains("CANCELLED")) throw RuntimeException("AUDIO_SAVE_CANCELLED: $err")
          throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $err")
        }
        offset = end
      }
      val finishErr = nativeEncodeSessionFinish(encodeSessionPtr)
      if (finishErr.isNotEmpty()) throw RuntimeException("AUDIO_SAVE_ENCODE_ERROR: $finishErr")
    } finally {
      if (encodeSessionPtr != 0L) nativeEncodeSessionRelease(encodeSessionPtr)
    }
  }

  override fun saveAudioBufferToFile(
    bufferId: String,
    destination: ReadableMap,
    format: String,
    outputSampleRateHz: Double,
    bitrate: Double,
    quality: Double,
    operationId: String,
    promise: Promise
  ) {
    val rate = outputSampleRateHz.toInt()
    if (!validateAudioSaveParams(format, rate, promise)) return

    val fmt = format.lowercase()
    val cancelFlag = java.util.concurrent.atomic.AtomicBoolean(false)
    saveCancelFlags[operationId] = cancelFlag

    decodeExecutor.execute {
      var dest: ResolvedDestination? = null
      try {
        dest = resolveDestinationForSave(destination, fmt)

        // Allocate native cancel flag
        val cancelFlagAddr = nativeAllocateCancelFlag()
        if (cancelFlag.get()) {
          nativeFreeCancelFlag(cancelFlagAddr)
          throw RuntimeException("AUDIO_SAVE_CANCELLED: Operation cancelled")
        }
        val cancelChecker = Thread {
          while (!cancelFlag.get()) {
            try { Thread.sleep(50) } catch (_: InterruptedException) { break }
          }
          nativeSetCancelFlag(cancelFlagAddr, true)
        }
        cancelChecker.isDaemon = true
        cancelChecker.start()

        try {
          if (bufferId.startsWith("off_")) {
            saveOfflineBuffer(bufferId, dest.outputPath, fmt, rate, bitrate.toInt(), quality.toInt(), operationId, cancelFlagAddr)
          } else if (bufferId.startsWith("live_")) {
            saveLiveBuffer(bufferId, dest.outputPath, fmt, rate, bitrate.toInt(), quality.toInt(), operationId, cancelFlagAddr)
          } else {
            throw IllegalArgumentException("Invalid buffer ID prefix: expected off_ or live_")
          }
          cancelChecker.interrupt()
        } finally {
          nativeFreeCancelFlag(cancelFlagAddr)
          cancelChecker.interrupt()
        }

        copyTmpToStreamIfNeeded(dest)

        val result = com.facebook.react.bridge.Arguments.createMap().apply {
          putString("outputKind", dest.outputKind)
          putString("outputPath", dest.resolvedOutputPath)
        }
        promise.resolve(result)
      } catch (e: com.sherpaonnx.fileio.FileIOException) {
        cleanupOutputFile(dest?.outputPath)
        promise.reject(e.code, e.message, e)
      } catch (e: IllegalArgumentException) {
        cleanupOutputFile(dest?.outputPath)
        val code = if (e.message?.contains("empty", ignoreCase = true) == true)
          "AUDIO_SAVE_BUFFER_EMPTY" else "AUDIO_SAVE_SOURCE_NOT_FOUND"
        promise.reject(code, e.message, e)
      } catch (e: IllegalStateException) {
        cleanupOutputFile(dest?.outputPath)
        if (e.message?.contains("finalized", ignoreCase = true) == true) {
          promise.reject("AUDIO_SAVE_BUFFER_NOT_FINALIZED", e.message, e)
        } else {
          promise.reject("AUDIO_SAVE_ENCODE_ERROR", e.message, e)
        }
      } catch (e: RuntimeException) {
        cleanupOutputFile(dest?.outputPath)
        val msg = e.message ?: ""
        val code = if (msg.startsWith("AUDIO_SAVE_")) msg.substringBefore(":").trim() else "AUDIO_SAVE_ENCODE_ERROR"
        promise.reject(code, msg, e)
      } catch (e: Exception) {
        cleanupOutputFile(dest?.outputPath)
        promise.reject("AUDIO_SAVE_ENCODE_ERROR", e.message, e)
      } finally {
        saveCancelFlags.remove(operationId)
        cleanupSaveDestination(dest)
      }
    }
  }

  private fun saveOfflineBuffer(
    bufferId: String, outputPath: String, format: String, rate: Int,
    bitrate: Int, quality: Int, operationId: String, cancelFlagAddr: Long
  ) {
    val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getOffline(bufferId)
      ?: throw IllegalArgumentException("Offline buffer not found: $bufferId")
    if (entry.numSamples == 0) throw IllegalArgumentException("Buffer is empty")

    when (entry) {
      is com.sherpaonnx.audio.pipeline.OfflineEntry.MmapBacked -> {
        encodeViaOfflineReader(entry, outputPath, format, rate, bitrate, quality, operationId, cancelFlagAddr)
      }
      is com.sherpaonnx.audio.pipeline.OfflineEntry.InMemory -> {
        encodeViaPcm(entry.samples, entry.sampleRate, entry.channelCount, outputPath, format, rate, bitrate, quality, operationId, cancelFlagAddr)
      }
    }
  }

  private fun saveLiveBuffer(
    bufferId: String, outputPath: String, format: String, rate: Int,
    bitrate: Int, quality: Int, operationId: String, cancelFlagAddr: Long
  ) {
    val entry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLive(bufferId)
      ?: if (com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.isInvalidatedLiveBuffer(bufferId)) {
        throw IllegalStateException("Live buffer is invalidated after transfer: $bufferId")
      } else {
        throw IllegalArgumentException("Live buffer not found: $bufferId")
      }
    if (entry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.FINISHED)
      throw IllegalStateException("Live buffer must be finalized before conversion")
    if (entry.numSamples == 0L) throw IllegalArgumentException("Buffer is empty")

    val spoolPath = entry.spoolFilePath
    if (spoolPath != null) {
      encodeViaDecodeFile(spoolPath, -1, outputPath, format, rate, bitrate, quality, operationId, cancelFlagAddr)
    } else {
      val snapshot = entry.snapshotRing()
      encodeViaPcm(snapshot, entry.sampleRate, 1, outputPath, format, rate, bitrate, quality, operationId, cancelFlagAddr)
    }
  }

  override fun saveFileAsAudioFile(
    source: ReadableMap,
    destination: ReadableMap,
    format: String,
    outputSampleRateHz: Double,
    bitrate: Double,
    quality: Double,
    operationId: String,
    promise: Promise
  ) {
    val rate = outputSampleRateHz.toInt()
    if (!validateAudioSaveParams(format, rate, promise)) return

    val fmt = format.lowercase()
    val cancelFlag = java.util.concurrent.atomic.AtomicBoolean(false)
    saveCancelFlags[operationId] = cancelFlag

    decodeExecutor.execute {
      var readHandle: com.sherpaonnx.fileio.FileIOResolver.ReadHandle? = null
      var dest: ResolvedDestination? = null

      try {
        readHandle = fileIOHelper.resolveSource(source)
        val source = when (val handle = readHandle) {
          is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.FilePath -> {
            handle.file.absolutePath to -1
          }
          is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.FileDescriptor -> {
            null to handle.pfd.fd
          }
          is com.sherpaonnx.fileio.FileIOResolver.ReadHandle.Stream -> {
            throw FileIOException(
              FileIOErrorCodes.UNSUPPORTED_ON_PLATFORM,
              "DECODE_UNSUPPORTED_SOURCE: Non-seekable stream source is not supported; provide a seekable fd/path"
            )
          }
          null -> throw RuntimeException("Resolved read handle is null")
        }
        val sourcePath = source.first
        val sourceFd = source.second

        dest = resolveDestinationForSave(destination, fmt)

        val cancelFlagAddr = nativeAllocateCancelFlag()
        if (cancelFlag.get()) {
          nativeFreeCancelFlag(cancelFlagAddr)
          throw RuntimeException("AUDIO_SAVE_CANCELLED: Operation cancelled")
        }
        val cancelChecker = Thread {
          while (!cancelFlag.get()) {
            try { Thread.sleep(50) } catch (_: InterruptedException) { break }
          }
          nativeSetCancelFlag(cancelFlagAddr, true)
        }
        cancelChecker.isDaemon = true
        cancelChecker.start()

        try {
          encodeViaDecodeFile(sourcePath, sourceFd, dest.outputPath, fmt, rate, bitrate.toInt(), quality.toInt(), operationId, cancelFlagAddr)
          cancelChecker.interrupt()
        } finally {
          nativeFreeCancelFlag(cancelFlagAddr)
          cancelChecker.interrupt()
        }

        copyTmpToStreamIfNeeded(dest)

        val result = com.facebook.react.bridge.Arguments.createMap().apply {
          putString("outputKind", dest.outputKind)
          putString("outputPath", dest.resolvedOutputPath)
        }
        promise.resolve(result)
      } catch (e: com.sherpaonnx.fileio.FileIOException) {
        cleanupOutputFile(dest?.outputPath)
        promise.reject(e.code, e.message, e)
      } catch (e: RuntimeException) {
        cleanupOutputFile(dest?.outputPath)
        val msg = e.message ?: ""
        val code = if (msg.startsWith("AUDIO_SAVE_")) msg.substringBefore(":").trim() else "AUDIO_SAVE_ENCODE_ERROR"
        promise.reject(code, msg, e)
      } catch (e: Exception) {
        cleanupOutputFile(dest?.outputPath)
        promise.reject("AUDIO_SAVE_ENCODE_ERROR", e.message, e)
      } finally {
        saveCancelFlags.remove(operationId)
        try { readHandle?.close() } catch (_: Exception) {}
        cleanupSaveDestination(dest)
      }
    }
  }

  override fun cancelAudioSave(operationId: String, promise: Promise) {
    val flag = saveCancelFlags.remove(operationId)
    if (flag != null) {
      flag.set(true)
    }
    promise.resolve(null)
  }

  override fun getPipelineAudioBufferInfo(bufferId: String, promise: Promise) {
    try {
      val info = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getInfo(bufferId)
      promise.resolve(info)
    } catch (e: IllegalArgumentException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun releasePipelineAudioBuffer(bufferId: String, promise: Promise) {
    com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.release(bufferId)
    promise.resolve(null)
  }

  override fun startMicToLiveAudioBuffer(liveBufferId: String, options: ReadableMap?, promise: Promise) {
    try {
      // Stop any existing mic sink
      micToLiveSink?.stop()
      micToLiveSink = null

      val liveEntry = com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.getLive(liveBufferId)
        ?: if (com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.isInvalidatedLiveBuffer(liveBufferId)) {
          throw IllegalStateException("Live buffer is invalidated after transfer: $liveBufferId")
        } else {
          throw IllegalArgumentException("Live buffer not found: $liveBufferId")
        }

      if (liveEntry.state != com.sherpaonnx.audio.pipeline.LiveEntry.State.RECORDING) {
        throw IllegalStateException("Live buffer is finalized, cannot capture into it")
      }

      // Compatibility option: emitToJs now toggles centralized append-event emission.
      if (options?.hasKey("emitToJs") == true && !options.isNull("emitToJs")) {
        val emitToJs = options.getBoolean("emitToJs")
        com.sherpaonnx.audio.pipeline.PipelineAudioRegistry.configureLiveAppendEvents(
          liveBufferId = liveBufferId,
          enabled = emitToJs,
        )
      }

      val sink = com.sherpaonnx.audio.pipeline.MicToLiveBufferSink(
        context = reactApplicationContext,
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
      val code = if ((e.message ?: "").contains("invalidated", ignoreCase = true)) {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.BUFFER_INVALIDATED
      } else {
        com.sherpaonnx.audio.pipeline.PipelineAudioErrorCodes.INVALID_STATE
      }
      promise.reject(code, e.message, e)
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

  override fun listAvailableInputDevices(promise: Promise) {
    try {
      val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()
      } else {
        emptyList()
      }

      val routedInputId = micToLiveSink?.currentRoutedDeviceId()
      val defaultInputId = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }?.id
        ?: devices.firstOrNull()?.id
      val selectedInputId = routedInputId ?: defaultInputId

      val out = Arguments.createArray()
      for (device in devices) {
        val map = Arguments.createMap()
        map.putString("id", device.id.toString())
        map.putString("name", device.productName?.toString() ?: "Input ${device.id}")
        map.putString("kind", normalizeInputDeviceKind(device.type))
        map.putBoolean("selected", selectedInputId != null && device.id == selectedInputId)
        map.putBoolean("default", device.type == AudioDeviceInfo.TYPE_BUILTIN_MIC)
        map.putBoolean("canSelect", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
        out.pushMap(map)
      }

      promise.resolve(out)
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
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: IllegalArgumentException) {
      val code = if ((e.message ?: "").startsWith("Live text buffer not found")) {
        com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND
      } else {
        com.sherpaonnx.text.pipeline.TextErrorCodes.INVALID_ARGUMENT
      }
      promise.reject(code, e.message, e)
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

  override fun populateOfflineTextBufferIfEmpty(
    bufferId: String,
    text: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(
          com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND,
          "Offline text buffer not found: $bufferId"
        )
        return
      }
      entry.populate(
        text = text,
        tokens = emptyArray(),
        timestamps = floatArrayOf(),
        durations = floatArrayOf(),
        lang = options?.getString("lang") ?: "",
        emotion = options?.getString("emotion") ?: "",
        event = options?.getString("event") ?: "",
      )
      promise.resolve(null)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.ALREADY_POPULATED, e.message, e)
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
      val spoolingMode = if (options.hasKey("spoolingMode") && !options.isNull("spoolingMode")) {
        com.sherpaonnx.text.pipeline.TextSpoolingMode.fromRaw(options.getString("spoolingMode"))
      } else {
        com.sherpaonnx.text.pipeline.TextSpoolingMode.ON
      }
      val spoolingPath = if (options.hasKey("spoolingPath") && !options.isNull("spoolingPath")) {
        options.getString("spoolingPath")
      } else {
        null
      }
      val spoolingTemporary = if (options.hasKey("spoolingTemporary") && !options.isNull("spoolingTemporary")) {
        options.getBoolean("spoolingTemporary")
      } else {
        null
      }
      val spoolingThresholdBytes = if (options.hasKey("spoolingThresholdBytes") && !options.isNull("spoolingThresholdBytes")) {
        options.getDouble("spoolingThresholdBytes").toLong()
      } else {
        0L
      }
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createLive(
        windowMaxChars = windowMaxChars,
        maxSegments = maxSegments,
        emitPartialEvents = emitPartialEvents,
        partialEventMinIntervalMs = partialEventMinIntervalMs,
        spoolingMode = spoolingMode,
        spoolingPath = spoolingPath,
        spoolingTemporary = spoolingTemporary,
        spoolingThresholdBytes = spoolingThresholdBytes,
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createLiveTextBufferFromOffline(offlineBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.createLiveFromOffline(offlineBufferId)
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
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
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
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

  override fun setLiveTextBufferPartial(
    liveBufferId: String,
    text: String,
    promise: Promise,
  ) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(
          com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND,
          "Live text buffer not found: $liveBufferId"
        )
        return
      }

      entry.writePartial(text)
      maybeEmitLiveTextPartial(entry, "replace")
      promise.resolve(null)
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.ALREADY_FINALIZED, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun appendLiveTextBufferPartial(
    liveBufferId: String,
    text: String,
    promise: Promise,
  ) {
    try {
      val entry = com.sherpaonnx.text.pipeline.TextPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(
          com.sherpaonnx.text.pipeline.TextErrorCodes.BUFFER_NOT_FOUND,
          "Live text buffer not found: $liveBufferId"
        )
        return
      }

      entry.appendText(text)
      maybeEmitLiveTextPartial(entry, "append")
      promise.resolve(null)
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: IllegalStateException) {
      promise.reject(com.sherpaonnx.text.pipeline.TextErrorCodes.ALREADY_FINALIZED, e.message, e)
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

      emitLiveTextSegment(
        liveBufferId = liveBufferId,
        segment = com.sherpaonnx.text.pipeline.TextSegment(
          text = text,
          tokens = tokenArray,
          timestamps = timestampArray,
          source = "append",
          segmentIndex = segmentIndex,
          meta = metaMap,
        ),
        totalSegments = entry.segmentCount,
      )

      val out = Arguments.createMap()
      out.putInt("segmentIndex", segmentIndex)
      promise.resolve(out)
    } catch (e: com.sherpaonnx.text.pipeline.TextPipelineException) {
      promise.reject(e.code, e.message, e)
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

  override fun attachSegmentationEngine(
    bufferId: String,
    domain: String,
    policy: ReadableMap,
    promise: Promise,
  ) {
    try {
      val policyMap = policy.toHashMap() as Map<String, Any?>
      val info = com.sherpaonnx.segment.engine.SegmentationEngineRegistry.attachEngine(
        bufferId = bufferId,
        domainRaw = domain,
        rawPolicy = policyMap,
      )
      promise.resolve(segmentationEngineInfoToWritableMap(info))
    } catch (t: Throwable) {
      val (code, message) =
        com.sherpaonnx.segment.engine.SegmentationEngineRegistry.toError(
          throwable = t,
          fallbackCode = com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR,
        )
      promise.reject(code, message, t)
    }
  }

  override fun detachSegmentationEngine(
    engineId: String,
    flushFinal: Boolean?,
    promise: Promise,
  ) {
    try {
      com.sherpaonnx.segment.engine.SegmentationEngineRegistry.detachEngine(
        engineId = engineId,
        flushFinal = flushFinal == true,
      )
      promise.resolve(null)
    } catch (t: Throwable) {
      val (code, message) =
        com.sherpaonnx.segment.engine.SegmentationEngineRegistry.toError(
          throwable = t,
          fallbackCode = com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR,
        )
      promise.reject(code, message, t)
    }
  }

  override fun getSegmentationEngineInfo(engineId: String, promise: Promise) {
    try {
      val info =
        com.sherpaonnx.segment.engine.SegmentationEngineRegistry.getEngineInfo(engineId)
      promise.resolve(segmentationEngineInfoToWritableMap(info))
    } catch (t: Throwable) {
      val (code, message) =
        com.sherpaonnx.segment.engine.SegmentationEngineRegistry.toError(
          throwable = t,
          fallbackCode = com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR,
        )
      promise.reject(code, message, t)
    }
  }

  override fun segmentOfflineBuffer(
    bufferId: String,
    domain: String,
    policy: ReadableMap,
    promise: Promise,
  ) {
    try {
      val policyMap = policy.toHashMap() as Map<String, Any?>
      val result = com.sherpaonnx.segment.engine.SegmentationEngineRegistry.segmentOfflineBuffer(
        bufferId = bufferId,
        domainRaw = domain,
        rawPolicy = policyMap,
      )

      val out = Arguments.createMap()
      val resultBufferId = result["bufferId"] as? String ?: bufferId
      out.putString("bufferId", resultBufferId)
      out.putString("kind", result["kind"] as? String ?: "offlineSegmentBuffer")
      out.putString("state", result["state"] as? String ?: "immutable")
      (result["segmentCount"] as? Number)?.let { out.putInt("segmentCount", it.toInt()) }
      (result["sourceAudioBufferId"] as? String)?.let { out.putString("sourceAudioBufferId", it) }
      @Suppress("UNCHECKED_CAST")
      val textSegments = result["segments"] as? List<Map<String, Any?>>
      if (!textSegments.isNullOrEmpty()) {
        val arr = Arguments.createArray()
        textSegments.forEach { segment ->
          val s = Arguments.createMap()
          s.putString("segmentId", segment["segmentId"] as? String ?: "")
          s.putInt("startOffset", (segment["startOffset"] as? Number)?.toInt() ?: 0)
          s.putInt("endOffset", (segment["endOffset"] as? Number)?.toInt() ?: 0)
          s.putString("reason", segment["reason"] as? String ?: "manual_commit")
          s.putString("source", segment["source"] as? String ?: "manual")
          s.putString("text", segment["text"] as? String ?: "")
          arr.pushMap(s)
        }
        out.putArray("segments", arr)
      }
      promise.resolve(out)
    } catch (t: Throwable) {
      val (code, message) =
        com.sherpaonnx.segment.engine.SegmentationEngineRegistry.toError(
          throwable = t,
          fallbackCode = com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR,
        )
      promise.reject(code, message, t)
    }
  }

  private fun segmentationEngineInfoToWritableMap(
    info: com.sherpaonnx.segment.engine.SegmentationEngineInfoSnapshot,
  ): com.facebook.react.bridge.WritableMap {
    val out = Arguments.createMap()
    out.putString("engineId", info.engineId)
    out.putString("attachedBufferId", info.attachedBufferId)
    out.putString(
      "domain",
      if (info.domain == com.sherpaonnx.segment.engine.EngineDomain.TEXT) {
        "text"
      } else {
        "speech"
      }
    )
    out.putString(
      "state",
      when (info.state) {
        com.sherpaonnx.segment.engine.EngineState.ACTIVE -> "active"
        com.sherpaonnx.segment.engine.EngineState.DETACHED,
        com.sherpaonnx.segment.engine.EngineState.RELEASED -> "detached"
      }
    )
    out.putInt("totalSegmentsCommitted", info.totalSegmentsCommitted)
    info.lastSegmentId?.let { out.putString("lastSegmentId", it) }
    info.segmentBufferId?.let { out.putString("segmentBufferId", it) }

    val policy = Arguments.createMap()
    policy.putString("evaluator", info.policy.evaluator)
    policy.putInt("maxLengthChars", info.policy.maxLengthChars)
    policy.putBoolean("sentenceBoundary", info.policy.sentenceBoundary)
    info.policy.sentenceBoundaryChars?.takeIf { it.isNotEmpty() }?.let { chars ->
      val arr = Arguments.createArray()
      for (s in chars) {
        arr.pushString(s)
      }
      policy.putArray("sentenceBoundaryChars", arr)
    }
    policy.putInt("silenceThresholdMs", info.policy.silenceThresholdMs)
    policy.putDouble("energyThresholdDb", info.policy.energyThresholdDb)
    policy.putInt("minSegmentMs", info.policy.minSegmentMs)
    policy.putInt("maxSegmentMs", info.policy.maxSegmentMs)
    policy.putInt("hangoverMs", info.policy.hangoverMs)
    policy.putInt("checkpointIntervalMs", info.policy.checkpointIntervalMs)
    info.policy.modelPath?.let { onnxPath ->
      val modelPathMap = Arguments.createMap()
      modelPathMap.putString("kind", "fs")
      modelPathMap.putString("path", onnxPath)
      policy.putMap("modelPath", modelPathMap)
    }
    info.policy.vadThreshold?.let { policy.putDouble("vadThreshold", it) }
    info.policy.vadMinSpeechMs?.let { policy.putInt("vadMinSpeechMs", it) }
    info.policy.vadMinSilenceMs?.let { policy.putInt("vadMinSilenceMs", it) }
    out.putMap("policy", policy)

    return out
  }

  private fun segmentRecordToWritableMapWithAnnotation(
    record: com.sherpaonnx.segment.pipeline.SegmentRecord,
  ): com.facebook.react.bridge.WritableMap {
    val out = Arguments.createMap()
    out.putString("id", record.id)
    out.putString("kind", record.kind)
    out.putString("sourceAudioBufferId", record.sourceAudioBufferId)
    out.putInt("startSample", record.startSample)
    out.putInt("endSample", record.endSample)
    out.putInt("sampleRate", record.sampleRate)
    out.putInt("durationMs", record.durationMs)
    record.confidence?.let { out.putDouble("confidence", it) }

    val annotation =
      com.sherpaonnx.segment.engine.SegmentationEngineRegistry.peekSegmentAnnotation(
        record.id
      )
    annotation?.let {
      out.putString("reason", it.reason)
      out.putString("source", it.source)
      out.putDouble("createdAtMs", it.createdAtMs.toDouble())
    }

    record.payloadJson?.let { payloadJson ->
      try {
        val json = JSONObject(payloadJson)
        val payload = com.sherpaonnx.segment.pipeline.JsonToReactUtils.jsonObjectToWritableMap(json)
        out.putMap("payload", payload)
      } catch (_: Exception) {
      }
    }

    return out
  }

  private fun segmentRecordsToWritableArrayWithAnnotation(
    records: List<com.sherpaonnx.segment.pipeline.SegmentRecord>,
  ): com.facebook.react.bridge.WritableArray {
    val arr = Arguments.createArray()
    for (record in records) {
      arr.pushMap(segmentRecordToWritableMapWithAnnotation(record))
    }
    return arr
  }

  // ==================== Pipeline Segment Buffers ====================

  override fun createLiveSegmentBuffer(options: ReadableMap, promise: Promise) {
    try {
      val sourceAudioBufferId =
        if (options.hasKey("sourceAudioBufferId") && !options.isNull("sourceAudioBufferId")) {
          options.getString("sourceAudioBufferId")
        } else {
          null
        }
      val maxSegments =
        if (options.hasKey("maxSegments") && !options.isNull("maxSegments")) {
          options.getDouble("maxSegments").toInt()
        } else {
          1000
        }
      val spoolingMode = if (options.hasKey("spoolingMode") && !options.isNull("spoolingMode")) {
        options.getString("spoolingMode")
      } else {
        "on"
      }
      val spoolingPath = if (options.hasKey("spoolingPath") && !options.isNull("spoolingPath")) {
        options.getString("spoolingPath")
      } else {
        null
      }
      val spoolingTemporary =
        if (options.hasKey("spoolingTemporary") && !options.isNull("spoolingTemporary")) {
          options.getBoolean("spoolingTemporary")
        } else {
          null
        }
      val spoolingThresholdBytes =
        if (options.hasKey("spoolingThresholdBytes") && !options.isNull("spoolingThresholdBytes")) {
          options.getDouble("spoolingThresholdBytes").toLong()
        } else {
          null
        }
      val emitSegmentAppendedEvents =
        if (options.hasKey("emitSegmentAppendedEvents") && !options.isNull("emitSegmentAppendedEvents")) {
          options.getBoolean("emitSegmentAppendedEvents")
        } else {
          false
        }
      val segmentEventMinIntervalMs =
        if (options.hasKey("segmentEventMinIntervalMs") && !options.isNull("segmentEventMinIntervalMs")) {
          options.getDouble("segmentEventMinIntervalMs").toLong()
        } else {
          0L
        }
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.createLive(
        sourceAudioBufferId = sourceAudioBufferId,
        maxSegments = maxSegments,
        spoolingModeRaw = spoolingMode,
        spoolingPath = spoolingPath,
        spoolingTemporary = spoolingTemporary,
        spoolingThresholdBytes = spoolingThresholdBytes,
        emitSegmentAppendedEvents = emitSegmentAppendedEvents,
        segmentEventMinIntervalMs = segmentEventMinIntervalMs
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createEmptyOfflineSegmentBuffer(options: ReadableMap?, promise: Promise) {
    try {
      val sourceAudioBufferId =
        if (options != null && options.hasKey("sourceAudioBufferId") && !options.isNull("sourceAudioBufferId")) {
          options.getString("sourceAudioBufferId")
        } else {
          null
        }
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.createEmptyOffline(sourceAudioBufferId)
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  private fun validateStrictSpeechPayload(payload: ReadableMap?) {
    if (payload == null) {
      throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
        com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
        "speech payload is required and must include source"
      )
    }
    if (!payload.hasKey("source") || payload.isNull("source")) {
      throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
        com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
        "speech payload.source must be one of vad, stt, tts"
      )
    }
    val source = payload.getString("source")?.trim() ?: ""
    val allowedKeys = when (source) {
      "vad" -> setOf("source", "engine", "decision", "score", "__annotationReason", "__annotationSource", "__annotationCreatedAtMs")
      "stt" -> setOf("source", "transcript", "tokenCount", "isFinal", "__annotationReason", "__annotationSource", "__annotationCreatedAtMs")
      "tts" -> setOf("source", "text", "chunkIndex", "isFinalChunk", "__annotationReason", "__annotationSource", "__annotationCreatedAtMs")
      "manual" -> setOf("source", "__annotationReason", "__annotationSource", "__annotationCreatedAtMs")
      else -> throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
        com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
        "speech payload.source must be one of vad, stt, tts, manual"
      )
    }

    val itr = payload.keySetIterator()
    while (itr.hasNextKey()) {
      val key = itr.nextKey()
      if (!allowedKeys.contains(key)) {
        throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
          com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
          "speech payload.$key is not allowed for source=$source"
        )
      }
    }

    when (source) {
      "vad" -> {
        if (payload.hasKey("engine") && !payload.isNull("engine")) {
          val engine = payload.getString("engine")
          if (engine != "vad") {
            throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
              com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
              "speech payload.engine must be vad"
            )
          }
        }
        if (payload.hasKey("decision") && !payload.isNull("decision")) {
          val decision = payload.getString("decision")
          if (decision != "model") {
            throw com.sherpaonnx.segment.pipeline.SegmentPipelineException(
              com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
              "speech payload.decision must be model"
            )
          }
        }
      }
      "stt", "tts" -> Unit
    }
  }

  override fun appendLiveSegment(
    liveBufferId: String,
    kind: String,
    sourceAudioBufferId: String,
    startSample: Double,
    endSample: Double,
    sampleRate: Double,
    durationMs: Double?,
    confidence: Double?,
    payload: ReadableMap?,
    promise: Promise
  ) {
    try {
      val normalizedKind = kind.trim().ifEmpty { "speech" }
      if (normalizedKind != "speech" && normalizedKind != "alignment") {
        promise.reject(
          com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INVALID_ARGUMENT,
          "kind must be one of speech or alignment"
        )
        return
      }
      if (normalizedKind == "speech") {
        validateStrictSpeechPayload(payload)
      }
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Live segment buffer not found: $liveBufferId")
        return
      }
      val result = entry.appendSegment(
        kind = normalizedKind,
        sourceAudioBufferId = sourceAudioBufferId,
        startSample = startSample.toInt(),
        endSample = endSample.toInt(),
        sampleRate = sampleRate.toInt(),
        durationMs = durationMs?.toInt(),
        confidence = confidence,
        payloadJson = payload?.toHashMap()?.let { org.json.JSONObject(it as Map<*, *>).toString() },
        annotationReason = if (payload != null && payload.hasKey("__annotationReason")) payload.getString("__annotationReason") else null,
        annotationSource = if (payload != null && payload.hasKey("__annotationSource")) payload.getString("__annotationSource") else null,
        annotationCreatedAtMs = if (payload != null && payload.hasKey("__annotationCreatedAtMs") && !payload.isNull("__annotationCreatedAtMs")) payload.getDouble("__annotationCreatedAtMs").toLong() else null
      )
      val out = Arguments.createMap()
      out.putString("segmentId", result.first)
      out.putInt("segmentIndex", result.second)
      promise.resolve(out)
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun finalizeLiveSegmentBuffer(liveBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Live segment buffer not found: $liveBufferId")
        return
      }
      entry.finalize_()
      promise.resolve(null)
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun createOfflineSegmentBufferFromLive(liveBufferId: String, mode: String?, promise: Promise) {
    try {
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.createOfflineFromLive(
        liveBufferId,
        mode ?: "fullIfSpooled"
      )
      promise.resolve(entry.toWritableMap())
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun populateOfflineSegmentBufferIfEmpty(
    targetBufferId: String,
    liveBufferId: String,
    mode: String?,
    promise: Promise
  ) {
    try {
      com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.populateOfflineFromLiveIfEmpty(
        targetBufferId,
        liveBufferId,
        mode ?: "fullIfSpooled"
      )
      promise.resolve(null)
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getPipelineSegmentBufferInfo(bufferId: String, promise: Promise) {
    try {
      val offline = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getOffline(bufferId)
      if (offline != null) {
        promise.resolve(offline.toWritableMap())
        return
      }
      val live = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getLive(bufferId)
      if (live != null) {
        promise.resolve(live.toWritableMap())
        return
      }
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Segment buffer not found: $bufferId")
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getOfflineSegmentBufferSegments(
    bufferId: String,
    start: Double?,
    maxCount: Double?,
    promise: Promise
  ) {
    try {
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getOffline(bufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Offline segment buffer not found: $bufferId")
        return
      }
      val from = start?.toInt() ?: 0
      val count = maxCount?.toInt() ?: 1024
      val segments = entry.snapshotSegments(from, count)
      val out = Arguments.createMap()
      out.putArray("segments", segmentRecordsToWritableArrayWithAnnotation(segments))
      promise.resolve(out)
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getLiveSegmentBufferSegments(
    liveBufferId: String,
    startIndex: Double,
    maxCount: Double,
    promise: Promise
  ) {
    try {
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Live segment buffer not found: $liveBufferId")
        return
      }
      val segments = entry.getSegments(startIndex.toInt(), maxCount.toInt())
      val out = Arguments.createMap()
      out.putArray("segments", segmentRecordsToWritableArrayWithAnnotation(segments))
      promise.resolve(out)
    } catch (e: com.sherpaonnx.segment.pipeline.SegmentPipelineException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun getLiveSegmentBufferSegmentCount(liveBufferId: String, promise: Promise) {
    try {
      val entry = com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.getLive(liveBufferId)
      if (entry == null) {
        promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.BUFFER_NOT_FOUND, "Live segment buffer not found: $liveBufferId")
        return
      }
      promise.resolve(entry.segmentCount())
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  override fun releasePipelineSegmentBuffer(bufferId: String, promise: Promise) {
    try {
      com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry.release(bufferId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject(com.sherpaonnx.segment.pipeline.SegmentErrorCodes.INTERNAL_ERROR, e.message, e)
    }
  }

  private fun segmentLinkTypeRaw(
    type: com.sherpaonnx.segment.core.SegmentLinkType
  ): String = type.name.lowercase()

  private fun segmentLinkToWritableMap(
    link: com.sherpaonnx.segment.core.SegmentLink
  ): com.facebook.react.bridge.WritableMap {
    val out = Arguments.createMap()
    out.putString("linkId", link.linkId)
    out.putString("textSegmentId", link.textSegmentId)
    out.putString("speechSegmentId", link.speechSegmentId)
    out.putString("linkType", segmentLinkTypeRaw(link.linkType))
    link.confidence?.let { out.putDouble("confidence", it.toDouble()) }
    link.metaJson?.let { rawMeta ->
      try {
        val json = JSONObject(rawMeta)
        val meta = com.sherpaonnx.segment.pipeline.JsonToReactUtils.jsonObjectToWritableMap(json)
        out.putMap("meta", meta)
      } catch (_: Exception) {
        // Ignore malformed meta JSON.
      }
    }
    return out
  }

  override fun createSegmentLinkMap(options: ReadableMap?, promise: Promise) {
    try {
      val textBufferId =
        if (options != null && options.hasKey("textBufferId") && !options.isNull("textBufferId")) {
          options.getString("textBufferId")
        } else {
          null
        }
      val audioBufferId =
        if (options != null && options.hasKey("audioBufferId") && !options.isNull("audioBufferId")) {
          options.getString("audioBufferId")
        } else {
          null
        }

      val ref = com.sherpaonnx.segment.core.SegmentLinkMapRegistry.createLinkMap(
        textBufferId = textBufferId,
        audioBufferId = audioBufferId,
      )
      val out = Arguments.createMap()
      out.putString("linkMapId", ref.linkMapId)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun addSegmentLink(linkMapId: String, link: ReadableMap, promise: Promise) {
    try {
      val textSegmentId = link.getString("textSegmentId") ?: ""
      val speechSegmentId = link.getString("speechSegmentId") ?: ""
      val linkType = link.getString("linkType") ?: ""
      val confidence =
        if (link.hasKey("confidence") && !link.isNull("confidence")) {
          link.getDouble("confidence").toFloat()
        } else {
          null
        }
      val metaJson =
        if (link.hasKey("meta") && !link.isNull("meta")) {
          link.getMap("meta")?.toHashMap()?.let { JSONObject(it).toString() }
        } else {
          null
        }

      val out = com.sherpaonnx.segment.core.SegmentLinkMapRegistry.addLink(
        linkMapId = linkMapId,
        textSegmentId = textSegmentId,
        speechSegmentId = speechSegmentId,
        linkTypeRaw = linkType,
        confidence = confidence,
        metaJson = metaJson,
      )
      promise.resolve(segmentLinkToWritableMap(out))
    } catch (e: IllegalArgumentException) {
      promise.reject("SEGMENT_LINK_INVALID", e.message, e)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun addSegmentLinks(linkMapId: String, links: ReadableArray, promise: Promise) {
    try {
      val input = ArrayList<com.sherpaonnx.segment.core.SegmentLinkInput>(links.size())
      for (i in 0 until links.size()) {
        val link = links.getMap(i)
          ?: throw IllegalArgumentException("SEGMENT_LINK_INVALID: links[$i] must be an object")
        val metaJson =
          if (link.hasKey("meta") && !link.isNull("meta")) {
            link.getMap("meta")?.toHashMap()?.let { JSONObject(it).toString() }
          } else {
            null
          }
        input.add(
          com.sherpaonnx.segment.core.SegmentLinkInput(
            textSegmentId = link.getString("textSegmentId") ?: "",
            speechSegmentId = link.getString("speechSegmentId") ?: "",
            linkType = link.getString("linkType") ?: "",
            confidence = if (link.hasKey("confidence") && !link.isNull("confidence")) {
              link.getDouble("confidence").toFloat()
            } else {
              null
            },
            metaJson = metaJson,
          )
        )
      }

      val created = com.sherpaonnx.segment.core.SegmentLinkMapRegistry.addLinks(linkMapId, input)
      val arr = Arguments.createArray()
      created.forEach { arr.pushMap(segmentLinkToWritableMap(it)) }
      val out = Arguments.createMap()
      out.putArray("links", arr)
      promise.resolve(out)
    } catch (e: IllegalArgumentException) {
      promise.reject("SEGMENT_LINK_INVALID", e.message, e)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun removeSegmentLink(linkMapId: String, linkId: String, promise: Promise) {
    try {
      com.sherpaonnx.segment.core.SegmentLinkMapRegistry.removeLink(linkMapId, linkId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun getSpeechSegmentsForText(linkMapId: String, textSegmentId: String, promise: Promise) {
    try {
      val links =
        com.sherpaonnx.segment.core.SegmentLinkMapRegistry.getSpeechSegmentsForText(
          linkMapId,
          textSegmentId,
        )
      val arr = Arguments.createArray()
      links.forEach { arr.pushMap(segmentLinkToWritableMap(it)) }
      val out = Arguments.createMap()
      out.putArray("links", arr)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun getTextSegmentsForSpeech(linkMapId: String, speechSegmentId: String, promise: Promise) {
    try {
      val links =
        com.sherpaonnx.segment.core.SegmentLinkMapRegistry.getTextSegmentsForSpeech(
          linkMapId,
          speechSegmentId,
        )
      val arr = Arguments.createArray()
      links.forEach { arr.pushMap(segmentLinkToWritableMap(it)) }
      val out = Arguments.createMap()
      out.putArray("links", arr)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun getAllSegmentLinks(
    linkMapId: String,
    startIndex: Double?,
    maxCount: Double?,
    promise: Promise,
  ) {
    try {
      val from = startIndex?.toInt() ?: 0
      val count = maxCount?.toInt() ?: 1024
      val links = com.sherpaonnx.segment.core.SegmentLinkMapRegistry.getAllLinks(
        linkMapId,
        from,
        count,
      )
      val arr = Arguments.createArray()
      links.forEach { arr.pushMap(segmentLinkToWritableMap(it)) }
      val out = Arguments.createMap()
      out.putArray("links", arr)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun getSegmentLinkCount(linkMapId: String, promise: Promise) {
    try {
      promise.resolve(com.sherpaonnx.segment.core.SegmentLinkMapRegistry.getCount(linkMapId))
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun getSegmentLinkMapInfo(linkMapId: String, promise: Promise) {
    try {
      val info = com.sherpaonnx.segment.core.SegmentLinkMapRegistry.getInfo(linkMapId)
      val out = Arguments.createMap()
      out.putString("linkMapId", info.linkMapId)
      out.putInt("linkCount", info.linkCount)
      if (info.textBufferId != null) out.putString("textBufferId", info.textBufferId)
      if (info.audioBufferId != null) out.putString("audioBufferId", info.audioBufferId)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
    }
  }

  override fun releaseSegmentLinkMap(linkMapId: String, promise: Promise) {
    try {
      com.sherpaonnx.segment.core.SegmentLinkMapRegistry.release(linkMapId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SEGMENT_LINK_INTERNAL_ERROR", e.message, e)
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
    segmentOutBufferId: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    alignmentHelper.alignOfflineTextToAudio(
      textInBufferId,
      audioInBufferId,
      segmentOutBufferId,
      mode,
      granularity,
      options,
      promise
    )
  }

  override fun alignAccurateForcedCtcFromPcm(
    modelPath: String,
    windowText: String,
    pcm: ReadableMap,
    sampleRate: Double,
    granularity: String,
    language: String?,
    promise: Promise,
  ) {
    alignmentHelper.alignAccurateForcedCtcFromPcm(
      modelPath,
      windowText,
      pcm,
      sampleRate,
      granularity,
      language,
      promise,
    )
  }

  override fun alignAccurateFromPcm(
    modelPath: String,
    text: String,
    pcm: ReadableMap,
    sampleRate: Double,
    granularity: String,
    language: String?,
    promise: Promise,
  ) {
    alignmentHelper.alignAccurateFromPcm(
      modelPath,
      text,
      pcm,
      sampleRate,
      granularity,
      language,
      promise,
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

  override fun listAvailableOutputDevices(promise: Promise) {
    pcmPlayerService.listAvailableOutputDevices(promise)
  }

  override fun pausePcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.pause(playerId, promise)
  }

  override fun resumePcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.resume(playerId, promise)
  }

  override fun seekPcmPlayerToMs(playerId: String, positionMs: Double, promise: Promise) {
    pcmPlayerService.seekToMs(playerId, positionMs, promise)
  }

  override fun restartPcmPlayer(playerId: String, promise: Promise) {
    pcmPlayerService.restart(playerId, promise)
  }

  override fun getPcmPlayerPositionMs(playerId: String, promise: Promise) {
    pcmPlayerService.getPositionMs(playerId, promise)
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

  // ==================== VAD Methods ====================

  override fun initializeVad(instanceId: String, options: ReadableMap, promise: Promise) {
    vadHelper.initializeVad(instanceId, options, promise)
  }

  override fun detectVadModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    vadHelper.detectVadModel(modelDir, assetName, modelType, promise)
  }

  override fun detectPunctuationModel(
    modelDir: String,
    assetName: String?,
    modelType: String?,
    promise: Promise
  ) {
    punctuationHelper.detectPunctuationModel(modelDir, assetName, modelType, promise)
  }

  override fun initializeOfflinePunctuation(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    punctuationHelper.initializeOfflinePunctuation(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      provider,
      debug,
      promise
    )
  }

  override fun punctuateOfflineTextBuffers(
    instanceId: String,
    textInBufferId: String,
    textOutBufferId: String,
    promise: Promise
  ) {
    punctuationHelper.punctuateOfflineTextBuffers(instanceId, textInBufferId, textOutBufferId, promise)
  }

  override fun punctuateOfflineString(
    instanceId: String,
    plain: String,
    textOutBufferId: String,
    promise: Promise
  ) {
    punctuationHelper.punctuateOfflineString(instanceId, plain, textOutBufferId, promise)
  }

  override fun unloadOfflinePunctuation(
    instanceId: String,
    promise: Promise
  ) {
    punctuationHelper.unloadOfflinePunctuation(instanceId, promise)
  }

  override fun initializeOnlinePunctuation(
    instanceId: String,
    modelDir: String,
    modelType: String?,
    numThreads: Double?,
    provider: String?,
    debug: Boolean?,
    promise: Promise
  ) {
    onlinePunctuationHelper.initializeOnlinePunctuation(
      instanceId,
      modelDir,
      modelType,
      numThreads,
      provider,
      debug,
      promise
    )
  }

  override fun processOnlinePunctuationChunk(
    instanceId: String,
    text: String,
    promise: Promise
  ) {
    onlinePunctuationHelper.processOnlinePunctuationChunk(instanceId, text, promise)
  }

  override fun unloadOnlinePunctuation(
    instanceId: String,
    promise: Promise
  ) {
    onlinePunctuationHelper.unloadOnlinePunctuation(instanceId, promise)
  }

  override fun startStreamingPunctuationPipeline(
    instanceId: String,
    inputBufferId: String,
    outputBufferId: String,
    promise: Promise
  ) {
    onlinePunctuationHelper.startStreamingPunctuationPipeline(instanceId, inputBufferId, outputBufferId, promise)
  }

  override fun startVadPipeline(
    instanceId: String,
    audioInBufferId: String,
    segmentOutBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) {
    vadHelper.startVadPipeline(instanceId, audioInBufferId, segmentOutBufferId, options, promise)
  }

  override fun runVadOffline(
    instanceId: String,
    audioInBufferId: String,
    segmentOutBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) {
    vadHelper.runVadOffline(instanceId, audioInBufferId, segmentOutBufferId, options, promise)
  }

  override fun flushVad(pipelineId: String, promise: Promise) {
    vadHelper.flushVad(pipelineId, promise)
  }

  override fun resetVad(pipelineId: String, promise: Promise) {
    vadHelper.resetVad(pipelineId, promise)
  }

  override fun stopVadPipeline(pipelineId: String, promise: Promise) {
    vadHelper.stopVadPipeline(pipelineId, promise)
  }

  override fun getVadPipelineStatus(pipelineId: String, promise: Promise) {
    vadHelper.getVadPipelineStatus(pipelineId, promise)
  }

  override fun isVadSpeechDetected(instanceId: String, promise: Promise) {
    vadHelper.isVadSpeechDetected(instanceId, promise)
  }

  override fun unloadVad(instanceId: String, promise: Promise) {
    vadHelper.unloadVad(instanceId, promise)
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

  // ==================== File I/O ====================

  override fun copyFile(
    source: ReadableMap,
    destination: ReadableMap,
    overwrite: Boolean,
    createParentDirectories: Boolean,
    operationId: String,
    promise: Promise,
  ) {
    fileIOHelper.copyFile(source, destination, overwrite, createParentDirectories, operationId, promise)
  }

  override fun saveText(
    text: String,
    destination: ReadableMap,
    encoding: String,
    overwrite: Boolean,
    promise: Promise,
  ) {
    fileIOHelper.saveText(text, destination, encoding, overwrite, promise)
  }

  override fun shareFile(
    source: ReadableMap,
    mimeType: String,
    title: String,
    promise: Promise,
  ) {
    fileIOHelper.shareFile(source, mimeType, title, promise)
  }

  override fun cancelFileIO(operationId: String, promise: Promise) {
    fileIOHelper.cancelFileIO(operationId, promise)
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

    @JvmStatic
    private external fun nativeDetectVadModel(
      modelDir: String?,
      assetName: String?,
      modelType: String
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeDetectPunctuationModel(
      modelDir: String?,
      assetName: String?,
      modelType: String
    ): HashMap<String, Any>?

    /** Model detection for subtitles/alignment: returns HashMap with success, error, detectedModels, modelType, paths. */
    @JvmStatic
    private external fun nativeDetectAlignmentModel(modelDir: String, modelType: String): HashMap<String, Any>?

    // -- AudioEncodeSession JNI --
    @JvmStatic
    private external fun nativeEncodeSessionCreate(
      outputPath: String, format: String,
      inputSampleRate: Int, inputChannelCount: Int,
      outputSampleRateHz: Int, bitrate: Int, quality: Int,
      totalFramesEstimate: Long,
      cancelFlagPtr: Long
    ): Long

    @JvmStatic
    private external fun nativeEncodeSessionFeedChunk(
      sessionPtr: Long, samples: FloatArray, frameCount: Int
    ): String

    @JvmStatic
    private external fun nativeEncodeSessionFinish(
      sessionPtr: Long
    ): String

    @JvmStatic
    private external fun nativeEncodeSessionRelease(
      sessionPtr: Long
    )

    /** Batch decode: returns HashMap{samples: FloatArray, sourceSampleRate: Int, sourceChannels: Int, totalFramesDecoded: Long}. */
    @JvmStatic
    external fun nativeDecodeFileToBuffer(
      path: String?,
      inputFd: Int,
      targetSampleRate: Int,
      forceMono: Boolean,
      chunkSize: Int,
      cancelFlagPtr: Long
    ): HashMap<String, Any>?

    /** Streaming decode to raw .f32 file: returns HashMap{outputPath: String, numSamples: Long, sourceSampleRate: Int, sourceChannels: Int}. */
    @JvmStatic
    external fun nativeDecodeFileToMmapFile(
      path: String?,
      inputFd: Int,
      targetSampleRate: Int,
      forceMono: Boolean,
      chunkSize: Int,
      cancelFlagPtr: Long,
      outputPath: String
    ): HashMap<String, Any>?

    /** Streaming decode: delivers chunks via callback. Returns HashMap{sourceSampleRate, sourceChannels, totalFramesDecoded}. */
    @JvmStatic
    external fun nativeDecodeFileStreaming(
      path: String?,
      inputFd: Int,
      targetSampleRate: Int,
      forceMono: Boolean,
      chunkSize: Int,
      cancelFlagPtr: Long,
      chunkCallback: Any,
      progressCallback: Any?
    ): HashMap<String, Any>?

    /** Allocate a native std::atomic<bool> cancel flag. Returns a pointer as Long. */
    @JvmStatic
    external fun nativeAllocateCancelFlag(): Long

    /** Set a native cancel flag to the given value. */
    @JvmStatic
    external fun nativeSetCancelFlag(ptr: Long, value: Boolean)

    /** Free a previously allocated native cancel flag. */
    @JvmStatic
    external fun nativeFreeCancelFlag(ptr: Long)
  }
}
