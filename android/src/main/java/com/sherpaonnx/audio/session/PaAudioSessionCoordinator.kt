package com.sherpaonnx.audio.session

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.lang.ref.WeakReference

/**
 * Centralized audio session / routing policy coordinator for Android.
 *
 * Manages:
 * - Owner registry (mic / PCM players) with intent-based lifecycle
 * - Global route preference applied to all active AudioRecord / AudioTrack instances
 * - AudioFocus acquisition / release keyed to owner count
 * - Device change listener for re-applying preferences on connect/disconnect
 * - State snapshot mirroring the iOS coordinator shape for cross-platform API consistency
 */
object PaAudioSessionCoordinator {

  private const val TAG = "PaAudioSessionCoord"

  // ── Types ───────────────────────────────────────────────────────────────

  data class Intent(
    val ownerId: String,
    val needsInput: Boolean,
    val needsOutput: Boolean,
  )

  enum class Profile { INACTIVE, PLAYBACK, DUPLEX }

  // ── State ───────────────────────────────────────────────────────────────

  private val lock = Any()
  private val owners = mutableMapOf<String, Intent>()

  // Policy
  @Volatile var keepActiveWhenIdle: Boolean = false
  @Volatile var preferredInputDeviceId: Int? = null
  @Volatile var preferredOutputDeviceId: Int? = null

  // Active tracks/records for route reapplication
  private val activeRecords = mutableListOf<WeakReference<AudioRecord>>()
  private val activeTracks = mutableListOf<WeakReference<AudioTrack>>()

  // AudioFocus
  private var audioManager: AudioManager? = null
  private var holdingFocus: Boolean = false
  private var focusRequest: AudioFocusRequest? = null
  private var initialized = false

  // Device callback
  private var deviceCallback: AudioDeviceCallback? = null

  // ── Lifecycle ─────────────────────────────────────────────────────────

