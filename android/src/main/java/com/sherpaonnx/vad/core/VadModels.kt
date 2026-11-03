package com.sherpaonnx.vad.core

import com.sherpaonnx.vad.facade.SherpaOnnxVadHelper

sealed class VadRuntimeOptions {
  abstract val scoreThreshold: Double
  abstract val minSpeechDurationMs: Int
  abstract val minSilenceDurationMs: Int
  abstract val windowSize: Int
  abstract val maxSpeechDurationMs: Int

  data class Silero(
    override val scoreThreshold: Double,
    override val minSpeechDurationMs: Int,
    override val minSilenceDurationMs: Int,
    override val windowSize: Int,
    override val maxSpeechDurationMs: Int,
  ) : VadRuntimeOptions()

  data class Ten(
    override val scoreThreshold: Double,
    override val minSpeechDurationMs: Int,
    override val minSilenceDurationMs: Int,
    override val windowSize: Int,
    override val maxSpeechDurationMs: Int,
  ) : VadRuntimeOptions()
}

data class VadSegment(
  val startSample: Int,
  val endSample: Int,
  val durationMs: Int,
)

/**
 * JNI-backed VAD engine (shared C API AcceptWaveform / Flush / Front / Pop).
 * No Kotlin AAR handle.
 */
interface VadRuntime {
  fun acceptWaveform(chunk: FloatArray)
  fun flush()
  fun reset()
  fun isSpeechDetected(): Boolean
  fun popSegments(): List<VadSegment>
  fun close()
}

data class VadInstanceConfig(
  val instanceId: String,
  val modelType: String,
  val modelDir: String,
  val sampleRate: Int,
  val provider: String,
  val numThreads: Int,
  val debug: Boolean,
  val runtimeOptions: VadRuntimeOptions,
  val runtime: VadRuntime,
) {
  fun gateKey(): String = "vad:$instanceId"
}

/** Create a JNI-backed VAD runtime (shared C API). Used by segmentation engines. */
fun createVadRuntime(
  modelType: String,
  modelPath: String,
  sampleRate: Int,
  provider: String,
  numThreads: Int,
  debug: Boolean,
  runtimeOptions: VadRuntimeOptions,
): VadRuntime =
  SherpaOnnxVadHelper.createVadRuntime(
    modelType = modelType,
    modelPath = modelPath,
    sampleRate = sampleRate,
    provider = provider,
    numThreads = numThreads,
    debug = debug,
    runtimeOptions = runtimeOptions,
  )

fun defaultRuntimeOptions(modelType: String): VadRuntimeOptions {
  return if (modelType == "ten_vad") {
    VadRuntimeOptions.Ten(
      scoreThreshold = 0.5,
      minSpeechDurationMs = 250,
      minSilenceDurationMs = 250,
      windowSize = 256,
      maxSpeechDurationMs = 5000,
    )
  } else {
    VadRuntimeOptions.Silero(
      scoreThreshold = 0.5,
      minSpeechDurationMs = 250,
      minSilenceDurationMs = 250,
      windowSize = 512,
      maxSpeechDurationMs = 5000,
    )
  }
}

fun withRuntimeOverrides(
  base: VadRuntimeOptions,
  scoreThreshold: Double?,
  minSpeechDurationMs: Int,
  minSilenceDurationMs: Int,
  windowSize: Int?,
  maxSpeechDurationMs: Int?,
): VadRuntimeOptions {
  val nextScore = scoreThreshold ?: base.scoreThreshold
  val nextSpeech = minSpeechDurationMs
  val nextSilence = minSilenceDurationMs
  val nextWindow = windowSize ?: base.windowSize
  val nextMaxSpeech = maxSpeechDurationMs ?: base.maxSpeechDurationMs
  return when (base) {
    is VadRuntimeOptions.Silero -> base.copy(
      scoreThreshold = nextScore,
      minSpeechDurationMs = nextSpeech,
      minSilenceDurationMs = nextSilence,
      windowSize = nextWindow,
      maxSpeechDurationMs = nextMaxSpeech,
    )
    is VadRuntimeOptions.Ten -> base.copy(
      scoreThreshold = nextScore,
      minSpeechDurationMs = nextSpeech,
      minSilenceDurationMs = nextSilence,
      windowSize = nextWindow,
      maxSpeechDurationMs = nextMaxSpeech,
    )
  }
}

data class VadSummary(
  val chunksProcessed: Long,
  val unitsRead: Long,
  val unitsWritten: Long,
  val segmentCount: Int,
  val speechDurationMs: Long,
)
