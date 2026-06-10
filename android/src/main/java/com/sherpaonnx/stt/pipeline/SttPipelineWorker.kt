package com.sherpaonnx.stt.pipeline

import android.util.Log
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineStream
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.text.pipeline.TextSegment
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
  private val chunkSize: Int = 6400,
  private val onSegmentCommitted: ((segment: TextSegment, totalSegments: Int) -> Unit)? = null,
) : StreamingPipelineWorker {

  companion object {
    private const val LOG_TAG = "SherpaOnnx:SttPipelineWorker"
  }

  /** First non-blank streaming hypothesis (for sessionEnd summary). */
  private var dbgFirstHypothesis: String? = null

  /** Commits from mid-stream endpoint detection (before EOF). */
  private var dbgEndpointCommits: Int = 0

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

  private fun previewForLog(s: String, maxChars: Int = 96): String {
    val t = s.trim()
    if (t.length <= maxChars) return t
    return t.take(maxChars) + "…"
  }

  private fun runLoop() {
    val sampleRate = recognizer.config.featConfig.sampleRate
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(audioCursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            autoFlushAndCommit(endOfAudio = true)
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
          if (dbgFirstHypothesis == null) dbgFirstHypothesis = result.text
        }

        if (result.text.isNotBlank()) {
          outputEntry.writePartial(result.text)
        }

        if (recognizer.isEndpoint(stream)) {
          if (result.text.isNotBlank()) {
            dbgEndpointCommits++
            val createdAtMs = System.currentTimeMillis()
            val segmentMeta = mapOf<String, Any>(
              "__segmentReason" to "endpoint",
              "__segmentSource" to "segmentation_engine",
              "__segmentCreatedAtMs" to createdAtMs,
            )
            val segmentIndex = outputEntry.commitSegment(
              text = result.text,
              tokens = result.tokens,
              timestamps = result.timestamps,
              source = "stt_stream",
              meta = segmentMeta,
            )
            onSegmentCommitted?.invoke(
              TextSegment(
                text = result.text,
                tokens = result.tokens,
                timestamps = result.timestamps,
                source = "stt_stream",
                segmentIndex = segmentIndex,
                meta = segmentMeta,
              ),
              outputEntry.segmentCount,
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

  /**
   * Decode tail and optionally commit the final hypothesis.
   *
   * When [endOfAudio] is true (live input buffer finalized / file ingest done),
   * call [OnlineStream.inputFinished] so sherpa-onnx can flush internal frames
   * before the last decode passes — omitting this often truncates the transcript
   * (especially the leading context for Zipformer streaming).
   */
  private fun autoFlushAndCommit(endOfAudio: Boolean = false) {
    if (endOfAudio) {
      stream.inputFinished()
    }
    var tailDecodePasses = 0
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream)
      tailDecodePasses++
    }
    val result = recognizer.getResult(stream)
    if (endOfAudio) {
      val firstLen = dbgFirstHypothesis?.length ?: 0
      val finalLen = result.text.length
      val ft = dbgFirstHypothesis?.trimStart().orEmpty()
      val rt = result.text.trimStart()
      val finalExtendsFirstOpening =
        ft.isNotEmpty() && rt.startsWith(ft) && rt.length >= ft.length
      Log.i(
        LOG_TAG,
        "sessionEnd {pipelineId=$pipelineId, unitsRead=$unitsRead, chunks=$chunksProcessed, " +
          "endpointCommits=$dbgEndpointCommits, tailDecodePasses=$tailDecodePasses, " +
          "firstHypLen=$firstLen, finalLen=$finalLen, finalExtendsFirst=$finalExtendsFirstOpening, " +
          "preview=\"${previewForLog(result.text, 80)}\"}",
      )
    }
    if (result.text.isNotBlank()) {
      val createdAtMs = System.currentTimeMillis()
      val segmentMeta = mapOf<String, Any>(
        "__segmentReason" to "endpoint",
        "__segmentSource" to "segmentation_engine",
        "__segmentCreatedAtMs" to createdAtMs,
      )
      val segmentIndex = outputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "stt_stream",
        meta = segmentMeta,
      )
      onSegmentCommitted?.invoke(
        TextSegment(
          text = result.text,
          tokens = result.tokens,
          timestamps = result.timestamps,
          source = "stt_stream",
          segmentIndex = segmentIndex,
          meta = segmentMeta,
        ),
        outputEntry.segmentCount,
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
            // Do not call stream.inputFinished(): more audio may still arrive.
            autoFlushAndCommit(endOfAudio = false)
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
