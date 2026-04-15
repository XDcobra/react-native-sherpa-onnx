package com.sherpaonnx.tts.pipeline

import com.k2fsa.sherpa.onnx.GenerationConfig
import com.sherpaonnx.audio.pipeline.LIVE_APPEND_SOURCE_TTS
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.tts.core.TtsEngineInstance
import com.sherpaonnx.tts.core.TtsJniCallbackFactory
import com.sherpaonnx.tts.core.dispatchSampleRate
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Voice cloning configuration resolved once at pipeline start.
 * Reference audio samples are loaded from an OfflineAudioBuffer into memory.
 */
data class TtsVoiceCloneConfig(
  val referenceAudio: FloatArray,
  val referenceSampleRate: Int,
  val referenceText: String = "",
  val silenceScale: Float = 0.2f,
  val numSteps: Int = 5,
)

/**
 * TTS pipeline worker: reads committed text segments from a LiveTextBuffer
 * and writes synthesized PCM audio to a LiveAudioBuffer.
 *
 * Follows the same pattern as SttPipelineWorker (dedicated thread + CV + command queue).
 * Processing unit: one text segment per iteration.
 */
internal class TtsPipelineWorker(
  override val pipelineId: String,
  private val ttsInstance: TtsEngineInstance,
  private val inputEntry: LiveTextEntry,
  private val outputEntry: LiveEntry,
  private val defaultSid: Int = 0,
  private val defaultSpeed: Float = 1.0f,
  private val voiceClone: TtsVoiceCloneConfig? = null,
) : StreamingPipelineWorker {

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "tts-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile private var chunksProcessed = 0L
  @Volatile private var unitsRead = 0L
  @Volatile private var unitsWritten = 0L
  @Volatile private var error: String? = null

  private var textCursorId: Int = -1
  private var appendListenerToken: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    textCursorId = inputEntry.createSegmentCursor()

    appendListenerToken = inputEntry.addAppendListener {
      lock.withLock { dataAvailable.signal() }
    }

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val sampleRate = ttsInstance.dispatchSampleRate()
    try {
      while (isRunning) {
        processCommands()

        val segments = inputEntry.drainSegments(textCursorId, 1)
        if (segments.isEmpty()) {
          if (inputEntry.state == LiveTextEntry.State.FINISHED) {
            break
          }
          lock.withLock {
            dataAvailable.await(50, TimeUnit.MILLISECONDS)
          }
          continue
        }

        val segment = segments[0]
        if (segment.text.isBlank()) continue

        synthesizeSegment(segment.text, segment.meta, sampleRate)
        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in TTS pipeline"
    } finally {
      isRunning = false
      inputEntry.releaseSegmentCursor(textCursorId)
      inputEntry.removeAppendListener(appendListenerToken)
      drainRemainingCommands()
      executor.shutdown()
    }
  }

  private fun synthesizeSegment(
    text: String,
    meta: Map<String, Any?>?,
    sampleRate: Int,
  ) {
    unitsRead += text.length

    val effectiveSid = (meta?.get("sid") as? Number)?.toInt() ?: defaultSid
    val effectiveSpeed = (meta?.get("speed") as? Number)?.toFloat() ?: defaultSpeed

    val cancelled = AtomicBoolean(false)
    val chunkCallback = TtsJniCallbackFactory.ttsStreamChunkCallbackForJni(cancelled) { samples ->
      if (!isRunning) {
        cancelled.set(true)
        return@ttsStreamChunkCallbackForJni
      }
      outputEntry.appendSamples(samples, sampleRate, LIVE_APPEND_SOURCE_TTS)
      unitsWritten += samples.size
    }

    val tts = ttsInstance.tts ?: return

    if (voiceClone != null) {
      val extra = mutableMapOf<String, String>()
      val rawExtra = meta?.get("extra") as? Map<*, *>
      if (rawExtra != null) {
        for ((key, value) in rawExtra) {
          val stringKey = key as? String ?: continue
          if (value != null) {
            extra[stringKey] = value.toString()
          }
        }
      }
      val config = GenerationConfig(
        sid = effectiveSid,
        speed = effectiveSpeed,
        referenceAudio = voiceClone.referenceAudio,
        referenceSampleRate = voiceClone.referenceSampleRate,
        referenceText = voiceClone.referenceText,
        silenceScale = voiceClone.silenceScale,
        numSteps = voiceClone.numSteps,
        extra = extra,
      )
      tts.generateWithConfigAndCallback(text, config, chunkCallback)
    } else {
      tts.generateWithCallback(text, effectiveSid, effectiveSpeed, chunkCallback)
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            val sampleRate = ttsInstance.dispatchSampleRate()
            while (true) {
              val remaining = inputEntry.drainSegments(textCursorId, 1)
              if (remaining.isEmpty()) break
              val seg = remaining[0]
              if (seg.text.isBlank()) continue
              synthesizeSegment(seg.text, seg.meta, sampleRate)
              chunksProcessed++
            }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            while (inputEntry.drainSegments(textCursorId, 100).isNotEmpty()) { /* skip */ }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  private fun drainRemainingCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> cmd.completion.completeExceptionally(
          IllegalStateException("Pipeline stopped before flush could complete")
        )
        is PipelineCommand.Reset -> cmd.completion.completeExceptionally(
          IllegalStateException("Pipeline stopped before reset could complete")
        )
      }
    }
  }

  override fun stop() {
    if (!isRunning) return
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    executor.shutdown()
    if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
      executor.shutdownNow()
    }
  }

  override fun flush(): CompletableFuture<Unit> {
    if (!isRunning) {
      return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalStateException("Pipeline is not running"))
      }
    }
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Flush(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    if (!isRunning) {
      return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalStateException("Pipeline is not running"))
      }
    }
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Reset(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun getStatus() = StreamingPipelineStatus(
    isRunning = isRunning,
    chunksProcessed = chunksProcessed,
    unitsRead = unitsRead,
    unitsWritten = unitsWritten,
    error = error,
  )

  override fun release() {
    stop()
  }
}
