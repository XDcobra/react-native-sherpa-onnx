package com.sherpaonnx.pcm

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray

internal class PcmPlayerService {
  private val registry = PcmPlayerRegistry()

  fun create(
    playerId: String,
    sampleRate: Double,
    channels: Double,
    feed: String,
    ttsInstanceId: String?,
    promise: Promise
  ) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "PCM playback requires API 21+")
        return
      }
      val sr = sampleRate.toInt()
      val ch = channels.toInt()
      if (sr <= 0) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "sampleRate must be > 0")
        return
      }
      if (ch != 1) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "PCM playback supports mono only (channels=1)")
        return
      }
      val parsedFeed = when (feed) {
        "js" -> PcmPlayerFeed.JS
        "native" -> PcmPlayerFeed.NATIVE
        else -> {
          promise.reject("PCM_PLAYER_INVALID_CONFIG", "Invalid feed: '$feed' (expected 'js' or 'native')")
          return
        }
      }

      val channelConfig = AudioFormat.CHANNEL_OUT_MONO
      val audioFormat = AudioFormat.Builder()
        .setSampleRate(sr)
        .setChannelMask(channelConfig)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .build()
      val minBufferSize = AudioTrack.getMinBufferSize(sr, channelConfig, AudioFormat.ENCODING_PCM_FLOAT)
      if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "Invalid buffer size for PCM player")
        return
      }
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val track = AudioTrack(
        attributes, audioFormat, minBufferSize,
        AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE
      )
      val session = PcmPlayerSession(playerId, sr, ch, parsedFeed, ttsInstanceId, track)
      registry.put(session)
      track.play()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to create PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_INVALID_CONFIG", "Failed to create PCM player: ${e.message}", e)
    }
  }

  fun write(playerId: String, samples: ReadableArray, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    if (session.feed == PcmPlayerFeed.NATIVE) {
      promise.reject("PCM_PLAYER_FEED_NATIVE", "writePcmChunk not allowed; player feed is 'native'")
      return
    }
    try {
      val buffer = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        buffer[i] = samples.getDouble(i).toFloat()
      }
      session.enqueueMonoFloat32(buffer)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to write PCM chunk: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to write PCM chunk: ${e.message}", e)
    }
  }

  fun pause(playerId: String, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    try {
      session.pause()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to pause PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to pause PCM player: ${e.message}", e)
    }
  }

  fun resume(playerId: String, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    try {
      session.resume()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to resume PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to resume PCM player: ${e.message}", e)
    }
  }

  fun destroy(playerId: String, promise: Promise) {
    val session = registry.remove(playerId)
    if (session == null) {
      promise.resolve(null) // idempotent
      return
    }
    try {
      session.destroy()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to destroy PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to destroy PCM player: ${e.message}", e)
    }
  }

  // ---- internal (no promise) for native TTS playback ----

  /** Create a native-feed player programmatically (called from TtsStreamingService). */
  fun createInternal(playerId: String, sampleRate: Int, channels: Int, ttsInstanceId: String?) {
    val channelConfig = AudioFormat.CHANNEL_OUT_MONO
    val audioFormat = AudioFormat.Builder()
      .setSampleRate(sampleRate)
      .setChannelMask(channelConfig)
      .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
      .build()
    val minBufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_FLOAT)
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val track = AudioTrack(
      attributes, audioFormat, minBufferSize,
      AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE
    )
    val session = PcmPlayerSession(playerId, sampleRate, channels, PcmPlayerFeed.NATIVE, ttsInstanceId, track)
    registry.put(session)
    track.play()
  }

  /** Enqueue samples from native code (TTS synthesis callback). No promise, best-effort. */
  fun enqueueFromNative(playerId: String, samples: FloatArray) {
    val session = registry[playerId] ?: return
    if (!session.destroyed) session.enqueueMonoFloat32(samples)
  }

  /** Destroy without promise (for auto-destroy / cancel). Returns true if session existed. */
  fun destroyInternal(playerId: String): Boolean {
    val session = registry.remove(playerId) ?: return false
    session.destroy()
    return true
  }

  fun shutdown() {
    registry.destroyAll()
  }

  private fun rejectNotFound(playerId: String, promise: Promise) {
    promise.reject("PCM_PLAYER_NOT_FOUND", "PCM player not found: $playerId")
  }

  private fun rejectDestroyed(playerId: String, promise: Promise) {
    promise.reject("PCM_PLAYER_DESTROYED", "PCM player already destroyed: $playerId")
  }

  private companion object {
    const val TAG = "PcmPlayerService"
  }
}
