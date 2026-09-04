package com.sherpaonnx.segment.core

import java.util.UUID

/**
 * Thin Kotlin facade over shared-C++ [PyannoteSegmentationSession] for the
 * offline `speech_pyannote_segmentation` evaluator.
 */
class PyannoteSegmentationRuntime private constructor(
  private val instanceId: String,
) : AutoCloseable {
  data class Span(
    val startSec: Float,
    val endSec: Float,
  )

  data class Options(
    val modelPath: String,
    val windowShiftRatio: Float = 0.1f,
    val minDurationOn: Float = 0.3f,
    val minDurationOff: Float = 0.5f,
    val numThreads: Int = 1,
  )

  fun process(samples: FloatArray, sampleRate: Int): List<Span> {
    @Suppress("UNCHECKED_CAST")
    val result = nativeProcess(instanceId, samples, sampleRate) as? Map<String, Any?>
      ?: throw IllegalStateException("pyannote process returned null")
    val ok = result["ok"] as? Boolean ?: false
    if (!ok) {
      val error = (result["error"] as? String)?.trim().orEmpty()
      throw IllegalStateException(
        if (error.isNotEmpty()) error else "pyannote process failed",
      )
    }
    val rawSpans = result["spans"] as? List<*> ?: emptyList<Any>()
    return rawSpans.mapNotNull { item ->
      val map = item as? Map<*, *> ?: return@mapNotNull null
      val start = (map["start"] as? Number)?.toFloat() ?: return@mapNotNull null
      val end = (map["end"] as? Number)?.toFloat() ?: return@mapNotNull null
      if (end <= start) return@mapNotNull null
      Span(startSec = start, endSec = end)
    }
  }

  override fun close() {
    nativeRelease(instanceId)
  }

  companion object {
    fun create(options: Options): PyannoteSegmentationRuntime {
      val instanceId = "pyannote_seg_${UUID.randomUUID()}"
      @Suppress("UNCHECKED_CAST")
      val result = nativeCreate(
        instanceId,
        options.modelPath,
        options.windowShiftRatio,
        options.minDurationOn,
        options.minDurationOff,
        options.numThreads,
      ) as? Map<String, Any?>
        ?: throw IllegalStateException("pyannote create returned null")
      val ok = result["ok"] as? Boolean ?: false
      if (!ok) {
        val error = (result["error"] as? String)?.trim().orEmpty()
        throw IllegalStateException(
          if (error.isNotEmpty()) error else "pyannote create failed",
        )
      }
      return PyannoteSegmentationRuntime(instanceId)
    }

    @JvmStatic
    private external fun nativeCreate(
      instanceId: String,
      modelPath: String,
      windowShiftRatio: Float,
      minDurationOn: Float,
      minDurationOff: Float,
      numThreads: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeProcess(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeRelease(instanceId: String)
  }
}
