package com.sherpaonnx.pcm

import android.media.AudioTrack
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.OfflineEntry
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

private val POISON = FloatArray(0)
private val EOS_MARKER = FloatArray(0) // Distinct object from POISON
private const val DEFAULT_DRAIN_CHUNK_SIZE = 4096
private const val DRAIN_WAIT_MS = 10L

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

  // ---- Generation counter for seek/restart cancellation ----
  private val drainGeneration = AtomicInteger(0)

  // ---- Playback position tracking ----
  @Volatile private var headPosAtCycleStart: Long = 0L
  @Volatile private var framesWrittenInCycle: Long = 0L
  @Volatile private var seekPositionSamples: Long = 0L
  private val endedEmitted = AtomicBoolean(false)

  // Lock to serialize seek/restart operations
  private val seekLock = ReentrantLock()

  // Dedicated write thread to keep RN module calls non-blocking.
  private val queue = LinkedBlockingQueue<FloatArray>()
  private val writeThread = Thread({
    while (true) {
      val chunk = try {
        queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
      } catch (_: InterruptedException) {
        break
      }
      if (chunk === POISON) break
      if (chunk === EOS_MARKER) {
        handleSourceExhausted()
        continue
      }
      if (!destroyed) {
        try {
          track.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
          framesWrittenInCycle += chunk.size
        } catch (_: IllegalStateException) {
          break
        }
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

  /** Enqueue float PCM for native playback. */
  fun enqueueMonoFloat32(samples: FloatArray) {
    if (destroyed || samples.isEmpty()) return
    queue.put(samples.copyOf())
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
          val chunk = FloatArray(chunkSize)
          while (!destroyed && drainGeneration.get() == gen) {
            val read = reader.readSamples(chunk, 0, chunk.size)
            if (read <= 0) break
            val toEnqueue = if (read == chunk.size) chunk else chunk.copyOf(read)
            enqueueMonoFloat32(toEnqueue)
          }
        }
      } catch (_: Exception) {
        // Best effort: playback is canceled if the session is destroyed.
      }
      // If not interrupted by seek/destroy, signal end-of-stream
      if (!destroyed && drainGeneration.get() == gen) {
        queue.put(EOS_MARKER)
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
        while (!destroyed && drainGeneration.get() == gen) {
          val chunk = entry.drainCursor(liveCursorId, chunkSize)
          if (chunk.isNotEmpty()) {
            enqueueMonoFloat32(chunk)
            continue
          }

          if (entry.state == LiveEntry.State.FINISHED) {
            break
          }

          drainLock.withLock {
            drainDataAvailable.await(DRAIN_WAIT_MS, TimeUnit.MILLISECONDS)
          }
        }
      } finally {
        cleanupLiveHandles(entry)
      }
      // If not interrupted by seek/destroy, signal end-of-stream
      if (!destroyed && drainGeneration.get() == gen) {
        queue.put(EOS_MARKER)
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
      if (destroyed) return false

      // 1. Increment generation to abort current drain threads
      drainGeneration.incrementAndGet()

      // 2. Wake drain threads and wait for them to finish
      drainLock.withLock { drainDataAvailable.signal() }
      joinDrainThreads()

      // 3. Clear the write queue (but not POISON)
      queue.clear()

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
    if (destroyed) return
    destroyed = true

    // Increment generation to stop drain threads
    drainGeneration.incrementAndGet()
    drainLock.withLock { drainDataAvailable.signal() }

    // Stop queue processing quickly.
    queue.clear()
    queue.offer(POISON)

    joinDrainThreads()

    val activeLiveEntry = liveEntry
    cleanupLiveHandles(activeLiveEntry)

    try { track.stop() } catch (_: IllegalStateException) {}
    track.flush()
    track.release()
    onEnded = null
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
      onEnded?.invoke()
    }
  }
}
