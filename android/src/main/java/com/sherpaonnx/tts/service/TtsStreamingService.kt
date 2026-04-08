package com.sherpaonnx.tts.service

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.sherpaonnx.tts.config.TtsGenerationOptionsParser
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.TtsJniCallbackFactory
import com.sherpaonnx.tts.core.dispatchSampleRate
import com.sherpaonnx.tts.sink.TtsStreamingWavSink

/**
 * Buffer that coalesces many small native PCM chunks into fewer, larger emits.
 * Flushes when accumulated frames >= [maxFrames] or when the first buffered
 * frame has been waiting longer than [maxLatencyMs].
 */
private class ChunkCoalescer(
  private val maxFrames: Int,
  private val maxLatencyMs: Long,
  private val onFlush: (FloatArray) -> Unit
) {
  private val parts = mutableListOf<FloatArray>()
  private var totalFrames = 0
  private var firstBufferedNs = 0L

  fun add(chunk: FloatArray) {
    if (totalFrames == 0) firstBufferedNs = System.nanoTime()
    parts.add(chunk)
    totalFrames += chunk.size
    if (totalFrames >= maxFrames ||
        (System.nanoTime() - firstBufferedNs) / 1_000_000 >= maxLatencyMs) {
      flush()
    }
  }

  fun flush() {
    if (totalFrames == 0) return
    val merged = FloatArray(totalFrames)
    var offset = 0
    for (p in parts) {
      p.copyInto(merged, offset)
      offset += p.size
    }
    parts.clear()
    totalFrames = 0
    firstBufferedNs = 0L
    onFlush(merged)
  }
}

