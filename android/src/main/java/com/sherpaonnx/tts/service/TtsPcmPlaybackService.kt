package com.sherpaonnx.tts.service

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.sherpaonnx.tts.core.TtsEngineRepository

internal class TtsPcmPlaybackService(
  private val repository: TtsEngineRepository
) {
  fun startTtsPcmPlayer(instanceId: String, sampleRate: Double, channels: Double, promise: Promise) {
    val inst = repository[instanceId] ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_PCM_ERROR", "TTS instance not found: $instanceId")
      return
    }
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM playback requires API 21+")
        promise.reject("TTS_PCM_ERROR", "PCM playback requires API 21+")
        return
      }
      if (channels.toInt() != 1) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM playback supports mono only")
        promise.reject("TTS_PCM_ERROR", "PCM playback supports mono only")
        return
      }
      inst.stopPcmPlayer()
      val channelConfig = AudioFormat.CHANNEL_OUT_MONO
      val audioFormat = AudioFormat.Builder()
        .setSampleRate(sampleRate.toInt())
        .setChannelMask(channelConfig)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
        .build()
      val minBufferSize = AudioTrack.getMinBufferSize(sampleRate.toInt(), channelConfig, AudioFormat.ENCODING_PCM_FLOAT)
      if (minBufferSize == AudioTrack.ERROR || minBufferSize == AudioTrack.ERROR_BAD_VALUE) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Invalid buffer size for PCM player")
        promise.reject("TTS_PCM_ERROR", "Invalid buffer size for PCM player")
        return
      }
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      inst.ttsPcmTrack = AudioTrack(attributes, audioFormat, minBufferSize, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
      inst.ttsPcmTrack?.play()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to start PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to start PCM player", e)
    }
  }

  fun writeTtsPcmChunk(instanceId: String, samples: ReadableArray, promise: Promise) {
    val inst = repository[instanceId] ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: TTS instance not found: $instanceId")
      promise.reject("TTS_PCM_ERROR", "TTS instance not found: $instanceId")
      return
    }
    val track = inst.ttsPcmTrack ?: run {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM player not initialized")
      promise.reject("TTS_PCM_ERROR", "PCM player not initialized")
      return
    }
    try {
      val buffer = FloatArray(samples.size())
      for (i in 0 until samples.size()) {
        buffer[i] = samples.getDouble(i).toFloat()
      }
      val written = track.write(buffer, 0, buffer.size, AudioTrack.WRITE_BLOCKING)
      if (written < 0) {
        Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: PCM write failed: $written")
        promise.reject("TTS_PCM_ERROR", "PCM write failed: $written")
        return
      }
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to write PCM chunk", e)
      promise.reject("TTS_PCM_ERROR", "Failed to write PCM chunk", e)
    }
  }

  fun stopTtsPcmPlayer(instanceId: String, promise: Promise) {
    try {
      repository[instanceId]?.stopPcmPlayer()
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_PCM_ERROR: Failed to stop PCM player", e)
      promise.reject("TTS_PCM_ERROR", "Failed to stop PCM player", e)
    }
  }
}
