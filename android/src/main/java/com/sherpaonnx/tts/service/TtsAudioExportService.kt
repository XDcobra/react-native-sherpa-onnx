package com.sherpaonnx.tts.service

import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.sherpaonnx.SherpaOnnxContentUriUtils
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * FFmpeg-backed and WAV save paths for TTS audio export.
 */
internal class TtsAudioExportService(
  private val context: ReactApplicationContext,
  /** FFmpeg: mono f32le raw file → encoded output path. Returns empty string on success. */
  private val encodeMonoFromRawFile: (rawPath: String, pcmSampleRate: Int, outputPath: String, format: String, outputSampleRateHz: Int) -> String
) {
  fun saveTtsAudio(
    samples: ReadableArray,
    sampleRate: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) {
    try {
      val fmt = format.trim().lowercase().ifEmpty { "wav" }
      val outHz = outputSampleRateHz.toInt()
      val rateErr = validateTtsEncodeOutputSampleRate(fmt, outHz)
      if (rateErr != null) {
        promise.reject("TTS_SAVE_ERROR", rateErr)
        return
      }

      when (destinationType) {
        "file" -> {
          if (fmt == "wav" || fmt == "wav16k") {
            saveTtsAudioToFile(samples, sampleRate, pathOrDirectoryUri, promise)
            return
          }
          encodeToFileThenResolve(samples, sampleRate, pathOrDirectoryUri, fmt, outHz, promise)
        }
        "androidContent" -> {
          if (filename.isBlank()) {
            promise.reject("TTS_SAVE_ERROR", "filename is required for androidContent destination")
            return
          }
          if (fmt == "wav" || fmt == "wav16k") {
            saveTtsAudioToContentUri(samples, sampleRate, pathOrDirectoryUri, filename, promise)
            return
          }
          val ext = fileExtensionForFormat(fmt)
          val cacheOut = File(context.cacheDir, "tts_save_${System.nanoTime()}.$ext")
          encodeToFileThenCopyToContentUri(
            samples,
            sampleRate,
            cacheOut.absolutePath,
            fmt,
            outHz,
            pathOrDirectoryUri,
            filename,
            mimeTypeForTtsFormat(fmt),
            promise
          )
        }
        else -> promise.reject("TTS_SAVE_ERROR", "Invalid destinationType: use 'file' or 'androidContent'")
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: saveTtsAudio failed", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save TTS audio: ${e.message}", e)
    }
  }

  private fun validateTtsEncodeOutputSampleRate(format: String, rate: Int): String? {
    if (rate < 0) return "Invalid outputSampleRateHz: must be >= 0"
    if (format == "mp3") {
      val allowed = setOf(0, 32000, 44100, 48000)
      if (!allowed.contains(rate)) {
        return "MP3 output sample rate must be one of 32000, 44100, 48000, or 0 (default). Received: $rate"
      }
    } else if (format == "opus" || format == "oggm" || format == "webm" || format == "mkv" || format == "ogg") {
      val allowed = setOf(0, 8000, 12000, 16000, 24000, 48000)
      if (!allowed.contains(rate)) {
        return "Opus output sample rate must be 8000, 12000, 16000, 24000, 48000, or 0 (default). Received: $rate"
      }
    }
    return null
  }

  private fun fileExtensionForFormat(format: String): String = when (format) {
    "mp3" -> "mp3"
    "flac" -> "flac"
    "m4a", "aac" -> "m4a"
    "opus" -> "opus"
    "ogg", "oggm" -> "ogg"
    "webm" -> "webm"
    "mkv" -> "mkv"
    else -> "bin"
  }

  private fun mimeTypeForTtsFormat(format: String): String = when (format) {
    "mp3" -> "audio/mpeg"
    "flac" -> "audio/flac"
    "m4a", "aac" -> "audio/mp4"
    "opus", "ogg", "oggm" -> "audio/ogg"
    "webm" -> "audio/webm"
    "wav", "wav16k" -> "audio/wav"
    else -> "application/octet-stream"
  }

  private fun readableArrayToFloatArray(samples: ReadableArray): FloatArray {
    val n = samples.size()
    val out = FloatArray(n)
    for (i in 0 until n) {
      out[i] = samples.getDouble(i).toFloat()
    }
    return out
  }

  private fun writeMonoF32LeRawFile(floats: FloatArray, file: File) {
    val bb = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
    FileOutputStream(file).use { o ->
      for (f in floats) {
        bb.clear()
        bb.putFloat(f)
        o.write(bb.array())
      }
    }
  }

  private fun encodeToFileThenResolve(
    samples: ReadableArray,
    sampleRate: Double,
    outputPath: String,
    format: String,
    outputSampleRateHz: Int,
    promise: Promise
  ) {
    val floats = readableArrayToFloatArray(samples)
    val raw = File(context.cacheDir, "tts_pcm_${System.nanoTime()}.raw")
    try {
      writeMonoF32LeRawFile(floats, raw)
      val err = encodeMonoFromRawFile(raw.absolutePath, sampleRate.toInt(), outputPath, format, outputSampleRateHz)
      if (err.isNotEmpty()) {
        promise.reject("TTS_SAVE_ERROR", err)
        return
      }
      promise.resolve(outputPath)
    } finally {
      raw.delete()
    }
  }

  private fun encodeToFileThenCopyToContentUri(
    samples: ReadableArray,
    sampleRate: Double,
    cacheOutputPath: String,
    format: String,
    outputSampleRateHz: Int,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    val floats = readableArrayToFloatArray(samples)
    val raw = File(context.cacheDir, "tts_pcm_${System.nanoTime()}.raw")
    val cacheFile = File(cacheOutputPath)
    try {
      writeMonoF32LeRawFile(floats, raw)
      val err = encodeMonoFromRawFile(raw.absolutePath, sampleRate.toInt(), cacheOutputPath, format, outputSampleRateHz)
      if (err.isNotEmpty()) {
        promise.reject("TTS_SAVE_ERROR", err)
        return
      }
      if (!cacheFile.isFile || !cacheFile.canRead()) {
        promise.reject("TTS_SAVE_ERROR", "Encoded file missing: $cacheOutputPath")
        return
      }
      val resolver = context.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = SherpaOnnxContentUriUtils.createDocumentInDirectory(resolver, dirUri, filename, mimeType)
      FileInputStream(cacheFile).use { inputStream ->
        resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
          inputStream.copyTo(outputStream)
          outputStream.flush()
        } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      }
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: encode+SAF copy failed", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save encoded audio to content URI: ${e.message}", e)
    } finally {
      raw.delete()
      cacheFile.delete()
    }
  }

  private fun saveTtsAudioToFile(
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

  private fun saveTtsAudioToContentUri(
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
      val fileUri = SherpaOnnxContentUriUtils.createDocumentInDirectory(resolver, dirUri, filename, "audio/wav")
      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        writeWavToStream(samplesArray, sampleRate.toInt(), outputStream)
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_SAVE_ERROR: Failed to save audio to content URI", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save audio to content URI", e)
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
}
