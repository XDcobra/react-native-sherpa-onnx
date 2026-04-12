package com.sherpaonnx.audio.pipeline

import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class EnhancementPipelineWorker(
  private val denoiser: OnlineSpeechDenoiser,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveEntry,
) : StreamingPipelineWorker {

  override val pipelineId: String = UUID.randomUUID().toString()

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "enhancement-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile
  private var chunksProcessed = 0L
  @Volatile
  private var samplesRead = 0L
  @Volatile
  private var samplesWritten = 0L
  @Volatile
  private var error: String? = null
  private var cursorId: Int = -1

  // Condition variable: zero-latency wakeup when input has data
  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  // Command queue for blocking flush/reset
  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    cursorId = inputEntry.createCursorHandle()

    appendListener = { _ ->
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val chunkSize = denoiser.frameShiftInSamples
    val sr = denoiser.sampleRate
    try {
      while (isRunning) {
        // 1. Process pending commands (flush/reset)
        processCommands()

        // 2. Drain input
        val chunk = inputEntry.drainCursor(cursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            // Input stream ended → auto-flush and stop
            val flushed = denoiser.flush()
            if (flushed.samples.isNotEmpty()) {
              outputEntry.appendSamples(flushed.samples, sr, LIVE_APPEND_SOURCE_ENHANCEMENT)
              samplesWritten += flushed.samples.size
            }
            break
          }
          // Wait for signal from input buffer (zero-latency wakeup)
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS)
          }
          continue
        }

        // 3. Denoise and write to output
        val denoised = denoiser.run(chunk, sr)
        outputEntry.appendSamples(denoised.samples, sr, LIVE_APPEND_SOURCE_ENHANCEMENT)

        samplesRead += chunk.size
        samplesWritten += denoised.samples.size
        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in enhancement pipeline"
    } finally {
      isRunning = false
      inputEntry.releaseCursor(cursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      // Complete any remaining flush/reset commands
      drainRemainingCommands()
      // Ensure executor is shut down (handles auto-stop path)
      executor.shutdown()
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            val flushed = denoiser.flush()
            if (flushed.samples.isNotEmpty()) {
              outputEntry.appendSamples(flushed.samples, denoiser.sampleRate, LIVE_APPEND_SOURCE_ENHANCEMENT)
              samplesWritten += flushed.samples.size
            }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            denoiser.reset()
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
    // Wake worker so it exits
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
    samplesRead = samplesRead,
    samplesWritten = samplesWritten,
    error = error,
  )

  override fun release() {
    stop()
  }
}
