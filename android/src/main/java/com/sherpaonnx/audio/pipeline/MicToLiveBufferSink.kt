package com.sherpaonnx.audio.pipeline

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/**
 * Native microphone capture that writes directly into a LiveEntry's ring buffer.
 *
 * This avoids the JS roundtrip: Mic → Int16 → resample → Float32 → LiveEntry.appendSamples().
 * The existing SherpaOnnxPcmCapture emits base64-encoded chunks to JS; this class instead
 * pushes samples directly into a native LiveEntry for pipeline consumption.
 *
 * Optional JS event emission can be enabled via [onChunkForJs] for UI feedback (e.g. waveform).
 */
class MicToLiveBufferSink(
  private val liveEntry: LiveEntry,
  private val onChunkForJs: ((FloatArray, Int) -> Unit)? = null,
  private val onError: ((String) -> Unit)? = null,
  private val logTag: String = "MicToLiveBufferSink"
) {
  companion object {
    private val CAPTURE_RATES = intArrayOf(16000, 44100, 48000)
  }

  @Volatile
  private var running = false
  private var audioRecord: AudioRecord? = null
  private var captureThread: Thread? = null

  fun start() {
    if (running) {
      Log.w(logTag, "start: already running")
      return
    }

    val targetRate = liveEntry.sampleRate
    val bufferSizeBytes = (0.1 * targetRate).toInt() * 2 // 100ms of 16-bit mono

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
      Log.e(logTag, "RECORD_AUDIO permission not granted", e)
      onError?.invoke("RECORD_AUDIO permission not granted")
      return
    }

    if (record.state != AudioRecord.STATE_INITIALIZED) {
      Log.e(logTag, "AudioRecord not initialized")
      onError?.invoke("AudioRecord failed to initialize")
      record.release()
      return
    }

    audioRecord = record
    running = true

    captureThread = thread(name = "MicToLiveBuffer-${liveEntry.bufferId}") {
      val shortBuf = ShortArray(bufSize / 2)
      try {
        record.startRecording()
        while (running && liveEntry.state == LiveEntry.State.RECORDING &&
               record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          val read = record.read(shortBuf, 0, shortBuf.size)
          if (read <= 0) continue

          // Convert Int16 to Float32, resample if needed
          val rawSamples = if (captureRate != targetRate) {
            val resampled = Resampler.resampleInt16(shortBuf.copyOf(read), captureRate, targetRate)
            FloatArray(resampled.size) { resampled[it].toFloat() / 32768.0f }
          } else {
            FloatArray(read) { shortBuf[it].toFloat() / 32768.0f }
          }

          // Write directly to the live entry's ring buffer (no JS roundtrip)
          liveEntry.appendSamples(rawSamples, targetRate)

          // Optional JS callback for UI
          onChunkForJs?.invoke(rawSamples, targetRate)
        }
      } catch (e: Exception) {
        if (running) {
          Log.e(logTag, "Capture thread error", e)
          onError?.invoke(e.message ?: "Capture error")
        }
      } finally {
        try { record.stop() } catch (_: Exception) {}
        record.release()
        audioRecord = null
      }
    }
  }

  fun stop() {
    running = false
    val record = audioRecord
    if (record != null) {
      try { record.stop() } catch (_: Exception) {}
    }
    captureThread?.join(2000)
    captureThread = null
    audioRecord = null
  }

  val isRunning: Boolean get() = running
}
