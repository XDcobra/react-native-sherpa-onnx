package com.sherpaonnx.tts.config

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.sherpaonnx.tts.core.TtsEngineInstance

/** ReadableMap option helpers for TTS generation. */
internal object TtsGenerationOptionsParser {
  /** Parse sid and speed from options with defaults. */
  fun getSid(options: ReadableMap?): Int =
    if (options != null && options.hasKey("sid")) options.getDouble("sid").toInt() else 0

  fun getSpeed(options: ReadableMap?): Float =
    if (options != null && options.hasKey("speed")) options.getDouble("speed").toFloat() else 1.0f

  fun hasNumSteps(options: ReadableMap?): Boolean =
    options != null && options.hasKey("numSteps") && !options.isNull("numSteps")

  fun getNumSteps(options: ReadableMap?, default: Int = 5): Int =
    if (hasNumSteps(options)) options!!.getDouble("numSteps").toInt() else default

  fun getSilenceScale(options: ReadableMap?, default: Float = 0.2f): Float =
    if (options != null && options.hasKey("silenceScale") && !options.isNull("silenceScale")) {
      options.getDouble("silenceScale").toFloat()
    } else {
      default
    }

  fun hasVoiceCloneBuffer(options: ReadableMap?): Boolean {
    if (options == null) return false
    return options.hasKey("referenceAudioBufferId") &&
      !options.isNull("referenceAudioBufferId") &&
      (options.getString("referenceAudioBufferId")?.isNotEmpty() == true)
  }

  fun supportsNumSteps(inst: TtsEngineInstance): Boolean {
    val modelType = inst.ttsInitState?.modelType ?: return false
    return modelType == "supertonic" || modelType == "zipvoice" || modelType == "pocket"
  }

  fun requiresVoiceCloneForNumSteps(inst: TtsEngineInstance): Boolean =
    inst.isZipvoice || inst.isPocket

  /**
   * Reject when numSteps is set but the model does not honor it, or Zipvoice/Pocket lack
   * reference audio. Returns true when the promise was rejected.
   */
  fun rejectNumStepsIfInvalid(
    inst: TtsEngineInstance,
    options: ReadableMap?,
    promise: Promise,
    errorCode: String,
  ): Boolean {
    if (!hasNumSteps(options)) return false
    val modelType = inst.ttsInitState?.modelType ?: "unknown"
    if (!supportsNumSteps(inst)) {
      Log.e("SherpaOnnxTts", "$errorCode: numSteps unsupported for modelType=$modelType")
      promise.reject(
        "TTS_NUM_STEPS_UNSUPPORTED",
        "numSteps is not supported for model type \"$modelType\". Supported: supertonic, zipvoice, pocket."
      )
      return true
    }
    if (requiresVoiceCloneForNumSteps(inst) && !hasVoiceCloneBuffer(options)) {
      Log.e("SherpaOnnxTts", "$errorCode: numSteps requires voice clone for modelType=$modelType")
      promise.reject(
        "TTS_NUM_STEPS_REQUIRES_VOICE_CLONE",
        "numSteps for \"$modelType\" requires voiceClone.referenceAudio (referenceAudioBufferId)."
      )
      return true
    }
    return false
  }

  /** Non-clone GenerationConfig when numSteps and/or extra/lang are present. */
  fun buildNonCloneGenerationConfig(
    options: ReadableMap?,
    sid: Int,
    speed: Float,
  ): GenerationConfig {
    val extraMap = buildExtraMap(options)
    return if (hasNumSteps(options)) {
      GenerationConfig(
        speed = speed,
        sid = sid,
        numSteps = getNumSteps(options),
        extra = extraMap,
      )
    } else {
      GenerationConfig(
        speed = speed,
        sid = sid,
        extra = extraMap,
      )
    }
  }

  /** Merge `extra` map; top-level `lang` wins over `extra.lang`. */
  fun buildExtraMap(options: ReadableMap?): Map<String, String>? {
    if (options == null) return null
    val out = linkedMapOf<String, String>()
    if (options.hasKey("extra") && !options.isNull("extra")) {
      val map = options.getMap("extra") ?: return null
      val it = map.keySetIterator()
      while (it.hasNextKey()) {
        val k = it.nextKey()
        map.getString(k)?.let { v -> out[k] = v }
      }
    }
    if (options.hasKey("lang") && !options.isNull("lang")) {
      options.getString("lang")?.trim()?.takeIf { it.isNotEmpty() }?.let { out["lang"] = it }
    }
    return out.takeIf { it.isNotEmpty() }
  }
}
