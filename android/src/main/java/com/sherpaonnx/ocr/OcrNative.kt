package com.sherpaonnx.ocr

/**
 * JNI facade for C++ OcrEngine / Detect / Cancel.
 * Loaded via [com.sherpaonnx.SherpaOnnxNativeLoader].
 */
internal object OcrNative {
  @Volatile
  var progressListener: ((
    operationId: String,
    done: Int,
    total: Int,
    phase: String,
    frameIndex: Int,
    frameCount: Int,
  ) -> Unit)? = null

  @JvmStatic
  external fun nativeLoad(
    instanceId: String,
    modelDir: String,
    modelType: String,
    numThreads: Int,
    provider: String?,
    maxSideLen: Int,
    useOrientationCls: Boolean,
    detBoxThresh: Float = 0.3f,
    detBoxScoreThresh: Float = 0.5f,
    detUnclipRatio: Float = 1.5f,
    maxNewTokens: Int = 0,
    maxPixels: Int = 0,
    quantization: String? = null,
    /** Absolute path overrides keyed like ValidateOcrPaths (`det`, `rec`, …). */
    pathOverrides: HashMap<String, String>? = null,
    paddleocrVlTask: String? = null,
  )

  @JvmStatic external fun nativeUnload(instanceId: String)

  @JvmStatic
  external fun nativeRecognize(
    instanceId: String,
    imageBufferId: String,
    frameIndices: IntArray?,
    granularity: String?,
    operationId: String?,
    progressMinIntervalMs: Int,
    hasPaddleocrVl: Boolean,
    paddleocrVlTask: String?,
  ): HashMap<String, Any>?

  @JvmStatic external fun nativeCancelRecognize(operationId: String)

  @JvmStatic
  external fun nativeDetect(
    modelDir: String,
    modelType: String?,
    quantization: String?,
  ): HashMap<String, Any>?

  /** Called from JNI during recognize (per backend phase). */
  @JvmStatic
  fun onNativeProgress(
    operationId: String?,
    done: Int,
    total: Int,
    phase: String?,
    frameIndex: Int,
    frameCount: Int,
  ) {
    val op = operationId ?: return
    progressListener?.invoke(
      op,
      done,
      total,
      phase ?: "recognize",
      frameIndex,
      frameCount,
    )
  }
}
