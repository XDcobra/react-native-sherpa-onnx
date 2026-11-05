package com.sherpaonnx.audio.pipeline

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import com.sherpaonnx.audio.session.PaAudioSessionCoordinator
import kotlin.concurrent.thread

/**
 * Native mic → live ring (no JS roundtrip). Prod AudioRecord = VOICE_RECOGNITION classic.
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (D-A4).
 */
class MicToLiveBufferSink(
  private val context: Context,
  private val liveEntry: LiveEntry,
  private val onError: ((String) -> Unit)? = null,
  private val logTag: String = "MicToLiveBufferSink"
) {
  companion object {
    // Prefer 16 kHz first so capture often matches live SR (skip resample).
    // Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #6).
    private val CAPTURE_RATES = intArrayOf(16000, 44100, 48000)
  }

  @Volatile
  private var running = false
  private var audioRecord: AudioRecord? = null
  private var captureThread: Thread? = null
  @Volatile
  private var lastRoutedInputDeviceId: Int = -1

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
      // Prod source (D-A4): VOICE_RECOGNITION; PERF_MODE_LOW_LATENCY skipped (no win).
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

    // Register mic intent with coordinator and apply preferred device
    PaAudioSessionCoordinator.acquireIntent(
      PaAudioSessionCoordinator.Intent(ownerId = "mic", needsInput = true, needsOutput = false)
    )
    PaAudioSessionCoordinator.applyPreferredDevice(record)

    audioRecord = record
    running = true

    captureThread = thread(name = "MicToLiveBuffer-${liveEntry.bufferId}") {
      val shortBuf = ShortArray(bufSize / 2)
      try {
        record.startRecording()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          lastRoutedInputDeviceId = record.routedDevice?.id ?: -1
        }
        while (running && liveEntry.state == LiveEntry.State.RECORDING &&
               record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          val read = record.read(shortBuf, 0, shortBuf.size)
          if (read <= 0) continue

          // Keep Int16 until C (÷32768 in pa_append_int16); resample in Int16 if needed.
          val int16Samples =
            if (captureRate != targetRate) {
              Resampler.resampleInt16(shortBuf.copyOf(read), captureRate, targetRate)
            } else if (read == shortBuf.size) {
              shortBuf
            } else {
              shortBuf.copyOf(read)
            }

          when (
            liveEntry.tryAppendInt16Samples(
              int16Samples,
              targetRate,
              LiveAppendOrigin.Ingress(LiveAudioIngressSource.MIC),
            )
          ) {
            LiveEntry.AppendResult.APPENDED -> Unit
            LiveEntry.AppendResult.BUFFER_FINALIZED -> {
              running = false
              break
            }
          }
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
        lastRoutedInputDeviceId = -1
      }
    }
  }

  fun stop() {
    running = false
    val record = audioRecord
    if (record != null) {
      try { record.stop() } catch (_: Exception) {}
      PaAudioSessionCoordinator.unregisterRecord(record)
    }
    captureThread?.join(2000)
    captureThread = null
    audioRecord = null
    lastRoutedInputDeviceId = -1
    liveEntry.flushFramesAppendedEvents()
    PaAudioSessionCoordinator.releaseIntent("mic")
  }

  fun currentRoutedDeviceId(): Int? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    val routed = audioRecord?.routedDevice?.id
    if (routed != null) return routed
    return if (lastRoutedInputDeviceId >= 0) lastRoutedInputDeviceId else null
  }

  val isRunning: Boolean get() = running
}
