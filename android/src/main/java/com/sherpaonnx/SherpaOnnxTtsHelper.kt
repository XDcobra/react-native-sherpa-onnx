package com.sherpaonnx

import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
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
import java.util.concurrent.atomic.AtomicBoolean

internal class SherpaOnnxTtsHelper(
  private val context: ReactApplicationContext,
  private val detectTtsModel: (modelDir: String, modelType: String) -> HashMap<String, Any>?,
  private val emitChunk: (FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String) -> Unit,
  private val emitEnd: (Boolean) -> Unit
) {

  private data class TtsInitState(
    val modelDir: String,
    val modelType: String,
    val numThreads: Int,
    val debug: Boolean,
    val noiseScale: Double?,
    val noiseScaleW: Double?,
    val lengthScale: Double?
  )

  // Dual-engine: either OfflineTts (Kotlin API) or ZipvoiceTtsWrapper (C-API)
  @Volatile
  private var tts: OfflineTts? = null
  @Volatile
  private var zipvoiceTts: ZipvoiceTtsWrapper? = null

  private val ttsStreamRunning = AtomicBoolean(false)
  private val ttsStreamCancelled = AtomicBoolean(false)
  private var ttsStreamThread: Thread? = null
  private var ttsPcmTrack: AudioTrack? = null
  private var ttsInitState: TtsInitState? = null

  /** True when the active engine is ZipvoiceTtsWrapper */
  private val isZipvoice: Boolean get() = zipvoiceTts != null

  fun initializeTts(
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    try {
      
      val result = detectTtsModel(modelDir, modelType)
      if (result == null) {
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to detect TTS model: native call returned null")
        promise.reject("TTS_INIT_ERROR", "Failed to detect TTS model: native call returned null")
        return
      }
      val success = result["success"] as? Boolean ?: false
      if (!success) {
        val reason = result["error"] as? String
        Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: ${reason ?: "Failed to detect TTS model"}")
        promise.reject("TTS_INIT_ERROR", reason ?: "Failed to detect TTS model")
        return
      }
      val paths = (result["paths"] as? Map<*, *>)?.mapValues { (_, v) -> (v as? String).orEmpty() }?.mapKeys { it.key.toString() } ?: emptyMap()
      val modelTypeStr = result["modelType"] as? String ?: "vits"
      val detectedModels = result["detectedModels"] as? ArrayList<*>

      releaseEngines()

      val sampleRate: Int
      val numSpeakers: Int

      if (modelTypeStr == "zipvoice") {
        val wrapper = ZipvoiceTtsWrapper.create(
          tokens = path(paths, "tokens"),
          encoder = path(paths, "encoder"),
          decoder = path(paths, "decoder"),
          vocoder = path(paths, "vocoder"),
          dataDir = path(paths, "dataDir"),
          lexicon = path(paths, "lexicon"),
          numThreads = numThreads.toInt(),
          debug = debug
        )
        if (wrapper == null) {
          Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to create Zipvoice TTS engine via C-API. Check logcat for details.")
          promise.reject("TTS_INIT_ERROR", "Failed to create Zipvoice TTS engine via C-API. Check logcat for details.")
          return
        }
        zipvoiceTts = wrapper
        sampleRate = wrapper.sampleRate()
        numSpeakers = wrapper.numSpeakers()
      } else {
        val config = buildTtsConfig(paths, modelTypeStr, numThreads.toInt(), debug, noiseScale, noiseScaleW, lengthScale)
        tts = OfflineTts(config = config)
        sampleRate = tts!!.sampleRate()
        numSpeakers = tts!!.numSpeakers()
      }

      Log.i("SherpaOnnxTts", "initializeTts: engine=${if (isZipvoice) "zipvoice-c-api" else "kotlin-api"}, sampleRate=$sampleRate, numSpeakers=$numSpeakers")

      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      ttsInitState = TtsInitState(
        modelDir,
        modelType,
        numThreads.toInt(),
        debug,
        noiseScale?.takeUnless { it.isNaN() },
        noiseScaleW?.takeUnless { it.isNaN() },
        lengthScale?.takeUnless { it.isNaN() }
      )

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      resultMap.putInt("sampleRate", sampleRate)
      resultMap.putInt("numSpeakers", numSpeakers)
      promise.resolve(resultMap)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_INIT_ERROR: Failed to initialize TTS: ${e.message}", e)
      promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS: ${e.message}", e)
    }
  }

  fun updateTtsParams(
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    if (ttsStreamRunning.get()) {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: Cannot update params while streaming")
      promise.reject("TTS_UPDATE_ERROR", "Cannot update params while streaming")
      return
    }
    val state = ttsInitState ?: run {
      Log.e("SherpaOnnxTts", "TTS_UPDATE_ERROR: TTS not initialized")
      promise.reject("TTS_UPDATE_ERROR", "TTS not initialized")
      return
    }

    // Zipvoice has no tunable noise/length params; re-init is the only way to "update"
    if (isZipvoice) {
      // Re-initialize with same params (Zipvoice ignores noise/length scales)
      initializeTts(
        state.modelDir, state.modelType, state.numThreads.toDouble(), state.debug,
        noiseScale, noiseScaleW, lengthScale, promise
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

      tts?.release()
      tts = null
      val config = buildTtsConfig(paths, modelTypeStr, state.numThreads, state.debug, nextNoiseScale, nextNoiseScaleW, nextLengthScale)
      tts = OfflineTts(config = config)
      val ttsInstance = tts!!

      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      ttsInitState = state.copy(
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

  fun generateTts(text: String, options: ReadableMap?, promise: Promise) {
    try {
      if (!hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }
      val sid = getSid(options)
      val speed = getSpeed(options)
      val audio = when {
        hasReferenceOptions(options) && isZipvoice -> {
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
          zipvoiceTts!!.generateWithZipvoice(text, promptText, samples, promptSr, speed, numSteps)
        }
        hasReferenceOptions(options) && tts != null -> {
          val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          tts!!.generateWithConfig(text, config)
        }
        else -> dispatchGenerate(text, sid, speed)
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
      Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: ${e.message ?: "Failed to generate speech"}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  fun generateTtsWithTimestamps(text: String, options: ReadableMap?, promise: Promise) {
    try {
      if (!hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }
      val sid = getSid(options)
      val speed = getSpeed(options)
      val audio = when {
        hasReferenceOptions(options) && isZipvoice -> {
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
          zipvoiceTts!!.generateWithZipvoice(text, promptText, samples, promptSr, speed, numSteps)
        }
        hasReferenceOptions(options) && tts != null -> {
          val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          tts!!.generateWithConfig(text, config)
        }
        else -> dispatchGenerate(text, sid, speed)
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

  fun generateTtsStream(text: String, options: ReadableMap?, promise: Promise) {
    if (ttsStreamRunning.get()) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: TTS streaming already in progress")
      promise.reject("TTS_STREAM_ERROR", "TTS streaming already in progress")
      return
    }
    if (!hasEngine()) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: TTS not initialized")
      promise.reject("TTS_STREAM_ERROR", "TTS not initialized")
      return
    }
    if (hasReferenceOptions(options) && isZipvoice) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: Streaming with reference audio not supported for Zipvoice")
      promise.reject("TTS_STREAM_ERROR", "Streaming with reference audio not supported for Zipvoice")
      return
    }
    val sid = getSid(options)
    val speed = getSpeed(options)
    ttsStreamCancelled.set(false)
    ttsStreamRunning.set(true)
    ttsStreamThread = Thread {
      try {
        val sampleRate = dispatchSampleRate()
        when {
          hasReferenceOptions(options) && tts != null -> {
            val config = parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
            tts!!.generateWithConfigAndCallback(text, config) { chunk ->
              if (ttsStreamCancelled.get()) return@generateWithConfigAndCallback 0
              emitChunk(chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
          zipvoiceTts != null -> {
            zipvoiceTts!!.generateWithCallback(text, sid, speed) { chunk ->
              if (ttsStreamCancelled.get()) return@generateWithCallback 0
              emitChunk(chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
          else -> {
            tts!!.generateWithCallback(text, sid, speed) { chunk ->
              if (ttsStreamCancelled.get()) return@generateWithCallback 0
              emitChunk(chunk, sampleRate, 0f, false)
              chunk.size
            }
          }
        }
        if (!ttsStreamCancelled.get()) {
          emitChunk(FloatArray(0), sampleRate, 1f, true)
        }
      } catch (e: Exception) {
        if (!ttsStreamCancelled.get()) {
          emitError("TTS streaming failed: ${e.message}")
        }
      } finally {
        emitEnd(ttsStreamCancelled.get())
        ttsStreamRunning.set(false)
      }
    }
    ttsStreamThread?.start()
    promise.resolve(null)
  }

  fun cancelTtsStream(promise: Promise) {
    ttsStreamCancelled.set(true)
    ttsStreamThread?.interrupt()
    promise.resolve(null)
  }

  fun startTtsPcmPlayer(sampleRate: Double, channels: Double, promise: Promise) {
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
      stopPcmPlayerInternal()
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
      ttsPcmTrack = AudioTrack(attributes, audioFormat, minBufferSize, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
      ttsPcmTrack?.play()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to start PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to start PCM player", e)
    }
  }

  fun writeTtsPcmChunk(samples: ReadableArray, promise: Promise) {
    val track = ttsPcmTrack ?: run {
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

  fun stopTtsPcmPlayer(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to stop PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to stop PCM player", e)
    }
  }

  fun getTtsSampleRate(promise: Promise) {
    try {
      if (!hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(dispatchSampleRate().toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get sample rate", e)
      promise.reject("TTS_ERROR", "Failed to get sample rate", e)
    }
  }

  fun getTtsNumSpeakers(promise: Promise) {
    try {
      if (!hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_ERROR: TTS not initialized")
        promise.reject("TTS_ERROR", "TTS not initialized")
        return
      }
      promise.resolve(dispatchNumSpeakers().toDouble())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_ERROR: Failed to get number of speakers", e)
      promise.reject("TTS_ERROR", "Failed to get number of speakers", e)
    }
  }

  fun unloadTts(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      releaseEngines()
      ttsInitState = null
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

  fun emitTtsStreamChunk(samples: FloatArray, sampleRate: Int, progress: Float, isFinal: Boolean) {
    emitChunk(samples, sampleRate, progress, isFinal)
  }

  fun emitTtsStreamError(message: String) {
    emitError(message)
  }

  fun emitTtsStreamEnd(cancelled: Boolean) {
    emitEnd(cancelled)
  }

  // -- Dual-engine dispatch helpers --

  /** True if any TTS engine (Kotlin API or Zipvoice C-API) is loaded */
  private fun hasEngine(): Boolean = tts != null || zipvoiceTts != null

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

  /** Dispatch generate to whichever engine is active. Returns null if none loaded. */
  private fun dispatchGenerate(text: String, sid: Int, speed: Float): GeneratedAudio? {
    zipvoiceTts?.let { return it.generate(text, sid, speed) }
    tts?.let { return it.generate(text, sid, speed) }
    return null
  }

  private fun dispatchSampleRate(): Int {
    zipvoiceTts?.let { return it.sampleRate() }
    return tts?.sampleRate() ?: 0
  }

  private fun dispatchNumSpeakers(): Int {
    zipvoiceTts?.let { return it.numSpeakers() }
    return tts?.numSpeakers() ?: 0
  }

  /** Release both engines. */
  private fun releaseEngines() {
    tts?.release()
    tts = null
    zipvoiceTts?.release()
    zipvoiceTts = null
  }

  private fun stopPcmPlayerInternal() {
    ttsPcmTrack?.apply {
      try { stop() } catch (_: IllegalStateException) {}
      flush()
      release()
    }
    ttsPcmTrack = null
  }

  private fun path(paths: Map<String, String>, key: String): String = paths[key].orEmpty()

  private fun buildTtsConfig(
    paths: Map<String, String>,
    modelType: String,
    numThreads: Int,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?
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
    return OfflineTtsConfig(model = modelConfig)
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
