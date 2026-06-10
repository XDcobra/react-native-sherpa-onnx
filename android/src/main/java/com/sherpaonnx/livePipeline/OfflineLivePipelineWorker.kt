package com.sherpaonnx.livePipeline

import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.text.pipeline.TextSegment
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

sealed class CommittedSegmentRef {
  data class Speech(
    val sourceAudioBufferId: String,
    val startSample: Int,
    val endSample: Int,
    val sampleRate: Int,
    val durationMs: Int,
    val segmentId: String,
    val segmentIndex: Int,
    val payloadJson: String?,
  ) : CommittedSegmentRef()

  data class Text(
    val text: String,
    val segmentId: String,
    val segmentIndex: Int,
    val startOffset: Int,
    val endOffset: Int,
    val source: String,
    val meta: Map<String, Any?>?,
  ) : CommittedSegmentRef()
}

internal abstract class OfflineLivePipelineWorker(
  override val pipelineId: String,
  protected val attachedSegmentationEngineId: String,
  private val audioInput: AudioInput?,
  private val textInput: TextInput?,
) : StreamingPipelineWorker {

  data class AudioInput(
    val liveAudioEntry: LiveEntry,
    val liveSegmentEntry: LiveSegmentEntry,
  )

  data class TextInput(
    val liveTextEntry: LiveTextEntry,
  )

  private val running = AtomicBoolean(false)
  private val stopRequested = AtomicBoolean(false)
  private val segmentationDetached = AtomicBoolean(false)

  private val workerThreadLock = ReentrantLock()
  private val dataAvailable = workerThreadLock.newCondition()

  private val cmdLock = Any()
  private val commandQueue = ArrayDeque<PipelineCommand>()

  @Volatile
  private var workerThread: Thread? = null
  @Volatile
  private var error: String? = null
  @Volatile
  private var chunksProcessed: Long = 0L
  @Volatile
  private var unitsRead: Long = 0L
  @Volatile
  private var unitsWritten: Long = 0L

  private var audioCursorId: Int? = null
  private var textCursorId: Int? = null
  private var audioCommitListenerToken: Int? = null
  private var textCommitListenerToken: Int? = null

  private sealed class PipelineCommand {
    data class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    data class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  protected abstract fun onSegmentCommitted(segment: CommittedSegmentRef)

  protected fun addUnitsWritten(units: Long) {
    if (units <= 0) return
    unitsWritten += units
  }

  protected open fun onRelease() = Unit

  override val isRunning: Boolean
    get() = running.get()

  override fun start() {
    if (!running.compareAndSet(false, true)) return

    audioCursorId = audioInput?.liveSegmentEntry?.createSegmentCursor()
    textCursorId = textInput?.liveTextEntry?.createSegmentCursor()
    attachCommitListeners()

    workerThread = thread(name = "OfflineLivePipelineWorker-$pipelineId", isDaemon = true) {
      try {
        runLoop()
      } catch (e: Exception) {
        error = e.message ?: "OfflineLivePipelineWorker failed"
      } finally {
        running.set(false)
      }
    }
  }

  override fun stop() {
    if (!stopRequested.compareAndSet(false, true)) return
    workerThreadLock.withLock { dataAvailable.signalAll() }
  }

  override fun flush(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      commandQueue.addLast(PipelineCommand.Flush(future))
    }
    workerThreadLock.withLock { dataAvailable.signalAll() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      commandQueue.addLast(PipelineCommand.Reset(future))
    }
    workerThreadLock.withLock { dataAvailable.signalAll() }
    return future
  }

  override fun getStatus(): StreamingPipelineStatus = StreamingPipelineStatus(
    isRunning = running.get(),
    chunksProcessed = chunksProcessed,
    unitsRead = unitsRead,
    unitsWritten = unitsWritten,
    error = error,
  )

  override fun release() {
    stop()
    detachCommitListeners()
    releaseCursors()
    detachSegmentationEngineSafe(flushFinal = false)
    onRelease()
    workerThread?.let { thread ->
      if (thread !== Thread.currentThread()) {
        try {
          thread.join(2_000)
        } catch (_: InterruptedException) {
        }
      }
    }
  }

  private fun runLoop() {
    while (!stopRequested.get()) {
      processCommands()

      val drained = drainNextSegment()
      if (drained == null) {
        if (isInputFinalized()) {
          break
        }
        workerThreadLock.withLock {
          dataAvailable.await(100, TimeUnit.MILLISECONDS)
        }
        continue
      }

      try {
        onSegmentCommitted(drained.segment)
        chunksProcessed += 1
        unitsRead += drained.unitsRead
      } catch (e: Exception) {
        error = e.message
      }
    }

    drainTail()
    drainRemainingCommands()
  }

  private fun processCommands() {
    while (true) {
      val cmd = synchronized(cmdLock) {
        if (commandQueue.isEmpty()) null else commandQueue.removeFirst()
      } ?: return

      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            detachSegmentationEngineSafe(flushFinal = true)
            drainTail()
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          // Per sub-02 OQ-2.4, reset is intentionally a no-op in the shared base.
          cmd.completion.complete(Unit)
        }
      }
    }
  }

  private fun drainTail() {
    while (true) {
      val drained = drainNextSegment() ?: return
      try {
        onSegmentCommitted(drained.segment)
        chunksProcessed += 1
        unitsRead += drained.unitsRead
      } catch (e: Exception) {
        error = e.message
      }
    }
  }

  private fun drainNextSegment(): DrainedSegment? {
    val localAudioCursor = audioCursorId
    if (audioInput != null && localAudioCursor != null) {
      val next = audioInput.liveSegmentEntry.drainSegments(localAudioCursor, 1).firstOrNull()
      if (next != null) {
        val record = next.record
        return DrainedSegment(
          segment = CommittedSegmentRef.Speech(
            sourceAudioBufferId = record.sourceAudioBufferId,
            startSample = record.startSample,
            endSample = record.endSample,
            sampleRate = record.sampleRate,
            durationMs = record.durationMs,
            segmentId = next.segmentId,
            segmentIndex = next.segmentIndex,
            payloadJson = record.payloadJson,
          ),
          unitsRead = (record.endSample - record.startSample).coerceAtLeast(0).toLong(),
        )
      }
    }

    val localTextCursor = textCursorId
    if (textInput != null && localTextCursor != null) {
      val next = textInput.liveTextEntry.drainSegments(localTextCursor, 1).firstOrNull()
      if (next != null) {
        val offsetEnd = next.text.length
        return DrainedSegment(
          segment = CommittedSegmentRef.Text(
            text = next.text,
            segmentId = "txtseg_${textInput.liveTextEntry.bufferId}_${next.segmentIndex}",
            segmentIndex = next.segmentIndex,
            startOffset = 0,
            endOffset = offsetEnd,
            source = next.source,
            meta = next.meta,
          ),
          unitsRead = next.text.length.toLong(),
        )
      }
    }

    return null
  }

  private fun drainRemainingCommands() {
    while (true) {
      val cmd = synchronized(cmdLock) {
        if (commandQueue.isEmpty()) null else commandQueue.removeFirst()
      } ?: return

      val ex = IllegalStateException("Pipeline stopped before command could complete")
      when (cmd) {
        is PipelineCommand.Flush -> cmd.completion.completeExceptionally(ex)
        is PipelineCommand.Reset -> cmd.completion.completeExceptionally(ex)
      }
    }
  }

  private fun isInputFinalized(): Boolean {
    if (audioInput != null) {
      return audioInput.liveAudioEntry.state == LiveEntry.State.FINISHED
    }
    if (textInput != null) {
      return textInput.liveTextEntry.state == LiveTextEntry.State.FINISHED
    }
    return true
  }

  private fun attachCommitListeners() {
    audioInput?.let { input ->
      val token = input.liveSegmentEntry.addCommitListener { _, _, _ ->
        workerThreadLock.withLock { dataAvailable.signalAll() }
      }
      audioCommitListenerToken = token
    }

    textInput?.let { input ->
      val token = input.liveTextEntry.addCommitListener { _: TextSegment ->
        workerThreadLock.withLock { dataAvailable.signalAll() }
      }
      textCommitListenerToken = token
    }
  }

  private fun detachCommitListeners() {
    audioInput?.let { input ->
      audioCommitListenerToken?.let { token ->
        input.liveSegmentEntry.removeCommitListener(token)
      }
      audioCommitListenerToken = null
    }

    textInput?.let { input ->
      textCommitListenerToken?.let { token ->
        input.liveTextEntry.removeCommitListener(token)
      }
      textCommitListenerToken = null
    }
  }

  private fun releaseCursors() {
    audioInput?.let { input ->
      audioCursorId?.let { cursor -> input.liveSegmentEntry.releaseSegmentCursor(cursor) }
      audioCursorId = null
    }

    textInput?.let { input ->
      textCursorId?.let { cursor -> input.liveTextEntry.releaseSegmentCursor(cursor) }
      textCursorId = null
    }
  }

  private fun detachSegmentationEngineSafe(flushFinal: Boolean) {
    if (!segmentationDetached.compareAndSet(false, true)) return
    try {
      SegmentationEngineRegistry.detachEngine(attachedSegmentationEngineId, flushFinal)
    } catch (_: Exception) {
    }
  }

  private data class DrainedSegment(
    val segment: CommittedSegmentRef,
    val unitsRead: Long,
  )
}
