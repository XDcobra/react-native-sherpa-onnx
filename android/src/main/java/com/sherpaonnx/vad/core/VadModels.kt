package com.sherpaonnx.vad.core

import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.TenVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig

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

data class VadDecision(
  val isSpeech: Boolean,
  val score: Double? = null,
)

interface VadRuntime {
  fun infer(chunk: FloatArray, sampleRate: Int): VadDecision
  fun reset()
  fun close()
}

class SherpaOnnxVadRuntime(
  private val vad: Vad,
  private val options: VadRuntimeOptions,
) : VadRuntime {
  @Synchronized
  override fun infer(chunk: FloatArray, sampleRate: Int): VadDecision {
    if (chunk.isEmpty()) return VadDecision(isSpeech = false, score = 0.0)
    val score = vad.compute(chunk).toDouble()
    return VadDecision(isSpeech = score >= options.scoreThreshold, score = score)
  }

  @Synchronized
  override fun reset() {
    vad.reset()
    vad.clear()
  }

  @Synchronized
  override fun close() {
    vad.release()
  }
}

data class VadInstanceConfig(
  val modelType: String,
  val modelDir: String,
  val sampleRate: Int,
  val provider: String,
  val numThreads: Int,
  val debug: Boolean,
  val runtimeOptions: VadRuntimeOptions,
  val runtime: VadRuntime,
)

fun buildVadModelConfig(
  modelType: String,
  modelPath: String,
  sampleRate: Int,
  provider: String,
  numThreads: Int,
  debug: Boolean,
  runtimeOptions: VadRuntimeOptions,
): VadModelConfig {
  val silero = when (runtimeOptions) {
    is VadRuntimeOptions.Silero -> SileroVadModelConfig(
      model = modelPath,
      threshold = runtimeOptions.scoreThreshold.toFloat(),
      minSilenceDuration = runtimeOptions.minSilenceDurationMs / 1000f,
      minSpeechDuration = runtimeOptions.minSpeechDurationMs / 1000f,
      windowSize = runtimeOptions.windowSize,
      maxSpeechDuration = runtimeOptions.maxSpeechDurationMs / 1000f,
    )
    else -> SileroVadModelConfig(model = modelPath)
  }
  val ten = when (runtimeOptions) {
    is VadRuntimeOptions.Ten -> TenVadModelConfig(
      model = modelPath,
      threshold = runtimeOptions.scoreThreshold.toFloat(),
      minSilenceDuration = runtimeOptions.minSilenceDurationMs / 1000f,
      minSpeechDuration = runtimeOptions.minSpeechDurationMs / 1000f,
      windowSize = runtimeOptions.windowSize,
      maxSpeechDuration = runtimeOptions.maxSpeechDurationMs / 1000f,
    )
    else -> TenVadModelConfig(model = modelPath)
  }
  return VadModelConfig(
    sileroVadModelConfig = silero,
    tenVadModelConfig = ten,
    sampleRate = sampleRate,
    numThreads = numThreads,
    provider = provider,
    debug = debug,
  )
}

fun createVadRuntime(
  modelType: String,
  modelPath: String,
  sampleRate: Int,
  provider: String,
  numThreads: Int,
  debug: Boolean,
  runtimeOptions: VadRuntimeOptions,
): VadRuntime {
  val config = buildVadModelConfig(
    modelType = modelType,
    modelPath = modelPath,
    sampleRate = sampleRate,
    provider = provider,
    numThreads = numThreads,
    debug = debug,
    runtimeOptions = runtimeOptions,
  )
  return SherpaOnnxVadRuntime(vad = Vad(assetManager = null, config = config), options = runtimeOptions)
}

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
