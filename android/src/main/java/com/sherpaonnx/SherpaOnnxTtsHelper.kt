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
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal class SherpaOnnxTtsHelper(
  private val context: ReactApplicationContext,
  private val native: NativeTtsBridge,
  private val emitChunk: (FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String) -> Unit,
  private val emitEnd: (Boolean) -> Unit
) {
  interface NativeTtsBridge {
    fun nativeTtsInitialize(
      modelDir: String,
      modelType: String,
      numThreads: Int,
      debug: Boolean,
      noiseScale: Double,
      noiseScaleW: Double,
      lengthScale: Double
    ): HashMap<String, Any>?

    fun nativeTtsGenerate(text: String, sid: Int, speed: Float): HashMap<String, Any>?

    fun nativeTtsGenerateWithTimestamps(text: String, sid: Int, speed: Float): HashMap<String, Any>?

    fun nativeTtsGenerateStream(text: String, sid: Int, speed: Float): Boolean

    fun nativeTtsCancelStream()

    fun nativeTtsGetSampleRate(): Int

    fun nativeTtsGetNumSpeakers(): Int

    fun nativeTtsRelease()

    fun nativeTtsSaveToWavFile(samples: FloatArray, sampleRate: Int, filePath: String): Boolean
  }

  private data class TtsInitState(
    val modelDir: String,
    val modelType: String,
    val numThreads: Int,
    val debug: Boolean,
    val noiseScale: Double?,
    val noiseScaleW: Double?,
    val lengthScale: Double?
  )

  private val ttsStreamRunning = AtomicBoolean(false)
  private val ttsStreamCancelled = AtomicBoolean(false)
  private var ttsStreamThread: Thread? = null
  private var ttsPcmTrack: AudioTrack? = null
  private var ttsInitState: TtsInitState? = null

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
      val result = native.nativeTtsInitialize(
        modelDir,
        modelType,
        numThreads.toInt(),
        debug,
        noiseScale ?: Double.NaN,
        noiseScaleW ?: Double.NaN,
        lengthScale ?: Double.NaN
      )

      if (result == null) {
        promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS: native call returned null")
        return
      }

      val success = result["success"] as? Boolean ?: false

      if (success) {
        val detectedModels = result["detectedModels"] as? ArrayList<*>
        val modelsArray = Arguments.createArray()

        detectedModels?.forEach { modelObj ->
          if (modelObj is HashMap<*, *>) {
            val modelMap = Arguments.createMap()
            modelMap.putString("type", modelObj["type"] as? String ?: "")
            modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
            modelsArray.pushMap(modelMap)
          }
        }

        // Forward sampleRate and numSpeakers from native init result
        val sampleRate = (result["sampleRate"] as? Number)?.toInt() ?: -1
        val numSpeakers = (result["numSpeakers"] as? Number)?.toInt() ?: -1
        Log.i("SherpaOnnxTts", "initializeTts: sampleRate=$sampleRate, numSpeakers=$numSpeakers")

        val resultMap = Arguments.createMap()
        resultMap.putBoolean("success", true)
        resultMap.putArray("detectedModels", modelsArray)
        resultMap.putInt("sampleRate", sampleRate)
        resultMap.putInt("numSpeakers", numSpeakers)
        ttsInitState = TtsInitState(
          modelDir,
          modelType,
          numThreads.toInt(),
          debug,
          noiseScale?.takeUnless { it.isNaN() },
          noiseScaleW?.takeUnless { it.isNaN() },
          lengthScale?.takeUnless { it.isNaN() }
        )
        promise.resolve(resultMap)
      } else {
        val reason = result["error"] as? String
        val message = if (!reason.isNullOrBlank()) {
          "Failed to initialize TTS: $reason"
        } else {
          "Failed to initialize TTS"
        }
        promise.reject("TTS_INIT_ERROR", message)
      }
    } catch (e: Exception) {
      promise.reject("TTS_INIT_ERROR", "Failed to initialize TTS", e)
    }
  }

  fun updateTtsParams(
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  ) {
    if (ttsStreamRunning.get()) {
      promise.reject("TTS_UPDATE_ERROR", "Cannot update params while streaming")
      return
    }

    val state = ttsInitState
    if (state == null) {
      promise.reject("TTS_UPDATE_ERROR", "TTS not initialized")
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
      val result = native.nativeTtsInitialize(
        state.modelDir,
        state.modelType,
        state.numThreads,
        state.debug,
        nextNoiseScale ?: Double.NaN,
        nextNoiseScaleW ?: Double.NaN,
        nextLengthScale ?: Double.NaN
      )

      if (result == null) {
        promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params: native call returned null")
        return
      }

      val success = result["success"] as? Boolean ?: false
      if (!success) {
        promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params")
        return
      }

      val detectedModels = result["detectedModels"] as? ArrayList<*>
      val modelsArray = Arguments.createArray()
      detectedModels?.forEach { modelObj ->
        if (modelObj is HashMap<*, *>) {
          val modelMap = Arguments.createMap()
          modelMap.putString("type", modelObj["type"] as? String ?: "")
          modelMap.putString("modelDir", modelObj["modelDir"] as? String ?: "")
          modelsArray.pushMap(modelMap)
        }
      }

      val sampleRate2 = (result["sampleRate"] as? Number)?.toInt() ?: -1
      val numSpeakers2 = (result["numSpeakers"] as? Number)?.toInt() ?: -1

      val resultMap = Arguments.createMap()
      resultMap.putBoolean("success", true)
      resultMap.putArray("detectedModels", modelsArray)
      resultMap.putInt("sampleRate", sampleRate2)
      resultMap.putInt("numSpeakers", numSpeakers2)
      ttsInitState = TtsInitState(
        state.modelDir,
        state.modelType,
        state.numThreads,
        state.debug,
        nextNoiseScale,
        nextNoiseScaleW,
        nextLengthScale
      )
      promise.resolve(resultMap)
    } catch (e: Exception) {
      promise.reject("TTS_UPDATE_ERROR", "Failed to update TTS params", e)
    }
  }

  fun generateTts(text: String, sid: Double, speed: Double, promise: Promise) {
    try {
      val result = native.nativeTtsGenerate(text, sid.toInt(), speed.toFloat())
      if (result != null) {
        val map = Arguments.createMap()

        @Suppress("UNCHECKED_CAST")
        val samples = result["samples"] as? FloatArray
        val sampleRate = result["sampleRate"] as? Int

        if (samples != null && sampleRate != null && samples.isNotEmpty() && sampleRate > 0) {
          val samplesArray = Arguments.createArray()
          for (sample in samples) {
            samplesArray.pushDouble(sample.toDouble())
          }

          map.putArray("samples", samplesArray)
          map.putInt("sampleRate", sampleRate)
          promise.resolve(map)
        } else {
          promise.reject("TTS_GENERATE_ERROR", "Generated audio was empty. Check model path and espeak-ng-data (e.g. for PAD/filesystem models).")
        }
      } else {
        promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech. Native returned no result.")
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "generateTts error: ${e.message}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  fun generateTtsWithTimestamps(text: String, sid: Double, speed: Double, promise: Promise) {
    try {
      val result = native.nativeTtsGenerateWithTimestamps(text, sid.toInt(), speed.toFloat())
      if (result != null) {
        val map = Arguments.createMap()

        @Suppress("UNCHECKED_CAST")
        val samples = result["samples"] as? FloatArray
        val sampleRate = result["sampleRate"] as? Int
        val subtitles = result["subtitles"] as? ArrayList<*>
        val estimated = result["estimated"] as? Boolean ?: true

        if (samples != null && sampleRate != null) {
          val samplesArray = Arguments.createArray()
          for (sample in samples) {
            samplesArray.pushDouble(sample.toDouble())
          }

          val subtitlesArray = Arguments.createArray()
          subtitles?.forEach { item ->
            if (item is HashMap<*, *>) {
              val subtitleMap = Arguments.createMap()
              subtitleMap.putString("text", item["text"] as? String ?: "")
              subtitleMap.putDouble("start", (item["start"] as? Number)?.toDouble() ?: 0.0)
              subtitleMap.putDouble("end", (item["end"] as? Number)?.toDouble() ?: 0.0)
              subtitlesArray.pushMap(subtitleMap)
            }
          }

          map.putArray("samples", samplesArray)
          map.putInt("sampleRate", sampleRate)
          map.putArray("subtitles", subtitlesArray)
          map.putBoolean("estimated", estimated)
          promise.resolve(map)
        } else {
          promise.reject("TTS_GENERATE_ERROR", "Invalid result format from native code")
        }
      } else {
        promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech")
      }
    } catch (e: Exception) {
      promise.reject("TTS_GENERATE_ERROR", "Failed to generate speech", e)
    }
  }

  fun generateTtsStream(text: String, sid: Double, speed: Double, promise: Promise) {
    if (ttsStreamRunning.get()) {
      promise.reject("TTS_STREAM_ERROR", "TTS streaming already in progress")
      return
    }

    ttsStreamCancelled.set(false)
    ttsStreamRunning.set(true)

    ttsStreamThread = Thread {
      try {
        val success = native.nativeTtsGenerateStream(text, sid.toInt(), speed.toFloat())
        if (!success && !ttsStreamCancelled.get()) {
          emitError("TTS streaming generation failed")
        }
      } catch (e: Exception) {
        emitError("TTS streaming failed: ${e.message}")
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
    try {
      native.nativeTtsCancelStream()
      ttsStreamThread?.interrupt()
    } catch (e: Exception) {
      promise.reject("TTS_STREAM_ERROR", "Failed to cancel TTS stream", e)
      return
    }
    promise.resolve(null)
  }

  fun startTtsPcmPlayer(sampleRate: Double, channels: Double, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        promise.reject("TTS_PCM_ERROR", "PCM playback requires API 21+")
        return
      }

      if (channels.toInt() != 1) {
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

      val minBufferSize = AudioTrack.getMinBufferSize(
        sampleRate.toInt(),
        channelConfig,
        AudioFormat.ENCODING_PCM_FLOAT
      )

      if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
        promise.reject("TTS_PCM_ERROR", "Invalid buffer size for PCM player")
        return
      }

      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

      ttsPcmTrack = AudioTrack(
        attributes,
        audioFormat,
        minBufferSize,
        AudioTrack.MODE_STREAM,
        AudioManager.AUDIO_SESSION_ID_GENERATE
      )

      ttsPcmTrack?.play()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to start PCM player", e)
    }
  }

  fun writeTtsPcmChunk(samples: ReadableArray, promise: Promise) {
    val track = ttsPcmTrack
    if (track == null) {
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
        promise.reject("TTS_PCM_ERROR", "PCM write failed: $written")
        return
      }

      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to write PCM chunk", e)
    }
  }

  fun stopTtsPcmPlayer(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("TTS_PCM_ERROR", "Failed to stop PCM player", e)
    }
  }

  fun getTtsSampleRate(promise: Promise) {
    try {
      val sampleRate = native.nativeTtsGetSampleRate()
      promise.resolve(sampleRate.toDouble())
    } catch (e: Exception) {
      promise.reject("TTS_ERROR", "Failed to get sample rate", e)
    }
  }

  fun getTtsNumSpeakers(promise: Promise) {
    try {
      val numSpeakers = native.nativeTtsGetNumSpeakers()
      promise.resolve(numSpeakers.toDouble())
    } catch (e: Exception) {
      promise.reject("TTS_ERROR", "Failed to get number of speakers", e)
    }
  }

  fun unloadTts(promise: Promise) {
    try {
      stopPcmPlayerInternal()
      native.nativeTtsRelease()
      ttsInitState = null
      promise.resolve(null)
    } catch (e: Exception) {
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

      val success = native.nativeTtsSaveToWavFile(samplesArray, sampleRate.toInt(), filePath)
      if (success) {
        promise.resolve(filePath)
      } else {
        promise.reject("TTS_SAVE_ERROR", "Failed to save audio to file")
      }
    } catch (e: Exception) {
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
          } catch (e: Exception) {
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

  private fun stopPcmPlayerInternal() {
    ttsPcmTrack?.apply {
      try {
        stop()
      } catch (_: IllegalStateException) {
      }
      flush()
      release()
    }
    ttsPcmTrack = null
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
