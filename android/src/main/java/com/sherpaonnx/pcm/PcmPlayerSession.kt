package com.sherpaonnx.pcm

import android.media.AudioTrack
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.errors.OfflineOomError
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max

private const val DEFAULT_DRAIN_CHUNK_SIZE = 4096
private const val DEFAULT_MAX_BUFFERED_MS = 300
private const val DRAIN_WAIT_MS = 10L
private const val WRITE_WAIT_MS = 200L

private data class ChunkSlot(
  val data: FloatArray,
  var size: Int = 0,
)

private data class TerminalErrorState(
  val code: String,
  val message: String,
  val cause: Throwable? = null,
)

private data class DequeueResult(
  val slot: ChunkSlot? = null,
  val sourceExhausted: Boolean = false,
)

internal class PcmPlayerSession(
  val playerId: String,
  val bufferId: String,
  val sampleRate: Int,
  val channels: Int,
  val track: AudioTrack,
  val offlineEntry: OfflineEntry? = null,
  val liveEntry: LiveEntry? = null
) {
  @Volatile var destroyed = false

  /** Callback invoked on a background thread when playback reaches end-of-stream. */
  var onEnded: (() -> Unit)? = null

  /** Callback invoked on a background thread when a terminal playback error occurs. */
  var onTerminalError: ((code: String, message: String) -> Unit)? = null

  // ---- Generation counter for seek/restart cancellation ----
  private val drainGeneration = AtomicInteger(0)

  // ---- Playback position tracking ----
  @Volatile private var headPosAtCycleStart: Long = 0L
  @Volatile private var framesWrittenInCycle: Long = 0L
  @Volatile private var seekPositionSamples: Long = 0L
  private val endedEmitted = AtomicBoolean(false)

  // Lock to serialize seek/restart operations
  private val seekLock = ReentrantLock()

  // ---- Bounded queue policy (time-based budget) ----
  private val maxBufferedFrames = max(
    (sampleRate * DEFAULT_MAX_BUFFERED_MS) / 1000,
    DEFAULT_DRAIN_CHUNK_SIZE * 2
  )
  private val resumeBufferedFrames = max(maxBufferedFrames / 2, DEFAULT_DRAIN_CHUNK_SIZE)
  private val poolSlotCount = max(
    2,
    ((maxBufferedFrames + DEFAULT_DRAIN_CHUNK_SIZE - 1) / DEFAULT_DRAIN_CHUNK_SIZE) + 2
  )

  private val queueLock = ReentrantLock()
  private val queueHasData = queueLock.newCondition()
  private val queueCanProduce = queueLock.newCondition()
  private val queuedSlots = ArrayDeque<ChunkSlot>()
  private val slotPool = ArrayDeque<ChunkSlot>()
  private var queuedFrames = 0
  private var highWaterActive = false
  private val writeThreadStop = AtomicBoolean(false)
  private val cleanupStarted = AtomicBoolean(false)
  private val sourceExhaustedGeneration = AtomicInteger(-1)

  @Volatile private var terminalError: TerminalErrorState? = null

  init {
    repeat(poolSlotCount) {
      slotPool.addLast(ChunkSlot(FloatArray(DEFAULT_DRAIN_CHUNK_SIZE)))
    }
  }

  private val writeThread = Thread({
    while (true) {
      val next = try {
        dequeueForWrite()
      } catch (_: InterruptedException) {
        break
      }

      if (next == null) break
      if (next.sourceExhausted) {
        handleSourceExhausted()
        continue
      }

      val slot = next.slot ?: continue
      if (!destroyed) {
        try {
          track.write(slot.data, 0, slot.size, AudioTrack.WRITE_BLOCKING)
          framesWrittenInCycle += slot.size
        } catch (_: IllegalStateException) {
          break
        } catch (e: OutOfMemoryError) {
          failOfflineOom("writeThread", e)
          break
        } finally {
          recycleSlot(slot)
        }
      } else {
        recycleSlot(slot)
      }
    }
  }, "pcm-write-$playerId").also {
    it.isDaemon = true
    it.start()
  }

  // Optional background drainer for live/offline pipeline buffer sources.
  private val drainLock = ReentrantLock()
  private val drainDataAvailable = drainLock.newCondition()
  @Volatile private var liveDrainThread: Thread? = null
  @Volatile private var offlineDrainThread: Thread? = null
  private var liveCursorId: Int = -1
  private var liveAppendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  fun terminalErrorSnapshot(): Pair<String, String>? {
    val err = terminalError ?: return null
    return err.code to err.message
  }

  fun terminalErrorCause(): Throwable? = terminalError?.cause

  private fun framesToMs(frames: Int): Int {
    if (sampleRate <= 0) return 0
    return ((frames.toLong() * 1000L) / sampleRate.toLong()).toInt()
  }

  private fun queueSnapshot(): Pair<Int, Int> = queueLock.withLock {
    queuedFrames to queuedSlots.size
  }

  private fun clearBufferedQueueLocked() {
    while (queuedSlots.isNotEmpty()) {
      val slot = queuedSlots.removeFirst()
      slot.size = 0
      slotPool.addLast(slot)
    }
    queuedFrames = 0
    sourceExhaustedGeneration.set(-1)
    if (highWaterActive) {
      highWaterActive = false
    }
  }

  private fun markSourceExhausted(gen: Int) {
    sourceExhaustedGeneration.set(gen)
    queueLock.withLock {
      queueHasData.signalAll()
    }
  }

  @Throws(InterruptedException::class)
  private fun dequeueForWrite(): DequeueResult? {
    queueLock.withLock {
      while (true) {
        if (writeThreadStop.get()) return null

        if (queuedSlots.isNotEmpty()) {
          val slot = queuedSlots.removeFirst()
          queuedFrames = (queuedFrames - slot.size).coerceAtLeast(0)
          if (highWaterActive && queuedFrames <= resumeBufferedFrames) {
            highWaterActive = false
          }
          queueCanProduce.signalAll()
          return DequeueResult(slot = slot)
        }

        val gen = drainGeneration.get()
        if (!destroyed && sourceExhaustedGeneration.get() == gen) {
          sourceExhaustedGeneration.compareAndSet(gen, -1)
          return DequeueResult(sourceExhausted = true)
        }

        if (destroyed || terminalError != null) {
          return null
        }

        queueHasData.await(WRITE_WAIT_MS, TimeUnit.MILLISECONDS)
      }
    }
  }

  @Throws(InterruptedException::class)
  private fun acquireWritableSlot(gen: Int): ChunkSlot? {
    var waitStartNs = 0L
    queueLock.withLock {
      while (true) {
        if (destroyed || writeThreadStop.get() || terminalError != null || drainGeneration.get() != gen) {
          return null
        }

        if (queuedFrames >= maxBufferedFrames) {
          if (!highWaterActive) {
            highWaterActive = true
          }
          if (waitStartNs == 0L) {
            waitStartNs = System.nanoTime()
          }
          queueCanProduce.await(DRAIN_WAIT_MS, TimeUnit.MILLISECONDS)
          continue
        }

        val slot = if (slotPool.isNotEmpty()) slotPool.removeFirst() else null
        if (slot != null) {
          return slot
        }

        if (waitStartNs == 0L) {
          waitStartNs = System.nanoTime()
        }
        queueCanProduce.await(DRAIN_WAIT_MS, TimeUnit.MILLISECONDS)
      }
    }
  }

  private fun recycleSlot(slot: ChunkSlot) {
    queueLock.withLock {
      slot.size = 0
      slotPool.addLast(slot)
      queueCanProduce.signalAll()
    }
  }

  private fun enqueueFilledSlot(slot: ChunkSlot, size: Int, gen: Int): Boolean {
    if (size <= 0) {
      recycleSlot(slot)
      return false
    }

    queueLock.withLock {
      if (destroyed || writeThreadStop.get() || terminalError != null || drainGeneration.get() != gen) {
        slot.size = 0
        slotPool.addLast(slot)
        queueCanProduce.signalAll()
        return false
      }

      slot.size = size
      queuedSlots.addLast(slot)
      queuedFrames += size
      if (!highWaterActive && queuedFrames >= maxBufferedFrames) {
        highWaterActive = true
      }
      queueHasData.signal()
      return true
    }
  }

  @Throws(InterruptedException::class)
  private fun enqueueCopiedSamples(samples: FloatArray, gen: Int): Boolean {
    var offset = 0
    while (offset < samples.size) {
      val slot = acquireWritableSlot(gen) ?: return false
      val count = minOf(slot.data.size, samples.size - offset)
      System.arraycopy(samples, offset, slot.data, 0, count)
      if (!enqueueFilledSlot(slot, count, gen)) {
        return false
      }
      offset += count
    }
    return true
  }

  private fun failOfflineOom(path: String, error: OutOfMemoryError) {
    val first = terminalError == null
    if (first) {
      terminalError = TerminalErrorState(
        code = OfflineOomError.CODE,
        message = OfflineOomError.message("playback"),
        cause = error
      )
    }

    android.util.Log.e(
      "PcmPlayerSession",
      "OFFLINE_OOM $path bufferId=$bufferId queuedFrames=${queueSnapshot().first}; stopping playback",
      error
    )

    destroyed = true
    drainGeneration.incrementAndGet()
    drainLock.withLock { drainDataAvailable.signalAll() }
    queueLock.withLock {
      clearBufferedQueueLocked()
      writeThreadStop.set(true)
      queueHasData.signalAll()
      queueCanProduce.signalAll()
    }

    if (first) {
      val err = terminalError
      if (err != null) {
        onTerminalError?.invoke(err.code, err.message)
      }
    }
  }

  /** Enqueue float PCM for native playback. */
  fun enqueueMonoFloat32(samples: FloatArray) {
    if (destroyed || samples.isEmpty()) return
    val gen = drainGeneration.get()
    try {
      enqueueCopiedSamples(samples, gen)
    } catch (e: OutOfMemoryError) {
      failOfflineOom("enqueueMonoFloat32", e)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  /** Stream an offline buffer to the player queue in the background. */
  fun startOfflineDrain(startSampleIndex: Long = 0, chunkSize: Int = DEFAULT_DRAIN_CHUNK_SIZE) {
    val entry = offlineEntry ?: return
    if (destroyed) return
    val gen = drainGeneration.get()
        offlineDrainThread = Thread({
      try {
        entry.createReader().use { reader ->
          if (startSampleIndex > 0) reader.seekToSample(startSampleIndex.toInt())
          var chunksRead = 0L
          val rt = Runtime.getRuntime()
          while (!destroyed && terminalError == null && drainGeneration.get() == gen) {
            val slot = acquireWritableSlot(gen) ?: break
            val read = reader.readSamples(slot.data, 0, slot.data.size)
            if (read <= 0) {
              recycleSlot(slot)
              break
            }
            if (!enqueueFilledSlot(slot, read, gen)) {
              break
            }
            chunksRead++
            if (chunksRead % 128L == 0L) {
              val snapshot = queueSnapshot()
              val free = rt.freeMemory()
              val total = rt.totalMemory()
              val max = rt.maxMemory()
                          }
          }
        }
      } catch (e: OutOfMemoryError) {
        failOfflineOom("offlineDrain", e)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      } catch (_: Exception) {
        // Best effort: playback is canceled if the session is destroyed.
      }
      // If not interrupted by seek/destroy, signal end-of-stream
      if (!destroyed && terminalError == null && drainGeneration.get() == gen) {
        markSourceExhausted(gen)
      }
    }, "pcm-offline-drain-$playerId").also {
      it.isDaemon = true
      it.start()
    }
  }

  /** Drain a live buffer cursor and play chunks as soon as they are appended. */
  fun startLiveDrain(startAbsolutePos: Long = -1, chunkSize: Int = DEFAULT_DRAIN_CHUNK_SIZE) {
    val entry = liveEntry ?: return
    if (destroyed) return
    val gen = drainGeneration.get()

    liveCursorId = entry.createCursorHandle()
    if (startAbsolutePos >= 0) {
      entry.seekCursor(liveCursorId, startAbsolutePos)
    }

    val listener: (LiveFramesAppendedEvent) -> Unit = {
      drainLock.withLock { drainDataAvailable.signal() }
    }
    liveAppendListener = listener
    entry.addAppendListener(listener)

    liveDrainThread = Thread({
      try {
        while (!destroyed && terminalError == null && drainGeneration.get() == gen) {
          val chunk = entry.drainCursor(liveCursorId, chunkSize)
          if (chunk.isNotEmpty()) {
            if (!enqueueCopiedSamples(chunk, gen)) {
              break
            }
            continue
          }

          if (entry.state == LiveEntry.State.FINISHED) {
            break
          }

          drainLock.withLock {
            drainDataAvailable.await(DRAIN_WAIT_MS, TimeUnit.MILLISECONDS)
          }
        }
      } catch (e: OutOfMemoryError) {
        failOfflineOom("liveDrain", e)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      } finally {
        cleanupLiveHandles(entry)
      }
      // If not interrupted by seek/destroy, signal end-of-stream
      if (!destroyed && terminalError == null && drainGeneration.get() == gen) {
        markSourceExhausted(gen)
      }
    }, "pcm-live-drain-$playerId").also {
      it.isDaemon = true
      it.start()
    }
  }

  /**
   * Seek to an absolute sample position. Stops current drain, flushes AudioTrack,
   * restarts drain from the new position.
   * @return true if seek succeeded
   */
  fun seekToSample(sampleIndex: Long): Boolean {
    if (destroyed) return false
    seekLock.withLock {
      if (destroyed || terminalError != null) return false

      // 1. Increment generation to abort current drain threads
      drainGeneration.incrementAndGet()

      // 2. Wake drain threads and wait for them to finish
      drainLock.withLock { drainDataAvailable.signal() }
      joinDrainThreads()

      // 3. Clear queued audio chunks and reset watermark state.
      queueLock.withLock {
        clearBufferedQueueLocked()
        queueCanProduce.signalAll()
      }

      // 4. Flush AudioTrack (must be paused or stopped first)
      try {
        track.pause()
        track.flush()
      } catch (_: IllegalStateException) {
        return false
      }

      // 5. Reset cycle tracking
      headPosAtCycleStart = track.playbackHeadPosition.toLong()
      framesWrittenInCycle = 0
      seekPositionSamples = sampleIndex
      endedEmitted.set(false)

      // 6. Restart AudioTrack
      try {
        track.play()
      } catch (_: IllegalStateException) {
        return false
      }

      // 7. Restart drain from new position
      if (offlineEntry != null) {
        startOfflineDrain(startSampleIndex = sampleIndex)
      } else if (liveEntry != null) {
        startLiveDrain(startAbsolutePos = sampleIndex)
      }

      return true
    }
  }

  /** Get estimated playback position in milliseconds. */
  fun getPositionMs(): Double {
    if (destroyed || sampleRate <= 0) return 0.0
    val headPos = try { track.playbackHeadPosition.toLong() } catch (_: IllegalStateException) { 0L }
    val framesPlayed = (headPos - headPosAtCycleStart).coerceAtLeast(0)
    return (seekPositionSamples + framesPlayed).toDouble() / sampleRate * 1000.0
  }

  fun pause() {
    if (destroyed) return
    track.pause()
  }

  fun resume() {
    if (destroyed) return
    track.play()
  }

  fun destroy() {
    if (!cleanupStarted.compareAndSet(false, true)) return
    destroyed = true

    // Increment generation to stop drain threads
    drainGeneration.incrementAndGet()
    drainLock.withLock { drainDataAvailable.signal() }

    queueLock.withLock {
      clearBufferedQueueLocked()
      writeThreadStop.set(true)
      queueHasData.signalAll()
      queueCanProduce.signalAll()
    }

    joinDrainThreads()

    if (Thread.currentThread() != writeThread) {
      try {
        writeThread.join(1000)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }

    val activeLiveEntry = liveEntry
    cleanupLiveHandles(activeLiveEntry)

    try { track.stop() } catch (_: IllegalStateException) {}
    try { track.flush() } catch (_: IllegalStateException) {}
    try { track.release() } catch (_: Exception) {}
    onEnded = null
    onTerminalError = null
  }

  private fun joinDrainThreads() {
    try {
      liveDrainThread?.join(1000)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    liveDrainThread = null

    try {
      offlineDrainThread?.join(1000)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    offlineDrainThread = null
  }

  private fun cleanupLiveHandles(entry: LiveEntry?) {
    val appendListener = liveAppendListener
    if (entry != null && appendListener != null) {
      entry.removeAppendListener(appendListener)
      liveAppendListener = null
    }
    if (entry != null && liveCursorId >= 0) {
      entry.releaseCursor(liveCursorId)
      liveCursorId = -1
    }
  }

  /** Called by the write thread when EOS_MARKER is dequeued. Waits for playback to finish, then fires onEnded. */
  private fun handleSourceExhausted() {
    val gen = drainGeneration.get()
    val targetFrames = framesWrittenInCycle
    val snapshotStart = queueSnapshot()
        // Wait for AudioTrack to finish playing all written frames
    while (!destroyed && drainGeneration.get() == gen) {
      val headPos = try { track.playbackHeadPosition.toLong() } catch (_: IllegalStateException) { break }
      val played = headPos - headPosAtCycleStart
      if (played >= targetFrames) break
      if (track.playState != AudioTrack.PLAYSTATE_PLAYING) break
      try {
        Thread.sleep(20)
      } catch (_: InterruptedException) {
        break
      }
    }
    // Fire onEnded once per drain cycle
    if (!destroyed && drainGeneration.get() == gen && endedEmitted.compareAndSet(false, true)) {
      val snapshotEnd = queueSnapshot()
            onEnded?.invoke()
    }
  }
}
