package com.sherpaonnx.pcm

import android.media.AudioTrack
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.OfflineEntry
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

private val POISON = FloatArray(0)
private const val DEFAULT_DRAIN_CHUNK_SIZE = 4096
private const val DRAIN_WAIT_MS = 10L

internal class PcmPlayerSession(
  val playerId: String,
  val sampleRate: Int,
  val channels: Int,
  val track: AudioTrack
) {
  @Volatile var destroyed = false

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
      if (!destroyed) {
        try {
          track.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
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
  private var liveDrainThread: Thread? = null
  private var offlineDrainThread: Thread? = null
  private var liveEntry: LiveEntry? = null
  private var liveCursorId: Int = -1
  private var liveAppendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  /** Enqueue float PCM for native playback. */
  fun enqueueMonoFloat32(samples: FloatArray) {
    if (destroyed || samples.isEmpty()) return
    queue.put(samples.copyOf())
  }

  /** Stream an offline buffer to the player queue in the background. */
  fun startOfflineDrain(offlineEntry: OfflineEntry, chunkSize: Int = DEFAULT_DRAIN_CHUNK_SIZE) {
    if (destroyed || offlineDrainThread != null) return
    offlineDrainThread = Thread({
      try {
        offlineEntry.createReader().use { reader ->
          val chunk = FloatArray(chunkSize)
          while (!destroyed) {
            val read = reader.readSamples(chunk, 0, chunk.size)
            if (read <= 0) break
            val toEnqueue = if (read == chunk.size) chunk else chunk.copyOf(read)
            enqueueMonoFloat32(toEnqueue)
          }
        }
      } catch (_: Exception) {
        // Best effort: playback is canceled if the session is destroyed.
      }
    }, "pcm-offline-drain-$playerId").also {
      it.isDaemon = true
      it.start()
    }
  }

  /** Drain a live buffer cursor and play chunks as soon as they are appended. */
  fun startLiveDrain(entry: LiveEntry, chunkSize: Int = DEFAULT_DRAIN_CHUNK_SIZE) {
    if (destroyed || liveDrainThread != null) return
    liveEntry = entry
    liveCursorId = entry.createCursorHandle()

    val listener: (LiveFramesAppendedEvent) -> Unit = {
      drainLock.withLock { drainDataAvailable.signal() }
    }
    liveAppendListener = listener
    entry.addAppendListener(listener)

    liveDrainThread = Thread({
      try {
        while (!destroyed) {
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
        val appendListener = liveAppendListener
        if (appendListener != null) {
          entry.removeAppendListener(appendListener)
          liveAppendListener = null
        }
        if (liveCursorId >= 0) {
          entry.releaseCursor(liveCursorId)
          liveCursorId = -1
        }
      }
    }, "pcm-live-drain-$playerId").also {
      it.isDaemon = true
      it.start()
    }
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

    drainLock.withLock { drainDataAvailable.signal() }

    // Stop queue processing quickly.
    queue.clear()
    queue.offer(POISON)

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

    val activeLiveEntry = liveEntry
    val appendListener = liveAppendListener
    if (activeLiveEntry != null && appendListener != null) {
      activeLiveEntry.removeAppendListener(appendListener)
      liveAppendListener = null
    }
    if (activeLiveEntry != null && liveCursorId >= 0) {
      activeLiveEntry.releaseCursor(liveCursorId)
      liveCursorId = -1
    }
    liveEntry = null

    try { track.stop() } catch (_: IllegalStateException) {}
    track.flush()
    track.release()
  }
}
