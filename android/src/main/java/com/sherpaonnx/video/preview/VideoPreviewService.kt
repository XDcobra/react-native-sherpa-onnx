package com.sherpaonnx.video.preview

import android.content.Context
import android.media.AudioManager
import android.util.Log
import android.view.Surface
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.audio.session.PaAudioSessionCoordinator
import com.sherpaonnx.video.VideoBufferService
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

internal object VideoPreviewService : LifecycleEventListener {
  private const val TAG = "SherpaOnnx:video.preview"
  private val audioTracks = ConcurrentHashMap<String, VideoPreviewAudioTrack>()
  @Volatile private var reactContext: ReactApplicationContext? = null
  @Volatile private var focusRemove: (() -> Unit)? = null
  @Volatile private var lifecycleInstalled = false

  fun ensure(context: Context) {
    VideoBufferService.ensureInitialized(context)
    if (context is ReactApplicationContext) {
      reactContext = context
      if (!lifecycleInstalled) {
        context.addLifecycleEventListener(this)
        lifecycleInstalled = true
      }
    }
    if (focusRemove == null) {
      focusRemove = PaAudioSessionCoordinator.addFocusListener { change ->
        val reason = when (change) {
          AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "focusLoss"
          else -> null
        }
        if (reason != null) {
          for (id in audioTracks.keys) {
            VideoPreviewNative.nativeCommand(id, "audioInterrupted", reason)
          }
        } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
          for (t in audioTracks.values) t.setDuck(0.2f)
        } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
          for (t in audioTracks.values) t.setDuck(1f)
        }
      }
    }
  }

  fun create(bufferId: String, options: ReadableMap?): WritableMap {
    val json = optionsToJson(options)
    val raw = VideoPreviewNative.nativeCreate(bufferId, json) ?: emptyMap()
    val err = raw["errorCode"] as? String
    if (!err.isNullOrEmpty()) {
      return errorMap(err, raw["message"] as? String ?: err)
    }
    val playerId = raw["playerId"] as? String ?: ""
    if (raw["audioPlayable"] == "true") {
      val sr = (raw["audioSampleRate"] as? String)?.toIntOrNull() ?: 48000
      val ch = (raw["audioChannels"] as? String)?.toIntOrNull() ?: 2
      val track = VideoPreviewAudioTrack(playerId, sr, ch)
      audioTracks[playerId] = track
      VideoPreviewNative.nativeBindAudioTrack(playerId, track)
    }
    return snapshotFromRaw(raw)
  }

  fun command(playerId: String, command: String, arg: String = ""): WritableMap {
    val raw = VideoPreviewNative.nativeCommand(playerId, command, arg) ?: emptyMap()
    return snapshotFromRaw(raw)
  }

  fun seek(playerId: String, positionMs: Double, mode: String, relative: Boolean): WritableMap {
    val raw = VideoPreviewNative.nativeSeek(playerId, positionMs.toLong(), mode, relative) ?: emptyMap()
    val map = Arguments.createMap()
    val err = raw["errorCode"] as? String
    if (!err.isNullOrEmpty()) {
      map.putString("errorCode", err)
      map.putString("message", raw["message"] as? String ?: err)
      return map
    }
    map.putString("status", raw["status"] as? String ?: "completed")
    map.putDouble("requestedMs", (raw["requestedMs"] as? String)?.toDoubleOrNull() ?: positionMs)
    map.putDouble("actualMs", (raw["actualMs"] as? String)?.toDoubleOrNull() ?: positionMs)
    return map
  }

  fun setVolume(playerId: String, volume: Double) {
    VideoPreviewNative.nativeSetVolume(playerId, volume.toFloat())
  }

  fun setMuted(playerId: String, muted: Boolean) {
    VideoPreviewNative.nativeSetMuted(playerId, muted)
  }

  fun setLoop(playerId: String, loop: Boolean) {
    VideoPreviewNative.nativeSetLoop(playerId, loop)
  }

  fun snapshot(playerId: String): WritableMap {
    val json = VideoPreviewNative.nativeSnapshot(playerId)
    return jsonToMap(json)
  }

  fun release(playerId: String) {
    audioTracks.remove(playerId)?.release()
    VideoPreviewNative.nativeRelease(playerId)
  }

  fun attachSurface(playerId: String, surface: Surface, refreshHz: Double) {
    VideoPreviewNative.nativeAttachSurface(playerId, surface, refreshHz)
  }

  fun detachSurface(playerId: String) {
    VideoPreviewNative.nativeDetachSurface(playerId)
  }

  fun setRefreshRate(playerId: String, hz: Double) {
    VideoPreviewNative.nativeSetRefreshRate(playerId, hz)
  }

  override fun onHostResume() {
    VideoPreviewNative.nativeAppLifecycle(false)
  }

  override fun onHostPause() {
    VideoPreviewNative.nativeAppLifecycle(true)
  }

  override fun onHostDestroy() {}

  private fun optionsToJson(options: ReadableMap?): String {
    if (options == null) return "{}"
    return try {
      JSONObject(options.toHashMap()).toString()
    } catch (e: Exception) {
      Log.w(TAG, "options json: ${e.message}")
      "{}"
    }
  }

  private fun snapshotFromRaw(raw: Map<String, Any>): WritableMap {
    val err = raw["errorCode"] as? String
    if (!err.isNullOrEmpty()) return errorMap(err, raw["message"] as? String ?: err)
    val json = raw["snapshotJson"] as? String
    if (!json.isNullOrEmpty()) return jsonToMap(json)
    val map = Arguments.createMap()
    map.putString("playerId", raw["playerId"] as? String ?: "")
    map.putString("bufferId", raw["bufferId"] as? String ?: "")
    return map
  }

  private fun errorMap(code: String, message: String): WritableMap {
    val map = Arguments.createMap()
    map.putString("errorCode", code)
    map.putString("message", message)
    return map
  }

  fun jsonToMap(json: String): WritableMap {
    val map = Arguments.createMap()
    return try {
      putJson(map, JSONObject(json))
      map
    } catch (e: Exception) {
      map.putString("errorCode", "VIDEO_PREVIEW_INVALID_STATE")
      map.putString("message", e.message ?: json)
      map
    }
  }

  private fun putJson(map: com.facebook.react.bridge.WritableMap, obj: JSONObject): com.facebook.react.bridge.WritableMap {
    val keys = obj.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      when (val v = obj.get(k)) {
        JSONObject.NULL -> map.putNull(k)
        is Boolean -> map.putBoolean(k, v)
        is Int -> map.putInt(k, v)
        is Long -> map.putDouble(k, v.toDouble())
        is Double -> map.putDouble(k, v)
        is JSONObject -> {
          val child = Arguments.createMap()
          putJson(child, v)
          map.putMap(k, child)
        }
        else -> map.putString(k, v.toString())
      }
    }
    return map
  }
}
