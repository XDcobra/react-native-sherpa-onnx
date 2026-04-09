package com.sherpaonnx.pcm

import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal enum class PcmPlayerFeed { JS, NATIVE }

private val POISON = FloatArray(0)

internal class PcmPlayerSession(
  val playerId: String,
  val sampleRate: Int,
  val channels: Int,
  val feed: PcmPlayerFeed,
  val ttsInstanceId: String?,
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
        track.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
      }
    }
  }, "pcm-write-$playerId").also {
    it.isDaemon = true
    it.start()
  }

  /** Enqueue float PCM. Shared by JS writes and native producers. */
  fun enqueueMonoFloat32(samples: FloatArray) {
    if (destroyed || samples.isEmpty()) return
    queue.put(samples.copyOf())
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
    queue.put(POISON)
    try { track.stop() } catch (_: IllegalStateException) {}
    track.flush()
    track.release()
  }
}