  fun initialize(context: Context) {
    synchronized(lock) {
      if (initialized) return
      initialized = true
      audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val cb = object : AudioDeviceCallback() {
          override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
            reapplyRoutePreferences()
          }
          override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
            reapplyRoutePreferences()
          }
        }
        deviceCallback = cb
        audioManager?.registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
      }
    }
  }

  fun resetAll() {
    synchronized(lock) {
      owners.clear()
      keepActiveWhenIdle = false
      preferredInputDeviceId = null
      preferredOutputDeviceId = null
      activeRecords.clear()
      activeTracks.clear()
      abandonFocusInternal()
    }
  }

  // ── Owner Management ──────────────────────────────────────────────────

  fun acquireIntent(intent: Intent) {
    synchronized(lock) {
      owners[intent.ownerId] = intent
      reconcileInternal()
    }
  }

  fun releaseIntent(ownerId: String) {
    synchronized(lock) {
      owners.remove(ownerId)
      reconcileInternal()
    }
  }

  // ── Policy ────────────────────────────────────────────────────────────

  fun configurePolicy(keepActiveWhenIdle: Boolean) {
    synchronized(lock) {
      this.keepActiveWhenIdle = keepActiveWhenIdle
      reconcileInternal()
    }
  }

  fun setRoutePreference(inputDeviceId: Int?, outputDeviceId: Int?) {
    synchronized(lock) {
      this.preferredInputDeviceId = inputDeviceId
      this.preferredOutputDeviceId = outputDeviceId
      reapplyRoutePreferencesInternal()
    }
  }

  fun clearRoutePreference() {
    synchronized(lock) {
      this.preferredInputDeviceId = null
      this.preferredOutputDeviceId = null
      reapplyRoutePreferencesInternal()
    }
  }

  // ── Track/Record Registration ─────────────────────────────────────────

  fun applyPreferredDevice(record: AudioRecord) {
    synchronized(lock) {
      // Clean stale refs
      activeRecords.removeAll { it.get() == null }
      activeRecords.add(WeakReference(record))

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val prefId = preferredInputDeviceId
        if (prefId != null) {
          val device = findInputDevice(prefId)
          if (device != null) {
            val applied = record.setPreferredDevice(device)
            Log.i(TAG, "Applied preferred input device $prefId to AudioRecord: $applied")
          } else {
            Log.w(TAG, "Preferred input device $prefId not found; using default")
          }
        }
      }
    }
  }

  fun applyPreferredDevice(track: AudioTrack) {
    synchronized(lock) {
      // Clean stale refs
      activeTracks.removeAll { it.get() == null }
      activeTracks.add(WeakReference(track))

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val prefId = preferredOutputDeviceId
        if (prefId != null) {
          val device = findOutputDevice(prefId)
          if (device != null) {
            val applied = track.setPreferredDevice(device)
            Log.i(TAG, "Applied preferred output device $prefId to AudioTrack: $applied")
          } else {
            Log.w(TAG, "Preferred output device $prefId not found; using default")
          }
        }
      }
    }
  }

  fun unregisterRecord(record: AudioRecord) {
    synchronized(lock) {
      activeRecords.removeAll { it.get() == null || it.get() === record }
    }
  }

  fun unregisterTrack(track: AudioTrack) {
    synchronized(lock) {
      activeTracks.removeAll { it.get() == null || it.get() === track }
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  fun stateSnapshot(): Map<String, Any?> {
    synchronized(lock) {
      val profile = computeProfile()
      var micOwners = 0
      var pcmOwners = 0
      for (intent in owners.values) {
        if (intent.needsInput) micOwners++
        if (intent.needsOutput) pcmOwners++
      }

      val active = profile != Profile.INACTIVE || keepActiveWhenIdle
      val profileStr = when (profile) {
        Profile.PLAYBACK -> "playback"
        Profile.DUPLEX -> "duplex"
        Profile.INACTIVE -> "inactive"
      }

      // Determine currently routed devices
      var currentInputId: Any? = null
      var currentOutputId: Any? = null
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        for (ref in activeRecords) {
          val rec = ref.get() ?: continue
          currentInputId = rec.routedDevice?.id
          if (currentInputId != null) break
        }
        for (ref in activeTracks) {
          val trk = ref.get() ?: continue
          currentOutputId = trk.routedDevice?.id
          if (currentOutputId != null) break
        }
      }

      return mapOf(
        "active" to active,
        "profile" to profileStr,
        "activeMicOwners" to micOwners,
        "activePcmOwners" to pcmOwners,
        "preferredInputDeviceId" to preferredInputDeviceId?.toString(),
        "preferredOutputDeviceId" to preferredOutputDeviceId?.toString(),
        "currentInputDeviceId" to currentInputId?.toString(),
        "currentOutputDeviceId" to currentOutputId?.toString(),
      )
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private fun computeProfile(): Profile {
    for (intent in owners.values) {
      if (intent.needsInput) return Profile.DUPLEX
    }
    for (intent in owners.values) {
      if (intent.needsOutput) return Profile.PLAYBACK
    }
    return Profile.INACTIVE
  }

  private fun reconcileInternal() {
    val profile = computeProfile()

    when (profile) {
      Profile.DUPLEX, Profile.PLAYBACK -> {
        if (!holdingFocus) {
          requestFocusInternal()
        }
      }
      Profile.INACTIVE -> {
        if (holdingFocus && !keepActiveWhenIdle) {
          abandonFocusInternal()
        }
      }
    }

    reapplyRoutePreferencesInternal()
  }

  private fun requestFocusInternal() {
    val am = audioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .setOnAudioFocusChangeListener { /* best-effort: log only */ }
        .build()
      focusRequest = req
      val result = am.requestAudioFocus(req)
      holdingFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
      Log.i(TAG, "requestAudioFocus result=$result holdingFocus=$holdingFocus")
    } else {
      @Suppress("DEPRECATION")
      val result = am.requestAudioFocus(
        { /* listener */ },
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN
      )
      holdingFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    }
  }

  private fun abandonFocusInternal() {
    val am = audioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { am.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(null)
    }
    holdingFocus = false
    Log.i(TAG, "abandonAudioFocus")
  }

  private fun reapplyRoutePreferences() {
    synchronized(lock) {
      reapplyRoutePreferencesInternal()
    }
  }

  private fun reapplyRoutePreferencesInternal() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

    val inputPref = preferredInputDeviceId
    val outputPref = preferredOutputDeviceId

    // Clean stale refs
    activeRecords.removeAll { it.get() == null }
    activeTracks.removeAll { it.get() == null }

    if (inputPref != null) {
      val device = findInputDevice(inputPref)
      for (ref in activeRecords) {
        ref.get()?.setPreferredDevice(device)
      }
    }

    if (outputPref != null) {
      val device = findOutputDevice(outputPref)
      for (ref in activeTracks) {
        ref.get()?.setPreferredDevice(device)
      }
    }
  }

  private fun findInputDevice(deviceId: Int): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    return audioManager
      ?.getDevices(AudioManager.GET_DEVICES_INPUTS)
      ?.firstOrNull { it.id == deviceId }
  }

  private fun findOutputDevice(deviceId: Int): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    return audioManager
      ?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      ?.firstOrNull { it.id == deviceId }
  }
}
