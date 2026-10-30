package com.sherpaonnx.video.preview

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.sherpaonnx.audio.session.PaAudioSessionCoordinator
import java.nio.ByteBuffer

internal class VideoPreviewAudioTrack(
  private val playerId: String,
  private val sampleRate: Int,
  private val channels: Int,
) {
  private var track: AudioTrack? = null
  private var intentAcquired = false
  private val intentId = "vprev:$playerId"
  @Volatile var duckedVolume = 1f
  private var userVolume = 1f

  fun open(): Boolean {
    if (track != null) return true
    val chMask = if (channels >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
      .setSampleRate(sampleRate)
      .setChannelMask(chMask)
      .build()
    val min = AudioTrack.getMinBufferSize(sampleRate, chMask, AudioFormat.ENCODING_PCM_FLOAT)
    val buf = (min * 2).coerceAtLeast(min)
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
      .build()
    return try {
      val t = AudioTrack(
        attributes, format, buf, AudioTrack.MODE_STREAM,
        AudioManagerSessionId()
      )
      track = t
      PaAudioSessionCoordinator.acquireIntent(
        PaAudioSessionCoordinator.Intent(ownerId = intentId, needsInput = false, needsOutput = true)
      )
      intentAcquired = true
      PaAudioSessionCoordinator.applyPreferredDevice(t)
      t.setVolume(userVolume * duckedVolume)
      true
    } catch (e: Exception) {
      Log.e(TAG, "AudioTrack.open failed: ${e.message}")
      false
    }
  }

  fun write(buf: ByteBuffer, bytes: Int): Int {
    val t = track ?: return AudioTrack.ERROR_INVALID_OPERATION
    buf.position(0)
    buf.limit(bytes)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      t.write(buf, bytes, AudioTrack.WRITE_BLOCKING)
    } else {
      AudioTrack.ERROR_INVALID_OPERATION
    }
  }

  fun play() {
    track?.play()
  }

  fun pause() {
    track?.pause()
  }

  fun flush() {
    track?.pause()
    track?.flush()
  }

  fun timestamp(out: LongArray): Boolean {
    val t = track ?: return false
    if (out.size < 2) return false
    val ts = AudioTimestamp()
    if (t.getTimestamp(ts)) {
      out[0] = ts.framePosition
      out[1] = ts.nanoTime
      return true
    }
    return false
  }

  fun headPosition(): Long {
    val t = track ?: return 0
    return t.playbackHeadPosition.toLong() and 0xffffffffL
  }

  fun setVolume(v: Float) {
    userVolume = v.coerceIn(0f, 1f)
    track?.setVolume(userVolume * duckedVolume)
  }

  fun setDuck(factor: Float) {
    duckedVolume = factor.coerceIn(0f, 1f)
    track?.setVolume(userVolume * duckedVolume)
  }

  fun release() {
    val t = track
    track = null
    try {
      t?.pause()
      t?.flush()
      t?.release()
    } catch (_: Exception) {
    }
    if (t != null) {
      try {
        PaAudioSessionCoordinator.unregisterTrack(t)
      } catch (_: Exception) {
      }
    }
    if (intentAcquired) {
      PaAudioSessionCoordinator.releaseIntent(intentId)
      intentAcquired = false
    }
  }

  private fun AudioManagerSessionId(): Int {
    return android.media.AudioManager.AUDIO_SESSION_ID_GENERATE
  }

  companion object {
    private const val TAG = "SherpaOnnx:video.preview"
  }
}
