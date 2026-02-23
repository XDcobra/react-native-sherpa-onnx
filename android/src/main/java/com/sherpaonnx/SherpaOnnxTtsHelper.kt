package com.sherpaonnx

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class SherpaOnnxTtsHelper(
  private val context: ReactApplicationContext,
  private val detectTtsModel: (modelDir: String, modelType: String) -> HashMap<String, Any>?,
  private val emitChunk: (String, FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String, String) -> Unit,
  private val emitEnd: (String, Boolean) -> Unit
) {

  private data class TtsInitState(
    val modelDir: String,
    val modelType: String,
    val numThreads: Int,
    val debug: Boolean,
    val noiseScale: Double?,
    val noiseScaleW: Double?,
    val lengthScale: Double?,
    val ruleFsts: String?,
    val ruleFars: String?,
    val maxNumSentences: Int?,
    val silenceScale: Double?
  )

  private data class TtsEngineInstance(
    @Volatile var tts: OfflineTts? = null,
    @Volatile var zipvoiceTts: ZipvoiceTtsWrapper? = null,
    var ttsInitState: TtsInitState? = null,
    val ttsStreamRunning: AtomicBoolean = AtomicBoolean(false),
    val ttsStreamCancelled: AtomicBoolean = AtomicBoolean(false),
    var ttsStreamThread: Thread? = null,
    var ttsPcmTrack: AudioTrack? = null
  ) {
    fun hasEngine(): Boolean = tts != null || zipvoiceTts != null
    val isZipvoice: Boolean get() = zipvoiceTts != null
    fun releaseEngines() {
      tts?.release()
      tts = null
      zipvoiceTts?.release()
      zipvoiceTts = null
      ttsInitState = null
    }
    fun stopPcmPlayer() {
      ttsPcmTrack?.apply {
        try { stop() } catch (_: IllegalStateException) {}
        flush()
        release()
      }
      ttsPcmTrack = null
    }
  }

  private val instances = ConcurrentHashMap<String, TtsEngineInstance>()

  private fun getInstance(instanceId: String): TtsEngineInstance? = instances[instanceId]

  /** Run promise resolve/reject on the UI thread so React state updates run on the main thread. */
  private val mainHandler = Handler(Looper.getMainLooper())
  private fun resolveOnUiThread(promise: Promise, result: WritableMap) {
    mainHandler.post { promise.resolve(result) }
  }
  private fun rejectOnUiThread(promise: Promise, code: String, message: String, throwable: Throwable? = null) {
    mainHandler.post {
      if (throwable != null) promise.reject(code, message, throwable) else promise.reject(code, message)
    }
  }

  /** Single-thread executor for TTS init so the RN bridge thread is not blocked (avoids Inspector/dev WebSocket races in debug builds). */
  private val ttsInitExecutor = Executors.newSingleThreadExecutor()

  /**
   * Shuts down the TTS init executor and releases all engine instances.
   * Call from the native module's onCatalystInstanceDestroy() to avoid leaking the executor thread.
   */
  fun shutdown() {
    try {
      ttsInitExecutor.shutdown()
      if (!ttsInitExecutor.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS)) {
        ttsInitExecutor.shutdownNow()
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      ttsInitExecutor.shutdownNow()
    }
    instances.values.forEach { inst ->
      inst.releaseEngines()
      inst.stopPcmPlayer()
    }
    instances.clear()
  }

  fun initializeTts(
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
    promise: Promise
  ) {
    ttsInitExecutor.execute init@{
      try {
      val result = detectTtsModel(modelDir, modelType)
      if (result == null) {
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to detect TTS model: native call returned null")
        rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to detect TTS model: native call returned null")
        return@init
      }
      val success = result["success"] as? Boolean ?: false
      if (!success) {
        val reason = result["error"] as? String
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: ${reason ?: "Failed to detect TTS model"}")
        rejectOnUiThread(promise, "TTS_INIT_ERROR", reason ?: "Failed to detect TTS model")
        return@init
      }
      val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
      val modelTypeStr = result["modelType"] as? String ?: "vits"
      val detectedModels = result["detectedModels"] as? ArrayList<*>

      val inst = instances.getOrPut(instanceId) { TtsEngineInstance() }
      inst.stopPcmPlayer()
      inst.releaseEngines()

      val sampleRate: Int
      val numSpeakers: Int

      if (modelTypeStr == "zipvoice") {
        val vocoderPath = path(paths, "vocoder")
        if (vocoderPath.isBlank()) {
          val msg = "Zipvoice distill models (encoder+decoder only, no vocoder) are not supported. Use the full Zipvoice model that includes vocos_24khz.onnx (or similar vocoder file)."
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
          rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
          return@init
        }
        val am = context.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null) {
          val memInfo = ActivityManager.MemoryInfo()
          am.getMemoryInfo(memInfo)
          val availMb = memInfo.availMem / (1024 * 1024)
          if (memInfo.availMem < 800L * 1024 * 1024) {
            val msg = "Not enough free memory to load the full Zipvoice model (available: ${availMb} MB). Use the int8 distill variant (sherpa-onnx-zipvoice-distill-int8-zh-en-emilia) or close other apps."
            Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: $msg")
            rejectOnUiThread(promise, "TTS_INIT_ERROR", msg)
            return@init
          }
        }
        // Reduce memory pressure: GC before heavy allocation and cap threads to limit peak RAM.
        System.gc()
        Runtime.getRuntime().gc()
        if (am != null) {
          val memInfoBefore = ActivityManager.MemoryInfo()
          am.getMemoryInfo(memInfoBefore)
          Log.i("SherpaOnnxTts", "Zipvoice init: availMem=${memInfoBefore.availMem / (1024 * 1024)} MB (before load)")
        }
        val zipvoiceNumThreads = 1
        val wrapper = ZipvoiceTtsWrapper.create(
          tokens = path(paths, "tokens"),
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          vocoder = vocoderPath,
          dataDir = path(paths, "dataDir"),
          lexicon = path(paths, "lexicon"),
          numThreads = zipvoiceNumThreads,
          debug = debug,
          ruleFsts = ruleFsts?.takeIf { it.isNotBlank() } ?: "",
          ruleFars = ruleFars?.takeIf { it.isNotBlank() } ?: "",
          maxNumSentences = maxNumSentences?.toInt()?.coerceAtLeast(1) ?: 1,
          silenceScale = silenceScale?.toFloat()?.coerceIn(0f, 10f) ?: 0.2f
        )
        if (am != null) {
          val memInfo = ActivityManager.MemoryInfo()
          am.getMemoryInfo(memInfo)
          Log.i("SherpaOnnxTts", "Zipvoice init: availMem=${memInfo.availMem / (1024 * 1024)} MB (after load)")
        }
        if (wrapper == null) {
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to create Zipvoice TTS engine via C-API. Check logcat for details.")
          rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to create Zipvoice TTS engine via C-API. Check logcat for details.")
          return@init
        }
        inst.zipvoiceTts = wrapper
        sampleRate = wrapper.sampleRate()
        numSpeakers = wrapper.numSpeakers()
      } else {
        val config = buildTtsConfig(
          paths, modelTypeStr, numThreads.toInt(), debug,
          noiseScale, noiseScaleW, lengthScale,
          ruleFsts, ruleFars, maxNumSentences?.toInt(), silenceScale
        )
        inst.tts = OfflineTts(config = config)
        sampleRate = inst.tts!!.sampleRate()
        numSpeakers = inst.tts!!.numSpeakers()
      }

      Log.i("SherpaOnnxTts", "initializeTts: instanceId=$instanceId, engine=${if (inst.isZipvoice) "zipvoice-c-api" else "kotlin-api"}, sampleRate=$sampleRate, numSpeakers=$numSpeakers")

      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      inst.ttsInitState = TtsInitState(
        modelDir,
        modelType,
        numThreads.toInt(),
        debug,
        noiseScale?.takeUnless { it.isNaN() },
        noiseScaleW?.takeUnless { it.isNaN() },
        lengthScale?.takeUnless { it.isNaN() },
        ruleFsts?.takeIf { it.isNotBlank() },
        ruleFars?.takeIf { it.isNotBlank() },
        maxNumSentences?.toInt()?.takeIf { it > 0 },
        silenceScale?.takeUnless { it.isNaN() }
      )

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      resultMap.putInt("sampleRate", sampleRate)
      resultMap.putInt("numSpeakers", numSpeakers)
      resolveOnUiThread(promise, resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to initialize TTS: ${e.message}", e)
      rejectOnUiThread(promise, "TTS_INIT_ERROR", "Failed to initialize TTS: ${e.message}", e)
    }
    }
  }

  fun updateTtsParams(
    instanceId: String,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    val inst = getInstance(instanceId) ?: run {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_UPDATE_ERROR", "TTS instance not found: $instanceId")
      return
    }
    if (inst.ttsStreamRunning.get()) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Cannot update params while streaming")
      promise.reject("TTS_UPDATE_ERROR", "Cannot update params while streaming")
      return
    }
    val state = inst.ttsInitState ?: run {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: TTS not initialized")
      promise.reject("TTS_UPDATE_ERROR", "TTS not initialized")
      return
    }

    if (inst.isZipvoice) {
      initializeTts(
        instanceId,
        state.modelDir, state.modelType, state.numThreads.toDouble(), state.debug,
        noiseScale, noiseScaleW, lengthScale,
        state.ruleFsts, state.ruleFars, state.maxNumSentences?.toDouble(), state.silenceScale,
        promise
      )
      return
    }

    val nextNoiseScale = when {
      noiseScale == null -> null
      noiseScale.isNaN() -> state.noiseScale
      else -> noiseScale
    }
    val nextNoiseScaleW = when {
      noiseScaleW == null -> null
      noiseScaleW.isNaN() -> state.noiseScaleW
      else -> noiseScaleW
    }
    val nextLengthScale = when {
      lengthScale == null -> null
      lengthScale.isNaN() -> state.lengthScale
      else -> lengthScale
    }
    try {
      val result = detectTtsModel(state.modelDir, state.modelType)
      if (result == null || result["success"] as? Boolean != true) {
        Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to re-detect TTS model")
        promise.reject("TTS_UPDATE_ERROR", "Failed to re-detect TTS model")
        return
      }
      val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
      val modelTypeStr = result["modelType"] as? String ?: state.modelType
      val detectedModels = result["detectedModels"] as? ArrayList<*>

      inst.tts?.release()
      inst.tts = null
      val config = buildTtsConfig(
        paths, modelTypeStr, state.numThreads, state.debug,
        nextNoiseScale, nextNoiseScaleW, nextLengthScale,
        state.ruleFsts, state.ruleFars, state.maxNumSentences, state.silenceScale
      )
      inst.tts = OfflineTts(config = config)
      val ttsInstance = inst.tts!!

      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      inst.ttsInitState = state.copy(
        noiseScale = nextNoiseScale,
        noiseScaleW = nextNoiseScaleW,
        lengthScale = nextLengthScale
      )

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      resultMap.putInt("sampleRate", ttsInstance.sampleRate())
      resultMap.putInt("numSpeakers", ttsInstance.numSpeakers())
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Failed to update TTS params", e)
      promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params", e)
    }
  }

  fun generateTts(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }
      val sid = getSid(options)
      val speed = getSpeed(options)
      val audio = when {
        hasReferenceOptions(options) && inst.isZipvoice -> {
          val refAudio = options?.getArray("referenceAudio")
            ?: run {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: referenceAudio required for Zipvoice voice cloning")
              promise.reject("TTS_GENERATE_ERROR", "referenceAudio required for Zipvoice voice cloning")
              return
            }
          val promptSr = if (options.hasKey("referenceSampleRate")) options.getDouble("referenceSampleRate").toInt() else 0
          val promptText = options.getString("referenceText").orEmpty()
          val numSteps = if (options.hasKey("numSteps")) options.getDouble("numSteps").toInt() else 20
          val samples = FloatArray(refAudio.size()) { i -> refAudio.getDouble(i).toFloat() }
          inst.zipvoiceTts!!.generateWithZipvoice(text, promptText, samples, promptSr, speed, numSteps)
        }
        hasReferenceOptions(options) && inst.tts != null -> {
          val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          inst.tts!!.generateWithConfig(text, config)
        }
        else -> dispatchGenerate(inst, text, sid, speed)
          ?: run {
            Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
            promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
            return
          }
      }
      val map = Arguments.createMap()
      val samplesArray = Arguments.createArray()
      for (sample in audio.samples) {
        samplesArray.pushDouble(sample.toDouble())
      }
      map.putArray("samples", samplesArray)
      map.putInt("sampleRate", audio.sampleRate)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "generateTts error: ${e.message}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  fun generateTtsWithTimestamps(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }
      val sid = getSid(options)
      val speed = getSpeed(options)
      val audio = when {
        hasReferenceOptions(options) && inst.isZipvoice -> {
          val refAudio = options?.getArray("referenceAudio")
            ?: run {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: referenceAudio required for Zipvoice voice cloning")
              promise.reject("TTS_GENERATE_ERROR", "referenceAudio required for Zipvoice voice cloning")
              return
            }
          val promptSr = if (options.hasKey("referenceSampleRate")) options.getDouble("referenceSampleRate").toInt() else 0
          val promptText = options.getString("referenceText").orEmpty()
          val numSteps = if (options.hasKey("numSteps")) options.getDouble("numSteps").toInt() else 20
          val samples = FloatArray(refAudio.size()) { i -> refAudio.getDouble(i).toFloat() }
          inst.zipvoiceTts!!.generateWithZipvoice(text, promptText, samples, promptSr, speed, numSteps)
        }
        hasReferenceOptions(options) && inst.tts != null -> {
          val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          inst.tts!!.generateWithConfig(text, config)
        }
        else -> dispatchGenerate(inst, text, sid, speed)
          ?: run {
            Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
            promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
            return
          }
      }
      val map = Arguments.createMap()
      val samplesArray = Arguments.createArray()
      for (sample in audio.samples) {
        samplesArray.pushDouble(sample.toDouble())
      }
      map.putArray("samples", samplesArray)
      map.putInt("sampleRate", audio.sampleRate)
      val subtitlesArray = Arguments.createArray()
      if (audio.samples.isNotEmpty() && audio.sampleRate > 0) {
        val durationSec = audio.samples.size.toDouble() / audio.sampleRate
        val subtitleMap = Arguments.createMap()
        subtitleMap.putString("text", text)
        subtitleMap.putDouble("start", 0.0)
        subtitleMap.putDouble("end", durationSec)
        subtitlesArray.pushMap(subtitleMap)
      }
      map.putArray("subtitles", subtitlesArray)
      map.putBoolean("estimated", true)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: ${e.message ?: "Failed to generate speech"}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  fun generateTtsStream(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_STREAM_ERROR", "TTS instance not found: $instanceId")
      return
    }
    if (inst.ttsStreamRunning.get()) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: TTS streaming already in progress")
      promise.reject("TTS_STREAM_ERROR", "TTS streaming already in progress")
      return
    }
    if (!inst.hasEngine()) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: TTS not initialized")
      promise.reject("TTS_STREAM_ERROR", "TTS not initialized")
      return
    }
    if (hasReferenceOptions(options) && inst.isZipvoice) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: Streaming with reference audio not supported for Zipvoice")
      promise.reject("TTS_STREAM_ERROR", "Streaming with reference audio not supported for Zipvoice")
      return
    }
    val sid = getSid(options)
    val speed = getSpeed(options)
    inst.ttsStreamCancelled.set(false)
    inst.ttsStreamRunning.set(true)
    inst.ttsStreamThread = Thread {
      try {
        val sampleRate = dispatchSampleRate(inst)
        when {
          hasReferenceOptions(options) && inst.tts != null -> {
            val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
            inst.tts!!.generateWithConfigAndCallback(text, config) { chunk ->
              if (inst.ttsStreamCancelled.get()) return@generateWithConfigAndCallback 0
              emitChunk(instanceId, chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
          inst.zipvoiceTts != null -> {
            inst.zipvoiceTts!!.generateWithCallback(text, sid, speed) { chunk ->
              if (inst.ttsStreamCancelled.get()) return@generateWithCallback 0
              emitChunk(instanceId, chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
          else -> {
            inst.tts!!.generateWithCallback(text, sid, speed) { chunk ->
              if (inst.ttsStreamCancelled.get()) return@generateWithCallback 0
              emitChunk(instanceId, chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
        }
        if (!inst.ttsStreamCancelled.get()) {
          emitChunk(instanceId, FloatArray(0), sampleRate, 1f, true)
        }
      } catch (e: Exception) {
        if (!inst.ttsStreamCancelled.get()) {
          emitError(instanceId, "TTS streaming failed: ${e.message}")
        }
      } finally {
        emitEnd(instanceId, inst.ttsStreamCancelled.get())
        inst.ttsStreamRunning.set(false)
      }
    }
    inst.ttsStreamThread?.start()
    promise.resolve(null)
  }

  fun cancelTtsStream(instanceId: String, promise: Promise) {
    val inst = getInstance(instanceId)
    if (inst != null) {
      inst.ttsStreamCancelled.set(true)
      inst.ttsStreamThread?.interrupt()
    }
    promise.resolve(null)
  }

  fun startTtsPcmPlayer(instanceId: String, sampleRate: Double, channels: Double, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_PCM_ERROR", "TTS instance not found: $instanceId")
      return
    }
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM playback requires API 21+")
        promise.reject("TTS_PCM_ERROR", "PCM playback requires API 21+")
        return
      }
      if (channels.toInt() != 1) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM playback supports mono only")
        promise.reject("TTS_PCM_ERROR", "PCM playback supports mono only")
        return
      }
      inst.stopPcmPlayer()
      val channelConfig = AudioFormat.CHANNEL_OUT_MONO
      val audioFormat = AudioFormat.Builder()
        .setSampleRate(sampleRate.toInt())
        .setChannelMask(channelConfig)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .build()
      val minBufferSize = AudioTrack.getMinBufferSize(sampleRate.toInt(), channelConfig, AudioFormat.ENCODING_PCM_FLOAT)
      if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Invalid buffer size for PCM player")
        promise.reject("TTS_PCM_ERROR", "Invalid buffer size for PCM player")
        return
      }
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      inst.ttsPcmTrack = AudioTrack(attributes, audioFormat, minBufferSize, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
      inst.ttsPcmTrack?.play()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to start PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to start PCM player", e)
    }
  }

  fun writeTtsPcmChunk(instanceId: String, samples: ReadableArray, promise: Promise) {
    val inst = getInstance(instanceId) ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_PCM_ERROR", "TTS instance not found: $instanceId")
      return
    }
    val track = inst.ttsPcmTrack ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM player not initialized")
      promise.reject("TTS_PCM_ERROR", "PCM player not initialized")
      return
    }
    try {
      val buffer = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        buffer[i] = samples.getDouble(i).toFloat()
      }
      val written = track.write(buffer, 0, buffer.size, AudioTrack.WRITE_BLOCKING)
      if (written < 0) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM write failed: $written")
        promise.reject("TTS_PCM_ERROR", "PCM write failed: $written")
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to write PCM chunk", e)
      promise.reject("TTS_PCM_ERROR", "Failed to write PCM chunk", e)
    }
  }

  fun stopTtsPcmPlayer(instanceId: String, promise: Promise) {
    try {
      getInstance(instanceId)?.stopPcmPlayer()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to stop PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to stop PCM player", e)
    }
  }

  fun getTtsSampleRate(instanceId: String, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(dispatchSampleRate(inst).toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get sample rate", e)
      promise.reject("TTS_ERROR", "Failed to get sample rate", e)
    }
  }

  fun getTtsNumSpeakers(instanceId: String, promise: Promise) {
    try {
      val inst = getInstance(instanceId) ?: run {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(dispatchNumSpeakers(inst).toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get number of speakers", e)
      promise.reject("TTS_ERROR", "Failed to get number of speakers", e)
    }
  }

  fun unloadTts(instanceId: String, promise: Promise) {
    try {
      val inst = instances.remove(instanceId)
      if (inst != null) {
        inst.stopPcmPlayer()
        inst.releaseEngines()
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_RELEASE_ERROR: Failed to release TTS resources", e)
      promise.reject("TTS_RELEASE_ERROR", "Failed to release TTS resources", e)
    }
  }

  fun saveTtsAudioToFile(
    samples: ReadableArray,
    sampleRate: Double,
    filePath: String,
    promise: Promise
  ) {
    try {
      val samplesArray = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        samplesArray[i] = samples.getDouble(i).toFloat()
      }
      val success = GeneratedAudio(samplesArray, sampleRate.toInt()).save(filePath)
      if (success) {
        promise.resolve(filePath)
      } else {
        Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to save audio to file")
        promise.reject("TTS_SAVE_ERROR", "Failed to save audio to file")
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to save audio to file", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save audio to file", e)
    }
  }

  fun saveTtsAudioToContentUri(
    samples: ReadableArray,
    sampleRate: Double,
    directoryUri: String,
    filename: String,
    promise: Promise
  ) {
    try {
      val samplesArray = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        samplesArray[i] = samples.getDouble(i).toFloat()
      }
      val resolver = context.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = createDocumentInDirectory(resolver, dirUri, filename, "audio/wav")
      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        writeWavToStream(samplesArray, sampleRate.toInt(), outputStream)
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to save audio to content URI", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save audio to content URI", e)
    }
  }

  fun saveTtsTextToContentUri(
    text: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    try {
      val resolver = context.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = createDocumentInDirectory(resolver, dirUri, filename, mimeType)
      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        outputStream.write(text.toByteArray(Charsets.UTF_8))
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to save text to content URI", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save text to content URI", e)
    }
  }

  fun copyTtsContentUriToCache(fileUri: String, filename: String, promise: Promise) {
    try {
      val resolver = context.contentResolver
      val uri = Uri.parse(fileUri)
      val cacheFile = File(context.cacheDir, filename)
      resolver.openInputStream(uri)?.use { inputStream ->
        FileOutputStream(cacheFile).use { outputStream ->
          copyStream(inputStream, outputStream)
        }
      } ?: throw IllegalStateException("Failed to open input stream for URI: $fileUri")
      promise.resolve(cacheFile.absolutePath)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to copy audio to cache", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to copy audio to cache", e)
    }
  }

  fun shareTtsAudio(fileUri: String, mimeType: String, promise: Promise) {
    try {
      val uri = if (fileUri.startsWith("content://")) {
        Uri.parse(fileUri)
      } else {
        val path = if (fileUri.startsWith("file://")) {
          try {
            Uri.parse(fileUri).path ?: fileUri.replaceFirst("file://", "")
          } catch (_: Exception) {
            fileUri.replaceFirst("file://", "")
          }
        } else {
          fileUri
        }
        val file = File(path)
        val authority = context.packageName + ".fileprovider"
        FileProvider.getUriForFile(context, authority, file)
      }
      val shareIntent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(shareIntent, "Share audio")
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SHARE_ERROR: Failed to share audio", e)
      promise.reject("TTS_SHARE_ERROR", "Failed to share audio", e)
    }
  }

  // -- Dual-engine dispatch helpers --

  /** True if options contain reference-audio fields for voice cloning. */
  private fun hasReferenceOptions(options: ReadableMap?): Boolean {
    if (options == null) return false
    val refAudio = options.getArray("referenceAudio")
    val refText = options.getString("referenceText")
    return (refAudio != null && refAudio.size() > 0) || !refText.isNullOrEmpty()
  }

  /** Parse sid and speed from options with defaults. */
  private fun getSid(options: ReadableMap?): Int =
    if (options != null && options.hasKey("sid")) options.getDouble("sid").toInt() else 0

  private fun getSpeed(options: ReadableMap?): Float =
    if (options != null && options.hasKey("speed")) options.getDouble("speed").toFloat() else 1.0f

  /** Build Kotlin GenerationConfig from ReadableMap. Returns null only when options is null; otherwise returns a config with sid, speed, silenceScale, numSteps, and any reference/extra fields from options. */
  private fun parseGenerationConfig(options: ReadableMap?): GenerationConfig? {
    if (options == null) return null
    val refAudio = options.getArray("referenceAudio")
    val refSampleRate = if (options.hasKey("referenceSampleRate")) options.getDouble("referenceSampleRate").toInt() else 0
    val refText = options.getString("referenceText")
    val silenceScale = if (options.hasKey("silenceScale")) options.getDouble("silenceScale").toFloat() else 0.2f
    val speed = getSpeed(options)
    val sid = getSid(options)
    val numSteps = if (options.hasKey("numSteps")) options.getDouble("numSteps").toInt() else 5
    val extraMap = options.getMap("extra")?.let { map ->
      val it = map.keySetIterator()
      buildMap<String, String> {
        while (it.hasNextKey()) {
          val k = it.nextKey()
          put(k, map.getString(k).orEmpty())
        }
      }
    }
    val refAudioFloat = refAudio?.let { arr ->
      FloatArray(arr.size()) { i -> arr.getDouble(i).toFloat() }
    }
    return GenerationConfig(
      silenceScale = silenceScale,
      speed = speed,
      sid = sid,
      referenceAudio = refAudioFloat,
      referenceSampleRate = refSampleRate,
      referenceText = refText,
      numSteps = numSteps,
      extra = extraMap
    )
  }

  /** Dispatch generate to whichever engine is active on the instance. Returns null if none loaded. */
  private fun dispatchGenerate(inst: TtsEngineInstance, text: String, sid: Int, speed: Float): GeneratedAudio? {
    inst.zipvoiceTts?.let { return it.generate(text, sid, speed) }
    inst.tts?.let { return it.generate(text, sid, speed) }
    return null
  }

  private fun dispatchSampleRate(inst: TtsEngineInstance): Int {
    inst.zipvoiceTts?.let { return it.sampleRate() }
    return inst.tts?.sampleRate() ?: 0
  }

  private fun dispatchNumSpeakers(inst: TtsEngineInstance): Int {
    inst.zipvoiceTts?.let { return it.numSpeakers() }
    return inst.tts?.numSpeakers() ?: 0
  }

  private fun path(paths: Map<String, String>, key: String): String = paths[key].orEmpty()

  private fun buildTtsConfig(
    paths: Map<String, String>,
    modelType: String,
    numThreads: Int,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    ruleFsts: String?,
    ruleFars: String?,
    maxNumSentences: Int?,
    silenceScale: Double?
  ): OfflineTtsConfig {
    val ns = noiseScale?.toFloat() ?: 0.667f
    val nsw = noiseScaleW?.toFloat() ?: 0.8f
    val ls = lengthScale?.toFloat() ?: 1.0f
    val modelConfig = when (modelType) {
      "vits" -> OfflineTtsModelConfig(
        vits = OfflineTtsVitsModelConfig(
          model = path(paths, "ttsModel"),
          lexicon = path(paths, "lexicon"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          noiseScale = ns,
          noiseScaleW = nsw,
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug
      )
      "matcha" -> OfflineTtsModelConfig(
        matcha = OfflineTtsMatchaModelConfig(
          acousticModel = path(paths, "acousticModel"),
          vocoder = path(paths, "vocoder"),
          lexicon = path(paths, "lexicon"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          noiseScale = ns,
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug
      )
      "kokoro" -> OfflineTtsModelConfig(
        kokoro = OfflineTtsKokoroModelConfig(
          model = path(paths, "ttsModel"),
          voices = path(paths, "voices"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          lexicon = path(paths, "lexicon"),
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug
      )
      "kitten" -> OfflineTtsModelConfig(
        kitten = OfflineTtsKittenModelConfig(
          model = path(paths, "ttsModel"),
          voices = path(paths, "voices"),
          tokens = path(paths, "tokens"),
          dataDir = path(paths, "dataDir"),
          lengthScale = ls
        ),
        numThreads = numThreads,
        debug = debug
      )
      "pocket" -> OfflineTtsModelConfig(
        pocket = OfflineTtsPocketModelConfig(
          lmFlow = path(paths, "lmFlow"),
          lmMain = path(paths, "lmMain"),
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          textConditioner = path(paths, "textConditioner"),
          vocabJson = path(paths, "vocabJson"),
          tokenScoresJson = path(paths, "tokenScoresJson")
        ),
        numThreads = numThreads,
        debug = debug
      )
      "zipvoice" -> {
        // Zipvoice is handled by ZipvoiceTtsWrapper (C-API), not OfflineTts (Kotlin API).
        // This branch should not be reached because initializeTts/updateTtsParams handle
        // the "zipvoice" case before calling buildTtsConfig.
        throw IllegalStateException(
          "buildTtsConfig should not be called for zipvoice models. Use ZipvoiceTtsWrapper instead."
        )
      }
      else -> {
        if (path(paths, "acousticModel").isNotEmpty()) {
          OfflineTtsModelConfig(
            matcha = OfflineTtsMatchaModelConfig(
              acousticModel = path(paths, "acousticModel"),
              vocoder = path(paths, "vocoder"),
              lexicon = path(paths, "lexicon"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              noiseScale = ns,
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug
          )
        } else if (path(paths, "voices").isNotEmpty()) {
          OfflineTtsModelConfig(
            kokoro = OfflineTtsKokoroModelConfig(
              model = path(paths, "ttsModel"),
              voices = path(paths, "voices"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              lexicon = path(paths, "lexicon"),
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug
          )
        } else {
          OfflineTtsModelConfig(
            vits = OfflineTtsVitsModelConfig(
              model = path(paths, "ttsModel"),
              lexicon = path(paths, "lexicon"),
              tokens = path(paths, "tokens"),
              dataDir = path(paths, "dataDir"),
              noiseScale = ns,
              noiseScaleW = nsw,
              lengthScale = ls
            ),
            numThreads = numThreads,
            debug = debug
          )
        }
      }
    }
    return OfflineTtsConfig(
      model = modelConfig,
      ruleFsts = ruleFsts?.takeIf { it.isNotBlank() } ?: "",
      ruleFars = ruleFars?.takeIf { it.isNotBlank() } ?: "",
      maxNumSentences = maxNumSentences?.coerceAtLeast(1) ?: 1,
      silenceScale = silenceScale?.toFloat()?.coerceIn(0f, 10f) ?: 0.2f
    )
  }

  private fun createDocumentInDirectory(
    resolver: android.content.ContentResolver,
    directoryUri: Uri,
    filename: String,
    mimeType: String
  ): Uri {
    return if (DocumentsContract.isTreeUri(directoryUri)) {
      val documentId = DocumentsContract.getTreeDocumentId(directoryUri)
      val dirDocUri = DocumentsContract.buildDocumentUriUsingTree(directoryUri, documentId)
      DocumentsContract.createDocument(resolver, dirDocUri, mimeType, filename)
        ?: throw IllegalStateException("Failed to create document in tree URI")
    } else {
      DocumentsContract.createDocument(resolver, directoryUri, mimeType, filename)
        ?: throw IllegalStateException("Failed to create document in directory URI")
    }
  }

  private fun writeWavToStream(samples: FloatArray, sampleRate: Int, outputStream: OutputStream) {
    val numChannels = 1
    val bitsPerSample = 16
    val byteRate = sampleRate * numChannels * bitsPerSample / 8
    val blockAlign = numChannels * bitsPerSample / 8
    val dataSize = samples.size * 2
    val chunkSize = 36 + dataSize
    outputStream.write("RIFF".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, chunkSize)
    outputStream.write("WAVE".toByteArray(Charsets.US_ASCII))
    outputStream.write("fmt ".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, 16)
    writeShortLE(outputStream, 1)
    writeShortLE(outputStream, numChannels.toShort())
    writeIntLE(outputStream, sampleRate)
    writeIntLE(outputStream, byteRate)
    writeShortLE(outputStream, blockAlign.toShort())
    writeShortLE(outputStream, bitsPerSample.toShort())
    outputStream.write("data".toByteArray(Charsets.US_ASCII))
    writeIntLE(outputStream, dataSize)
    for (sample in samples) {
      val clamped = sample.coerceIn(-1.0f, 1.0f)
      val intSample = (clamped * 32767.0f).toInt()
      writeShortLE(outputStream, intSample.toShort())
    }
    outputStream.flush()
  }

  private fun writeIntLE(outputStream: OutputStream, value: Int) {
    outputStream.write(value and 0xFF)
    outputStream.write((value shr 8) and 0xFF)
    outputStream.write((value shr 16) and 0xFF)
    outputStream.write((value shr 24) and 0xFF)
  }

  private fun writeShortLE(outputStream: OutputStream, value: Short) {
    val intValue = value.toInt()
    outputStream.write(intValue and 0xFF)
    outputStream.write((intValue shr 8) and 0xFF)
  }

  private fun copyStream(inputStream: InputStream, outputStream: OutputStream) {
    val buffer = ByteArray(8192)
    var bytes = inputStream.read(buffer)
    while (bytes >= 0) {
      outputStream.write(buffer, 0, bytes)
      bytes = inputStream.read(buffer)
    }
    outputStream.flush()
  }
}
