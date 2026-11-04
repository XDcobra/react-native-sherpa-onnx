package com.sherpaonnx.vad.pipeline

import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.vad.core.VadInstanceConfig
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Live VAD worker aligned with iOS: rebuffer to windowSize → AcceptWaveform →
 * IsSpeechDetected → PopSegments → Flush on end.
 */
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
  private val drainScratch = FloatArray(chunkSize)
  private val pendingCommands = LinkedBlockingQueue<Cmd>()
  private val cmdLock = Any()
  private val queueDepth = AtomicInteger(0)
  private val gateKey = config.gateKey()

  @Volatile private var chunksProcessed = 0L
  @Volatile private var unitsRead = 0L
  @Volatile private var unitsWritten = 0L
  @Volatile private var error: String? = null
  @Volatile private var speech = false

  private var speechDurationMs = 0L
  private var segmentCount = 0
  private val vadFrameSize = config.runtimeOptions.windowSize.coerceAtLeast(1)
  private var pendingVadSamples = FloatArray(0)

  private sealed class Cmd {
    class Flush(val done: CompletableFuture<Unit>) : Cmd()
    class Reset(val done: CompletableFuture<Unit>) : Cmd()
  }

  override fun start() {
    if (!NativeInstanceGate.beginUse(gateKey)) {
      throw IllegalStateException("VAD instance released: $instanceId")
    }
    try {
      config.runtime.reset()
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }
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
        val n = inputEntry.drainCursorInto(cursorId, drainScratch, 0, chunkSize)
        if (n <= 0) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            flushInternal()
            break
          }
          lock.withLock { dataAvailable.await(10, TimeUnit.MILLISECONDS) }
          continue
        }
        val chunk = if (n == drainScratch.size) drainScratch else drainScratch.copyOf(n)
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
      if (cursorId >= 0) inputEntry.releaseCursor(cursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      synchronized(cmdLock) {
        while (true) {
          val cmd = pendingCommands.poll() ?: break
          queueDepth.updateAndGet { (it - 1).coerceAtLeast(0) }
          when (cmd) {
            is Cmd.Flush -> cmd.done.complete(Unit)
            is Cmd.Reset -> cmd.done.complete(Unit)
          }
        }
        isRunning = false
      }
      executor.shutdown()
    }
  }

  private fun processChunk(chunk: FloatArray) {
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
    if (!NativeInstanceGate.beginUse(gateKey)) {
      throw IllegalStateException("VAD instance released: $instanceId")
    }
    try {
      config.runtime.acceptWaveform(frame)
      val detected = config.runtime.isSpeechDetected()
      if (detected != speech) {
        speech = detected
        emitEvent("vad.stateChanged", mapOf("isSpeechDetected" to speech))
      }
      appendDetectedSegments()
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }
  }

  private fun appendDetectedSegments() {
    val segments = config.runtime.popSegments()
    for (segment in segments) {
      val confidence = 1.0
      outputEntry.appendSegment(
        kind = "speech",
        sourceAudioBufferId = inputEntry.bufferId,
        startSample = segment.startSample,
        endSample = segment.endSample,
        sampleRate = config.sampleRate,
        durationMs = segment.durationMs,
        confidence = confidence,
        payloadJson = """{"source":"vad","engine":"vad","decision":"model","score":$confidence}""",
      )
      unitsWritten++
      segmentCount++
      speechDurationMs += segment.durationMs.toLong()
    }
  }

  private fun flushInternal() {
    if (!NativeInstanceGate.beginUse(gateKey)) return
    try {
      if (pendingVadSamples.isNotEmpty()) {
        val tail = FloatArray(vadFrameSize)
        pendingVadSamples.copyInto(tail, 0, 0, pendingVadSamples.size)
        config.runtime.acceptWaveform(tail)
        pendingVadSamples = FloatArray(0)
      }
      config.runtime.flush()
      appendDetectedSegments()
    } finally {
      NativeInstanceGate.endUse(gateKey)
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
          try {
            if (NativeInstanceGate.beginUse(gateKey)) {
              try {
                config.runtime.reset()
              } finally {
                NativeInstanceGate.endUse(gateKey)
              }
            }
            speech = false
            pendingVadSamples = FloatArray(0)
            cmd.done.complete(Unit)
          } catch (e: Exception) {
            cmd.done.completeExceptionally(e)
          }
        }
      }
    }
  }

  override fun stop() {
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    if (!executor.isShutdown) {
      executor.shutdown()
    }
    if (!executor.isTerminated) {
      if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
        executor.shutdownNow()
        executor.awaitTermination(2, TimeUnit.SECONDS)
      }
    }
  }

  override fun flush(): CompletableFuture<Unit> {
    val f = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        f.complete(Unit)
        return f
      }
      queueDepth.incrementAndGet()
      pendingCommands.put(Cmd.Flush(f))
    }
    lock.withLock { dataAvailable.signal() }
    return f
  }

  override fun reset(): CompletableFuture<Unit> {
    val f = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        f.complete(Unit)
        return f
      }
      queueDepth.incrementAndGet()
      pendingCommands.put(Cmd.Reset(f))
    }
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
