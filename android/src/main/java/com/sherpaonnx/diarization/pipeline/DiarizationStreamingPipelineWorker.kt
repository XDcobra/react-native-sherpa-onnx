package com.sherpaonnx.diarization.pipeline

import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class DiarizationStreamingPipelineWorker(
  private val instanceId: String,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveSegmentEntry,
  private val chunkSize: Int,
  private val feedNative: (FloatArray) -> HashMap<String, Any>?,
  private val flushNative: () -> HashMap<String, Any>?,
  private val resetNative: () -> Unit,
  private val emitEvent: (type: String, payload: Map<String, Any?>) -> Unit,
) : StreamingPipelineWorker {
  override val pipelineId: String = UUID.randomUUID().toString()
  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "diarization-pipeline-$pipelineId").apply { isDaemon = true }
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
  @Volatile private var segmentCount = 0
  @Volatile private var error: String? = null

  private sealed class Cmd {
    class Flush(val done: CompletableFuture<Unit>) : Cmd()
    class Reset(val done: CompletableFuture<Unit>) : Cmd()
  }

  override fun start() {
    resetNative()
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
        )
      )
    } catch (e: Exception) {
      error = e.message ?: "Unknown diarization streaming pipeline error"
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
    chunksProcessed++
    unitsRead += chunk.size

    val result = feedNative(chunk)
    if (result != null) {
      val success = result["success"] as? Boolean ?: false
      if (!success) {
        val err = result["error"] as? String ?: "Inference failed"
        throw RuntimeException(err)
      }
      handleSegments(result)
    }
  }

  private fun flushInternal() {
    val result = flushNative()
    if (result != null) {
      val success = result["success"] as? Boolean ?: false
      if (!success) {
        val err = result["error"] as? String ?: "Flush failed"
        throw RuntimeException(err)
      }
      handleSegments(result)
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun handleSegments(result: HashMap<String, Any>) {
    val segments = result["segments"] as? ArrayList<HashMap<String, Any>> ?: return
    val sampleRate = inputEntry.sampleRate
    for (seg in segments) {
      val start = (seg["start"] as? Number)?.toDouble() ?: continue
      val end = (seg["end"] as? Number)?.toDouble() ?: continue
      val speaker = (seg["speaker"] as? Number)?.toInt() ?: 0

      val startSample = (start * sampleRate).toInt().coerceAtLeast(0)
      val endSample = (end * sampleRate).toInt().coerceAtLeast(startSample)
      val durationMs = if (sampleRate > 0) (((endSample - startSample) * 1000) / sampleRate) else 0

      outputEntry.appendSegment(
        kind = "diarization",
        sourceAudioBufferId = inputEntry.bufferId,
        startSample = startSample,
        endSample = endSample,
        sampleRate = sampleRate,
        durationMs = durationMs,
        confidence = null,
        payloadJson = """{"source":"diarization","speaker":$speaker}""",
      )
      segmentCount++
      unitsWritten++
    }
  }

  override fun flush(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    if (!isRunning) {
      future.complete(Unit)
      return future
    }
    queueDepth.incrementAndGet()
    pendingCommands.offer(Cmd.Flush(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    if (!isRunning) {
      future.complete(Unit)
      return future
    }
    queueDepth.incrementAndGet()
    pendingCommands.offer(Cmd.Reset(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun stop() {
    isRunning = false
    lock.withLock { dataAvailable.signal() }
  }

  override fun release() {
    stop()
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

  private fun processCommands() {
    while (true) {
      val cmd = pendingCommands.poll() ?: break
      queueDepth.decrementAndGet()
      when (cmd) {
        is Cmd.Flush -> {
          flushInternal()
          cmd.done.complete(Unit)
        }
        is Cmd.Reset -> {
          resetNative()
          cmd.done.complete(Unit)
        }
      }
    }
  }

  private fun drainCommands() {
    while (true) {
      val cmd = pendingCommands.poll() ?: break
      queueDepth.decrementAndGet()
      when (cmd) {
        is Cmd.Flush -> cmd.done.complete(Unit)
        is Cmd.Reset -> cmd.done.complete(Unit)
      }
    }
  }
}
