package com.sherpaonnx

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.round

/**
 * Native PCM capture from the microphone with optional resampling to a target sample rate.
 * Captures at a supported hardware rate (e.g. 44100 or 48000 Hz), then resamples to the
 * requested rate so the app always receives PCM at the same sample rate (e.g. 16000 for STT).
 */
class SherpaOnnxPcmCapture(
  private val targetSampleRate: Int,
  private val channelCount: Int,
  private val bufferSizeFrames: Int,
  private val onChunk: (base64Pcm: String, sampleRate: Int) -> Unit,
  private val onError: (message: String) -> Unit,
  private val logTag: String = "SherpaOnnxPcmCapture"
) {
  private var audioRecord: AudioRecord? = null
  @Volatile
  private var running = false
  private var captureThread: Thread? = null

  companion object {
    /** Supported capture sample rates to try in order (device-dependent). */
    private val CAPTURE_RATES = intArrayOf(16000, 44100, 48000)

    /**
     * Resample Int16 PCM from capture rate to target rate using linear interpolation.
     * Returns a new ByteArray of Int16 samples at target rate.
     */
    private fun resampleInt16(
      input: ShortArray,
      fromRate: Int,
      toRate: Int
    ): ShortArray {
      if (fromRate == toRate) return input
      val ratio = fromRate.toDouble() / toRate
      val outLength = round(input.size / ratio).toInt().coerceAtLeast(0)
      val result = ShortArray(outLength)
      for (i in 0 until outLength) {
        val srcIdx = i * ratio
        val idx0 = srcIdx.toInt().coerceIn(0, input.size - 1)
        val idx1 = (idx0 + 1).coerceAtMost(input.size - 1)
        val frac = (srcIdx - idx0).toFloat()
        val v0 = input[idx0].toInt()
        val v1 = input[idx1].toInt()
        result[i] = (v0 + (v1 - v0) * frac).toInt().toShort()
      }
      return result
    }
  }

  /**
   * Start capture. Uses a supported hardware rate and resamples to [targetSampleRate] before emitting.
   */
  fun start() {
    if (running) {
      Log.w(logTag, "start: already running")
      return
    }
    val bufferSizeBytes = if (bufferSizeFrames > 0) {
      bufferSizeFrames * 2 * channelCount // 2 bytes per sample, mono
    } else {
      (0.1 * targetSampleRate).toInt() * 2 * channelCount // 0.1 s default
    }
    val captureRate = CAPTURE_RATES.firstOrNull { rate ->
      val size = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      size != AudioRecord.ERROR && size != AudioRecord.ERROR_BAD_VALUE
    } ?: 44100
    val minBuf = AudioRecord.getMinBufferSize(captureRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val bufSize = minBuf.coerceAtLeast(bufferSizeBytes)
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        captureRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufSize
      )
    } catch (e: SecurityException) {
      Log.e(logTag, "start: RECORD_AUDIO permission not granted", e)
      onError("RECORD_AUDIO permission not granted")
      return
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      Log.e(logTag, "start: AudioRecord not initialized")
      onError("AudioRecord failed to initialize")
      record.release()
      return
    }
    audioRecord = record
    running = true
    captureThread = thread(name = "SherpaOnnxPcmCapture") {
      val shortBuf = ShortArray(bufSize / 2)
      try {
        record.startRecording()
        while (running && record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          val read = record.read(shortBuf, 0, shortBuf.size)
          if (read <= 0) continue
          val chunk = shortBuf.copyOf(read)
          val toEmit = if (captureRate != targetSampleRate) {
            resampleInt16(chunk, captureRate, targetSampleRate)
          } else {
            chunk
          }
          val byteBuf = ByteBuffer.allocate(toEmit.size * 2).order(ByteOrder.LITTLE_ENDIAN)
          for (s in toEmit) byteBuf.putShort(s)
          val base64 = Base64.encodeToString(byteBuf.array(), Base64.NO_WRAP)
          onChunk(base64, targetSampleRate)
        }
      } catch (e: Exception) {
        if (running) {
          Log.e(logTag, "Capture thread error", e)
          onError(e.message ?: "Capture error")
        }
      } finally {
        try {
          record.stop()
        } catch (_: Exception) { }
        record.release()
        audioRecord = null
      }
    }
  }

  /** Stop capture and release resources. */
  fun stop() {
    running = false
    captureThread?.join(2000)
    captureThread = null
    audioRecord = null
  }
}
