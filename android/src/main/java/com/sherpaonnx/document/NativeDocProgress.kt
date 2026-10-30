package com.sherpaonnx.document

fun interface NativeDocProgress {
  fun onProgress(done: Int, total: Int, phase: String)
}
