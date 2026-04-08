package com.sherpaonnx.pcm

import android.media.AudioTrack

internal enum class PcmPlayerFeed { JS, NATIVE }

internal class PcmPlayerSession(
  val playerId: String,
  val sampleRate: Int,
  val channels: Int,
  val feed: PcmPlayerFeed,
  val ttsInstanceId: String?,
  val track: AudioTrack
) {
  @Volatile var destroyed = false

  /** Enqueue float PCM. Shared by JS writes and native producers. */
  fun enqueueMonoFloat32(samples: FloatArray) {
    if (destroyed) return
    track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
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
    try { track.stop() } catch (_: IllegalStateException) {}
    track.flush()
    track.release()
  }
}
