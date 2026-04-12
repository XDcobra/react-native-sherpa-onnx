package com.sherpaonnx.audio.pipeline

import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineStream
import com.sherpaonnx.text.pipeline.LiveTextEntry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class SttPipelineWorker(
  override val pipelineId: String,
  private val recognizer: OnlineRecognizer,
  private val stream: OnlineStream,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveTextEntry,
  private val chunkSize: Int = 3200,
) : StreamingPipelineWorker {

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "stt-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile
  private var chunksProcessed = 0L
  @Volatile
  private var unitsRead = 0L
  @Volatile
  private var unitsWritten = 0L
  @Volatile
  private var error: String? = null
  private var audioCursorId: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    audioCursorId = inputEntry.createCursorHandle()

    appendListener = { _ ->
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    executor.submit { runLoop() }
  }

  private fun runLoop() {
    val sampleRate = recognizer.config.featConfig.sampleRate
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(audioCursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            autoFlushAndCommit()
            break
          }
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS)
          }
          continue
        }

        stream.acceptWaveform(chunk, sampleRate)
        unitsRead += chunk.size

        while (recognizer.isReady(stream)) {
          recognizer.decode(stream)
        }
        chunksProcessed++

        val result = recognizer.getResult(stream)

        if (result.text.isNotBlank()) {
          outputEntry.writePartial(result.text)
        }

        if (recognizer.isEndpoint(stream)) {
          if (result.text.isNotBlank()) {
            outputEntry.commitSegment(
              text = result.text,
              tokens = result.tokens,
              timestamps = result.timestamps,
              source = "stt_stream",
            )
            unitsWritten += result.text.length
            outputEntry.writePartial("")
          }
          recognizer.reset(stream)
        }
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in STT pipeline"
    } finally {
      isRunning = false
      inputEntry.releaseCursor(audioCursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      stream.release()
      drainRemainingCommands()
      executor.shutdown()
    }
  }

  private fun autoFlushAndCommit() {
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream)
    }
    val result = recognizer.getResult(stream)
    if (result.text.isNotBlank()) {
      outputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "stt_stream",
      )
      unitsWritten += result.text.length
      outputEntry.writePartial("")
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            autoFlushAndCommit()
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            recognizer.reset(stream)
            outputEntry.writePartial("")
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
