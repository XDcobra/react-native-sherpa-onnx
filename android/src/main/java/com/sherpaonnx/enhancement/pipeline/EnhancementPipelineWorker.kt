package com.sherpaonnx.enhancement.pipeline

import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.sherpaonnx.audio.pipeline.LiveAppendOrigin
import com.sherpaonnx.audio.pipeline.LiveAudioPipelineWriter
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.lifecycle.NativeInstanceGate
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

  private val gateKey = NativeInstanceGate.keyFor(denoiser)

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "enhancement-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile
  private var chunksProcessed = 0L
  @Volatile
  private var unitsRead = 0L
  @Volatile
  private var unitsWritten = 0L
  @Volatile
  private var error: String? = null
  private var cursorId: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()
  private val cmdLock = Any()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    cursorId = inputEntry.createCursorHandle()

    appendListener = {
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val chunkSize = denoiser.frameShiftInSamples
    val sampleRate = denoiser.sampleRate
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(cursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            if (NativeInstanceGate.beginUse(gateKey)) {
              try {
                val flushed = denoiser.flush()
                if (flushed.samples.isNotEmpty()) {
                  when (
                    outputEntry.tryAppendSamples(
                      flushed.samples,
                      sampleRate,
                      LiveAppendOrigin.Pipeline(LiveAudioPipelineWriter.ENHANCEMENT),
                    )
                  ) {
                    LiveEntry.AppendResult.APPENDED -> {
                      unitsWritten += flushed.samples.size
                    }
                    LiveEntry.AppendResult.BUFFER_FINALIZED -> {
                      isRunning = false
                      break
                    }
                  }
                }
              } finally {
                NativeInstanceGate.endUse(gateKey)
              }
            }
            break
          }
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS)
          }
          continue
        }

        if (!NativeInstanceGate.beginUse(gateKey)) {
          isRunning = false
          break
        }
        val denoised = try {
          denoiser.run(chunk, sampleRate)
        } finally {
          NativeInstanceGate.endUse(gateKey)
        }
        when (
          outputEntry.tryAppendSamples(
            denoised.samples,
            sampleRate,
            LiveAppendOrigin.Pipeline(LiveAudioPipelineWriter.ENHANCEMENT),
          )
        ) {
          LiveEntry.AppendResult.APPENDED -> {
            unitsWritten += denoised.samples.size
          }
          LiveEntry.AppendResult.BUFFER_FINALIZED -> {
            isRunning = false
            break
          }
        }

        unitsRead += chunk.size
        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in enhancement pipeline"
    } finally {
      inputEntry.releaseCursor(cursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      synchronized(cmdLock) {
        while (true) {
          val cmd = commandQueue.poll() ?: break
          when (cmd) {
            is PipelineCommand.Flush -> cmd.completion.complete(Unit)
            is PipelineCommand.Reset -> cmd.completion.complete(Unit)
          }
        }
        isRunning = false
      }
      executor.shutdown()
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            if (!NativeInstanceGate.beginUse(gateKey)) {
              cmd.completion.completeExceptionally(
                IllegalStateException("Online enhancement instance released"),
              )
              continue
            }
            try {
              val flushed = denoiser.flush()
              if (flushed.samples.isNotEmpty()) {
                when (
                  outputEntry.tryAppendSamples(
                    flushed.samples,
                    denoiser.sampleRate,
                    LiveAppendOrigin.Pipeline(LiveAudioPipelineWriter.ENHANCEMENT),
                  )
                ) {
                  LiveEntry.AppendResult.APPENDED -> {
                    unitsWritten += flushed.samples.size
                  }
                  LiveEntry.AppendResult.BUFFER_FINALIZED -> {
                    isRunning = false
                  }
                }
              }
              cmd.completion.complete(Unit)
            } finally {
              NativeInstanceGate.endUse(gateKey)
            }
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }

        is PipelineCommand.Reset -> {
          try {
            if (!NativeInstanceGate.beginUse(gateKey)) {
              cmd.completion.completeExceptionally(
                IllegalStateException("Online enhancement instance released"),
              )
              continue
            }
            try {
              denoiser.reset()
              cmd.completion.complete(Unit)
            } finally {
              NativeInstanceGate.endUse(gateKey)
            }
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  override fun stop() {
    // Always join. Early `!isRunning` return raced unload/release against the
    // worker finally block (isRunning cleared before teardown completes).
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
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        future.complete(Unit)
        return future
      }
      commandQueue.put(PipelineCommand.Flush(future))
    }
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        future.complete(Unit)
        return future
      }
      commandQueue.put(PipelineCommand.Reset(future))
    }
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