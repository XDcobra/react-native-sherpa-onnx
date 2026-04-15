package com.sherpaonnx.pcm

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry

internal class PcmPlayerService {
  private val registry = PcmPlayerRegistry()

  /** Callback to emit pcmPlayerEnded events to JS. Set by the module. */
  var onPlayerEnded: ((playerId: String, bufferId: String) -> Unit)? = null

  fun create(
    playerId: String,
    audioBufferId: String,
    volume: Double,
    promise: Promise
  ) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "PCM playback requires API 21+")
        return
      }

      if (playerId.isBlank()) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "playerId is required")
        return
      }

      val liveEntry = PipelineAudioRegistry.getLive(audioBufferId)
      val offlineEntry = PipelineAudioRegistry.getOffline(audioBufferId)
      if (liveEntry == null && offlineEntry == null) {
        promise.reject("AUDIO_BUFFER_NOT_FOUND", "Audio buffer not found: $audioBufferId")
        return
      }

      val sr = liveEntry?.sampleRate ?: offlineEntry!!.sampleRate
      val ch = liveEntry?.channelCount ?: offlineEntry!!.channelCount
      if (sr <= 0) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "sampleRate must be > 0")
        return
      }
      if (ch != 1) {
        promise.reject("PCM_PLAYER_INVALID_CONFIG", "PCM playback supports mono only (channels=1)")
        return
      }
      val clampedVolume = volume.toFloat().coerceIn(0f, 1f)

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

      // Replace an existing player with the same ID to avoid leaking native resources.
      registry.remove(playerId)?.destroy()

      track.setVolume(clampedVolume)
      val session = PcmPlayerSession(
        playerId = playerId,
        bufferId = audioBufferId,
        sampleRate = sr,
        channels = ch,
        track = track,
        offlineEntry = offlineEntry,
        liveEntry = liveEntry,
      )

      // Wire up the onEnded callback to emit events to JS
      session.onEnded = {
        onPlayerEnded?.invoke(session.playerId, session.bufferId)
      }

      registry.put(session)
      track.play()

      if (liveEntry != null) {
        session.startLiveDrain()
      } else if (offlineEntry != null) {
        session.startOfflineDrain()
      }

      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to create PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_INVALID_CONFIG", "Failed to create PCM player: ${e.message}", e)
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

  fun seekToMs(playerId: String, positionMs: Double, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    try {
      val sampleIndex = ((positionMs / 1000.0) * session.sampleRate).toLong().coerceAtLeast(0)

      // Validate seek range for live buffers
      val live = session.liveEntry
      if (live != null) {
        val oldest = live.oldestAvailablePos()
        val newest = live.totalSamplesWritten
        if (sampleIndex < oldest || sampleIndex > newest) {
          promise.reject("PCM_PLAYER_SEEK_OUT_OF_RANGE",
            "Seek position $positionMs ms (sample $sampleIndex) is outside available range [$oldest, $newest]")
          return
        }
      }

      // Validate seek range for offline buffers
      val offline = session.offlineEntry
      if (offline != null && sampleIndex > offline.numSamples) {
        // Clamp to end rather than reject for offline
        if (!session.seekToSample(offline.numSamples.toLong())) {
          promise.reject("PCM_PLAYER_ERROR", "Seek failed for player: $playerId")
          return
        }
        promise.resolve(null)
        return
      }

      if (!session.seekToSample(sampleIndex)) {
        promise.reject("PCM_PLAYER_ERROR", "Seek failed for player: $playerId")
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to seek PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to seek PCM player: ${e.message}", e)
    }
  }

  fun restart(playerId: String, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    try {
      val startPos = if (session.liveEntry != null) {
        session.liveEntry.oldestAvailablePos()
      } else {
        0L
      }
      if (!session.seekToSample(startPos)) {
        promise.reject("PCM_PLAYER_ERROR", "Restart failed for player: $playerId")
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to restart PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to restart PCM player: ${e.message}", e)
    }
  }

  fun getPositionMs(playerId: String, promise: Promise) {
    val session = registry[playerId] ?: return rejectNotFound(playerId, promise)
    if (session.destroyed) return rejectDestroyed(playerId, promise)
    try {
      promise.resolve(session.getPositionMs())
    } catch (e: Exception) {
      Log.e(TAG, "Failed to get position for PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to get position: ${e.message}", e)
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
