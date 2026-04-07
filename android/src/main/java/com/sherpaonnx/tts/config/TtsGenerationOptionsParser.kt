package com.sherpaonnx.tts.config

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.sherpaonnx.SubtitleTimingItem

/**
 * ReadableMap options and subtitle helpers for TTS generation.
 */
internal object TtsGenerationOptionsParser {
  /**
   * True when voice-cloning reference audio is present and valid for native use:
   * non-empty [referenceAudio] array and [referenceSampleRate] > 0.
   * [referenceText] alone does not enable cloning (matches sherpa-onnx behavior).
   */
  fun hasReferenceAudio(options: ReadableMap?): Boolean {
    if (options == null) return false
    val refAudio = options.getArray("referenceAudio") ?: return false
    if (refAudio.size() == 0) return false
    return readReferenceSampleRate(options) > 0
  }

  fun readReferenceSampleRate(options: ReadableMap): Int =
    if (options.hasKey("referenceSampleRate")) options.getDouble("referenceSampleRate").toInt() else 0

  /** Parse sid and speed from options with defaults. */
  fun getSid(options: ReadableMap?): Int =
    if (options != null && options.hasKey("sid")) options.getDouble("sid").toInt() else 0

  fun getSpeed(options: ReadableMap?): Float =
    if (options != null && options.hasKey("speed")) options.getDouble("speed").toFloat() else 1.0f

  fun getSubtitleMode(options: ReadableMap?): String {
    val raw = options?.getString("subtitleMode")?.trim()?.lowercase()
    return when (raw) {
      "off", "proportional", "estimated", "accurate" -> raw
      else -> "proportional"
    }
  }

  fun isExportChunkTimelineOnly(options: ReadableMap?): Boolean =
    options != null && options.hasKey("exportChunkTimelineOnly") && options.getBoolean("exportChunkTimelineOnly")

  fun getSubtitleGranularity(options: ReadableMap?): String {
    val raw = options?.getString("subtitleGranularity")?.trim()?.lowercase()
    return when (raw) {
      "word", "sentence" -> raw
      else -> "sentence"
    }
  }

  fun isCharacterGranularityRequested(options: ReadableMap?): Boolean {
    val raw = options?.getString("subtitleGranularity")?.trim()?.lowercase()
    return raw == "character"
  }

  fun toSubtitleWritableArray(items: List<SubtitleTimingItem>): WritableArray = Arguments.createArray().apply {
    for (item in items) {
      val subtitleMap = Arguments.createMap()
      subtitleMap.putString("text", item.text)
      subtitleMap.putDouble("start", item.start)
      subtitleMap.putDouble("end", item.end)
      pushMap(subtitleMap)
    }
  }

  /** Build Kotlin GenerationConfig from ReadableMap. Returns null only when options is null. */
  fun parseGenerationConfig(options: ReadableMap?): GenerationConfig? {
    if (options == null) return null
    val refAudio = options.getArray("referenceAudio")
    val refSampleRate = if (options.hasKey("referenceSampleRate")) options.getDouble("referenceSampleRate").toInt() else 0
    val refText = options.getString("referenceText")
    val silenceScale = if (options.hasKey("silenceScale")) options.getDouble("silenceScale").toFloat() else 0.2f
    val speed = getSpeed(options)
    val sid = getSid(options)
    val numSteps = if (options.hasKey("numSteps")) options.getDouble("numSteps").toInt() else 5
    val extraMap = options.getMap("extra")?.let { map ->
      val it = map.keySetIterator()
      buildMap<String, String> {
        while (it.hasNextKey()) {
          val k = it.nextKey()
          put(k, map.getString(k).orEmpty())
        }
      }
    }
    val refAudioFloat = refAudio?.let { arr ->
      FloatArray(arr.size()) { i -> arr.getDouble(i).toFloat() }
    }
    return GenerationConfig(
      silenceScale = silenceScale,
      speed = speed,
      sid = sid,
      referenceAudio = refAudioFloat,
      referenceSampleRate = refSampleRate,
      referenceText = refText,
      numSteps = numSteps,
      extra = extraMap
    )
  }
}
