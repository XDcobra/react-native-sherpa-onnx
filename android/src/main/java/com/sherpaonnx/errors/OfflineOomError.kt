package com.sherpaonnx.errors

object OfflineOomError {
  const val CODE = "OFFLINE_OOM"

  fun message(feature: String): String =
    "Not enough memory for offline $feature. Please use a streaming mode for large inputs. " +
      "Alternatively, use the segmentation engine to process smaller segments with offline models " +
      "(see docs/segmentation-engine.md)."
}
