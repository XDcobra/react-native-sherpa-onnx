package com.sherpaonnx.pcm

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.session.PaAudioSessionCoordinator

internal class PcmPlayerService(
  private val context: Context,
) {
  private val registry = PcmPlayerRegistry()
  private val audioManager: AudioManager by lazy {
    context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  }

  /** Callback to emit pcmPlayerEnded events to JS. Set by the module. */
  var onPlayerEnded: ((playerId: String, bufferId: String) -> Unit)? = null

  fun create(
    playerId: String,
    audioBufferId: String,
    volume: Double,
    promise: Promise
  ) {
    var intentId: String? = null
    var intentAcquired = false
    var createdTrack: AudioTrack? = null
    var createdSession: PcmPlayerSession? = null
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
      createdTrack = track

      // Replace an existing player with the same ID to avoid leaking native resources.
      registry.remove(playerId)?.destroy()

      track.setVolume(clampedVolume)

      intentId = "pcm:$playerId"
      // Register PCM player intent with coordinator and apply preferred device
      PaAudioSessionCoordinator.acquireIntent(
        PaAudioSessionCoordinator.Intent(ownerId = intentId, needsInput = false, needsOutput = true)
      )
      intentAcquired = true
      PaAudioSessionCoordinator.applyPreferredDevice(track)

      val session = PcmPlayerSession(
        playerId = playerId,
        bufferId = audioBufferId,
        sampleRate = sr,
        channels = ch,
        track = track,
        offlineEntry = offlineEntry,
        liveEntry = liveEntry,
      )
      createdSession = session
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
      try {
        createdSession?.destroy()
        createdTrack?.let { PaAudioSessionCoordinator.unregisterTrack(it) }
      } catch (_: Exception) {
      } finally {
        if (intentAcquired) {
          intentId?.let { PaAudioSessionCoordinator.releaseIntent(it) }
        }
      }
      Log.e(TAG, "Failed to create PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_INVALID_CONFIG", "Failed to create PCM player: ${e.message}", e)
    }
  }

  fun listAvailableOutputDevices(promise: Promise) {
    try {
      val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
      } else {
        emptyList()
      }

      val routedDeviceId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        registry.snapshotSessions().firstNotNullOfOrNull { session ->
          session.track.routedDevice?.id
        }
      } else {
        null
      }

      val defaultOutputId = devices.firstOrNull { isDefaultOutputDevice(it) }?.id
        ?: devices.firstOrNull()?.id
      val selectedOutputId = routedDeviceId ?: defaultOutputId

      val out = Arguments.createArray()
      for (device in devices) {
        val map = Arguments.createMap()
        map.putString("id", device.id.toString())
        map.putString("name", device.productName?.toString() ?: "Output ${device.id}")
        map.putString("kind", normalizeOutputKind(device.type))
        map.putBoolean("selected", selectedOutputId != null && device.id == selectedOutputId)
        map.putBoolean("default", isDefaultOutputDevice(device))
        map.putBoolean("canSelect", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
        out.pushMap(map)
      }

      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("PCM_PLAYER_ERROR", "Failed to list output devices: ${e.message}", e)
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
      PaAudioSessionCoordinator.unregisterTrack(session.track)
      PaAudioSessionCoordinator.releaseIntent("pcm:$playerId")
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to destroy PCM player: $playerId", e)
      promise.reject("PCM_PLAYER_ERROR", "Failed to destroy PCM player: ${e.message}", e)
    }
  }

  fun shutdown() {
    val playerIds = registry.keys.toList()
    for (playerId in playerIds) {
      val session = registry.remove(playerId) ?: continue
      try {
        session.destroy()
      } catch (e: Exception) {
        Log.e(TAG, "Failed to destroy PCM player during shutdown: $playerId", e)
      } finally {
        PaAudioSessionCoordinator.unregisterTrack(session.track)
        PaAudioSessionCoordinator.releaseIntent("pcm:$playerId")
      }
    }
  }

  private fun findOutputDeviceById(deviceId: Int): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    return audioManager
      .getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .firstOrNull { it.id == deviceId }
  }

  private fun isDefaultOutputDevice(device: AudioDeviceInfo): Boolean {
    return when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> true
      else -> false
    }
  }

  private fun normalizeOutputKind(type: Int): String {
    return when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "built_in_speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "built_in_receiver"
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "built_in_speaker"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth"
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
      AudioDeviceInfo.TYPE_HDMI,
      AudioDeviceInfo.TYPE_HDMI_ARC,
      AudioDeviceInfo.TYPE_HDMI_EARC -> "hdmi"
      AudioDeviceInfo.TYPE_LINE_ANALOG,
      AudioDeviceInfo.TYPE_LINE_DIGITAL -> "line"
      AudioDeviceInfo.TYPE_DOCK -> "dock"
      AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
      AudioDeviceInfo.TYPE_HEARING_AID -> "hearing_aid"
      AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "remote_submix"
      else -> "unknown"
    }
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
