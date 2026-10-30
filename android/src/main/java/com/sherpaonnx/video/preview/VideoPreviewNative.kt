package com.sherpaonnx.video.preview

import android.view.Surface

internal object VideoPreviewNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  external fun nativeCreate(bufferId: String, optionsJson: String): HashMap<String, Any>?

  external fun nativeCommand(playerId: String, command: String, arg: String): HashMap<String, Any>?

  external fun nativeSeek(
    playerId: String,
    positionMs: Long,
    mode: String,
    relative: Boolean,
  ): HashMap<String, Any>?

  external fun nativeSetVolume(playerId: String, volume: Float)

  external fun nativeSetMuted(playerId: String, muted: Boolean)

  external fun nativeSetLoop(playerId: String, loop: Boolean)

  external fun nativeSnapshot(playerId: String): String

  external fun nativeRelease(playerId: String): Boolean

  external fun nativeAttachSurface(playerId: String, surface: Surface, refreshHz: Double)

  external fun nativeDetachSurface(playerId: String)

  external fun nativeSetRefreshRate(playerId: String, hz: Double)

  external fun nativeBindAudioTrack(playerId: String, track: VideoPreviewAudioTrack)

  external fun nativeAppLifecycle(background: Boolean)
}