internal class TtsStreamingService(
  private val repository: TtsEngineRepository,
  private val emitChunk: (String, String, FloatArray, Int, Float, Boolean) -> Unit,
  private val emitError: (String, String, String) -> Unit,
  private val emitEnd: (String, String, Boolean) -> Unit,
  private val emitFileError: (String, String, String, String?) -> Unit,
  private val emitFileEnd: (String, String, Boolean, String, Long, Int) -> Unit
) {
  private companion object {
    /** Flush coalescing buffer when accumulated samples reach this count. */
    const val MAX_FRAMES_PER_CHUNK = 16384
    /** Flush coalescing buffer when first buffered sample is older than this (ms). */
    const val MAX_CHUNK_LATENCY_MS = 500L
  }

  fun generateTtsStreamToFile(
    instanceId: String,
    requestId: String,
    text: String,
    options: ReadableMap?,
    fileOptions: ReadableMap?,
    promise: Promise
  ) {
    val outputPath = fileOptions?.getMap("output")?.getString("path")?.trim().orEmpty()
    if (outputPath.isEmpty()) {
      promise.reject("TTS_STREAM_FILE_ERROR", "fileOptions.output.path is required")
      return
    }
    val format = fileOptions?.getString("format")?.trim()?.lowercase().orEmpty().ifEmpty { "wav" }
    if (format != "wav") {
      promise.reject("TTS_STREAM_FILE_ERROR", "Unsupported stream-to-file format: $format (v1 supports wav)")
      return
    }
    val keepPartial = if (fileOptions?.hasKey("keepPartialOnCancel") == true) {
      fileOptions.getBoolean("keepPartialOnCancel")
    } else {
      false
    }
    val emitChunks = if (fileOptions?.hasKey("emitChunks") == true) {
      fileOptions.getBoolean("emitChunks")
    } else {
      false
    }

    val inst = repository[instanceId] ?: run {
      promise.reject("TTS_STREAM_FILE_ERROR", "TTS instance not found: $instanceId")
      return
    }
    if (inst.ttsStreamRunning.get()) {
      promise.reject("TTS_STREAM_FILE_ERROR", "TTS streaming already in progress")
      return
    }
    if (!inst.hasEngine()) {
      promise.reject("TTS_STREAM_FILE_ERROR", "TTS not initialized")
      return
    }

    val sid = TtsGenerationOptionsParser.getSid(options)
    val speed = TtsGenerationOptionsParser.getSpeed(options)
    val sampleRate = inst.dispatchSampleRate()
    inst.ttsStreamCancelled.set(false)
    inst.ttsStreamRunning.set(true)
    inst.ttsStreamThread = Thread {
      var sink: TtsStreamingWavSink? = null
      val coalescer = if (emitChunks) ChunkCoalescer(MAX_FRAMES_PER_CHUNK, MAX_CHUNK_LATENCY_MS) { merged ->
        emitChunk(instanceId, requestId, merged, sampleRate, 0f, false)
      } else null
      try {
        sink = TtsStreamingWavSink(outputPath, sampleRate)
        inst.tts!!.generateWithCallback(
          text,
          sid,
          speed,
          TtsJniCallbackFactory.ttsStreamChunkCallbackForJni(inst.ttsStreamCancelled) { chunk ->
            sink.writeChunk(chunk)
            coalescer?.add(chunk)
          }
        )

        val cancelled = inst.ttsStreamCancelled.get()
        if (cancelled && !keepPartial) {
          sink.abort(true)
          emitFileEnd(instanceId, requestId, true, outputPath, 0L, sampleRate)
        } else {
          val bytesWritten = sink.finalizeFile()
          if (emitChunks && !cancelled) {
            coalescer?.flush()
            emitChunk(instanceId, requestId, FloatArray(0), sampleRate, 1f, true)
          }
          emitFileEnd(instanceId, requestId, cancelled, outputPath, bytesWritten, sampleRate)
        }
      } catch (e: Exception) {
        sink?.abort(!keepPartial)
        emitFileError(instanceId, requestId, "TTS stream-to-file failed: ${e.message}", outputPath)
      } finally {
        emitEnd(instanceId, requestId, inst.ttsStreamCancelled.get())
        inst.ttsStreamRunning.set(false)
      }
    }
    inst.ttsStreamThread?.start()
    promise.resolve(null)
  }

  fun generateTtsStream(instanceId: String, requestId: String, text: String, options: ReadableMap?, promise: Promise) {
    val inst = repository[instanceId] ?: run {
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
    if (inst.isPocket && !TtsGenerationOptionsParser.hasReferenceAudio(options)) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: Pocket TTS requires reference audio for voice cloning")
      promise.reject(
        "TTS_STREAM_ERROR",
        "Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options."
      )
      return
    }
    if (TtsGenerationOptionsParser.hasReferenceAudio(options) && inst.isZipvoice) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: Streaming with reference audio not supported for Zipvoice")
      promise.reject("TTS_STREAM_ERROR", "Streaming with reference audio not supported for Zipvoice")
      return
    }
    if (TtsGenerationOptionsParser.hasReferenceAudio(options) && !inst.isPocket) {
      Log.e("SherpaOnnxTts", "TTS_STREAM_ERROR: Reference audio streaming is only supported for Pocket TTS")
      promise.reject(
        "TTS_STREAM_ERROR",
        "Reference audio streaming is only supported for Pocket TTS."
      )
      return
    }
    val sid = TtsGenerationOptionsParser.getSid(options)
    val speed = TtsGenerationOptionsParser.getSpeed(options)
    inst.ttsStreamCancelled.set(false)
    inst.ttsStreamRunning.set(true)
    inst.ttsStreamThread = Thread {
      try {
        val sampleRate = inst.dispatchSampleRate()
        val coalescer = ChunkCoalescer(MAX_FRAMES_PER_CHUNK, MAX_CHUNK_LATENCY_MS) { merged ->
          emitChunk(instanceId, requestId, merged, sampleRate, 0f, false)
        }
        when {
          TtsGenerationOptionsParser.hasReferenceAudio(options) && inst.isPocket -> {
            val config = TtsGenerationOptionsParser.parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
            inst.tts!!.generateWithConfigAndCallback(
              text,
              config,
              TtsJniCallbackFactory.ttsStreamChunkCallbackForJni(inst.ttsStreamCancelled) { chunk ->
                coalescer.add(chunk)
              }
            )
          }
          else -> {
            inst.tts!!.generateWithCallback(
              text,
              sid,
              speed,
              TtsJniCallbackFactory.ttsStreamChunkCallbackForJni(inst.ttsStreamCancelled) { chunk ->
                coalescer.add(chunk)
              }
            )
          }
        }
        if (!inst.ttsStreamCancelled.get()) {
          coalescer.flush()
          emitChunk(instanceId, requestId, FloatArray(0), sampleRate, 1f, true)
        }
      } catch (e: Exception) {
        if (!inst.ttsStreamCancelled.get()) {
          emitError(instanceId, requestId, "TTS streaming failed: ${e.message}")
        }
      } finally {
        emitEnd(instanceId, requestId, inst.ttsStreamCancelled.get())
        inst.ttsStreamRunning.set(false)
      }
    }
    inst.ttsStreamThread?.start()
    promise.resolve(null)
  }

  fun cancelTtsStream(instanceId: String, promise: Promise) {
    val inst = repository[instanceId]
    if (inst != null) {
      inst.ttsStreamCancelled.set(true)
      inst.ttsStreamThread?.interrupt()
    }
    promise.resolve(null)
  }
}
