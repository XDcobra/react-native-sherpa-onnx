package com.sherpaonnx.vad.pipeline

import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.vad.core.VadDecision
import com.sherpaonnx.vad.core.VadInstanceConfig
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class VadPipelineWorker(
  private val instanceId: String,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveSegmentEntry,
  private val config: VadInstanceConfig,
  private val chunkSize: Int,
  private val emitEvent: (type: String, payload: Map<String, Any?>) -> Unit,
) : StreamingPipelineWorker {
  override val pipelineId: String = UUID.randomUUID().toString()
  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "vad-pipeline-$pipelineId").apply { isDaemon = true }
  }
  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null
  private var cursorId: Int = -1
  private val pendingCommands = LinkedBlockingQueue<Cmd>()
  private val queueDepth = AtomicInteger(0)

  @Volatile private var chunksProcessed = 0L
  @Volatile private var unitsRead = 0L
  @Volatile private var unitsWritten = 0L
  @Volatile private var error: String? = null
  @Volatile private var speech = false

  private var segStartSample = 0L
  private var speechSamples = 0L
  private var silenceSamples = 0L
  private var speechDurationMs = 0L
  private var segmentCount = 0
  private var absoluteSample = 0L
  private var speechScoreSum = 0.0
  private var speechScoreCount = 0
  private val vadFrameSize = config.runtimeOptions.windowSize.coerceAtLeast(1)
  private var pendingVadSamples = FloatArray(0)

  private sealed class Cmd {
    class Flush(val done: CompletableFuture<Unit>) : Cmd()
    class Reset(val done: CompletableFuture<Unit>) : Cmd()
  }

  override fun start() {
    config.runtime.reset()
    isRunning = true
    emitEvent("pipeline.started", emptyMap())
    cursorId = inputEntry.createCursorHandle()
    appendListener = { lock.withLock { dataAvailable.signal() } }
    inputEntry.addAppendListener(appendListener!!)
    executor.submit { runLoop() }
  }

  private fun runLoop() {
    try {
      while (isRunning) {
        processCommands()
        val chunk = inputEntry.drainCursor(cursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            flushInternal()
            break
          }
          lock.withLock { dataAvailable.await(10, TimeUnit.MILLISECONDS) }
          continue
        }
        processChunk(chunk)
      }
      emitEvent(
        "pipeline.completed",
        mapOf(
          "chunksProcessed" to chunksProcessed,
          "unitsRead" to unitsRead,
          "unitsWritten" to unitsWritten,
          "segmentCount" to segmentCount,
          "speechDurationMs" to speechDurationMs,
        )
      )
    } catch (e: Exception) {
      error = e.message ?: "Unknown VAD pipeline error"
      emitEvent("pipeline.error", mapOf("error" to error))
    } finally {
      isRunning = false
      if (cursorId >= 0) inputEntry.releaseCursor(cursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      drainCommands()
      executor.shutdown()
    }
  }

  private fun processChunk(chunk: FloatArray) {
    // VAD-only rule:
    // Unlike STT/TTS/enhancement, the Sherpa-ONNX VAD compute path is sensitive to
    // undersized input windows (seen as model pad/reflect runtime failures on mic jitter).
    // We therefore batch arbitrary live-buffer reads into fixed model-sized frames here.
    val merged = FloatArray(pendingVadSamples.size + chunk.size)
    pendingVadSamples.copyInto(merged, 0, 0, pendingVadSamples.size)
    chunk.copyInto(merged, pendingVadSamples.size, 0, chunk.size)
    var offset = 0
    while (offset + vadFrameSize <= merged.size) {
      val frame = merged.copyOfRange(offset, offset + vadFrameSize)
      processVadFrame(frame)
      offset += vadFrameSize
    }
    pendingVadSamples = if (offset < merged.size) {
      merged.copyOfRange(offset, merged.size)
    } else {
      FloatArray(0)
    }
    chunksProcessed++
    unitsRead += chunk.size
    emitEvent(
      "pipeline.progress",
      mapOf(
        "chunksProcessed" to chunksProcessed,
        "unitsRead" to unitsRead,
        "unitsWritten" to unitsWritten,
        "queueDepth" to queueDepth.get(),
      )
    )
  }

  private fun processVadFrame(frame: FloatArray) {
    val decision = config.runtime.infer(frame, config.sampleRate)
    val detected = decision.isSpeech
    if (detected != speech) {
      speech = detected
      emitEvent("vad.stateChanged", mapOf("isSpeechDetected" to speech))
    }
    if (detected) {
      if (speechSamples == 0L) {
        segStartSample = absoluteSample
      }
      speechSamples += frame.size.toLong()
      silenceSamples = 0L
      if (decision.score != null) {
        speechScoreSum += decision.score
        speechScoreCount += 1
      }
    } else if (speechSamples > 0L) {
      silenceSamples += frame.size.toLong()
      val silenceMs = samplesToMs(silenceSamples)
      if (silenceMs >= config.runtimeOptions.minSilenceDurationMs.toLong()) {
        appendSegment()
        speechSamples = 0L
        silenceSamples = 0L
      }
    }
    absoluteSample += frame.size.toLong()
  }

  private fun appendSegment() {
    val speechMs = samplesToMs(speechSamples)
    if (speechMs < config.runtimeOptions.minSpeechDurationMs.toLong()) return
    val end = segStartSample + speechSamples
    val confidence = if (speechScoreCount > 0) {
      speechScoreSum / speechScoreCount.toDouble()
    } else {
      1.0
    }
    val out = outputEntry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = inputEntry.bufferId,
      startSample = segStartSample.toInt(),
      endSample = end.toInt(),
      sampleRate = config.sampleRate,
      durationMs = speechMs.toInt(),
      confidence = confidence,
      payloadJson = """{"engine":"vad","decision":"model","score":$confidence}""",
    )
    speechScoreSum = 0.0
    speechScoreCount = 0
    unitsWritten++
    segmentCount++
    speechDurationMs += speechMs
  }

  private fun flushInternal() {
    if (pendingVadSamples.isNotEmpty()) {
      val tail = FloatArray(vadFrameSize)
      pendingVadSamples.copyInto(tail, 0, 0, pendingVadSamples.size)
      processVadFrame(tail)
      pendingVadSamples = FloatArray(0)
    }
    if (speechSamples > 0L) {
      appendSegment()
      speechSamples = 0L
      silenceSamples = 0L
    }
    emitEvent("pipeline.flushed", emptyMap())
  }

  private fun processCommands() {
    while (true) {
      val cmd = pendingCommands.poll() ?: return
      queueDepth.decrementAndGet()
      when (cmd) {
        is Cmd.Flush -> {
          try {
            flushInternal()
            cmd.done.complete(Unit)
          } catch (e: Exception) {
            cmd.done.completeExceptionally(e)
          }
        }
        is Cmd.Reset -> {
          config.runtime.reset()
          speech = false
          speechSamples = 0L
          silenceSamples = 0L
          segStartSample = absoluteSample
          speechScoreSum = 0.0
          speechScoreCount = 0
          cmd.done.complete(Unit)
        }
      }
    }
  }

  private fun drainCommands() {
    while (true) {
      val cmd = pendingCommands.poll() ?: return
      when (cmd) {
        is Cmd.Flush -> cmd.done.completeExceptionally(
          IllegalStateException("Pipeline stopped before flush completed")
        )
        is Cmd.Reset -> cmd.done.completeExceptionally(
          IllegalStateException("Pipeline stopped before reset completed")
        )
      }
    }
  }

  private fun samplesToMs(samples: Long): Long {
    if (config.sampleRate <= 0) return 0L
    return (samples * 1000L) / config.sampleRate.toLong()
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
    val f = CompletableFuture<Unit>()
    queueDepth.incrementAndGet()
    pendingCommands.put(Cmd.Flush(f))
    lock.withLock { dataAvailable.signal() }
    return f
  }

  override fun reset(): CompletableFuture<Unit> {
    if (!isRunning) {
      return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalStateException("Pipeline is not running"))
      }
    }
    val f = CompletableFuture<Unit>()
    queueDepth.incrementAndGet()
    pendingCommands.put(Cmd.Reset(f))
    lock.withLock { dataAvailable.signal() }
    return f
  }

  override fun getStatus(): StreamingPipelineStatus {
    return StreamingPipelineStatus(
      isRunning = isRunning,
      chunksProcessed = chunksProcessed,
      unitsRead = unitsRead,
      unitsWritten = unitsWritten,
      error = error,
    )
  }

  override fun release() {
    stop()
  }

  fun isSpeechDetectedNow(): Boolean = speech
  fun queueDepthNow(): Int = queueDepth.get()
}
