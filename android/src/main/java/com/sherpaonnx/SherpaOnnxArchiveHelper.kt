package com.sherpaonnx

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Archive extraction helper using native libarchive for fast .tar.bz2 extraction.
 * This class delegates to C++ native implementation via JNI.
 */
class SherpaOnnxArchiveHelper {
  private val cancelRequested = AtomicBoolean(false)

  companion object {
    init {
      try {
        System.loadLibrary("sherpaonnx")
      } catch (e: UnsatisfiedLinkError) {
        throw RuntimeException("Failed to load sherpaonnx library: ${e.message}")
      }
    }
  }

  fun cancelExtractTarBz2() {
    cancelRequested.set(true)
    nativeCancelExtract()
  }

  fun extractTarBz2(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit
  ) {
    try {
      cancelRequested.set(false)

      // Create a progress callback object that JNI can call
      val progressCallback = object : Any() {
        fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
          onProgress(bytesExtracted, totalBytes, percent)
        }
      }

      // Call native JNI method using libarchive
      nativeExtractTarBz2(sourcePath, targetPath, force, progressCallback, promise)
    } catch (e: Exception) {
      val result = Arguments.createMap()
      result.putBoolean("success", false)
      result.putString("reason", "Archive extraction error: ${e.message}")
      promise.resolve(result)
    }
  }

  // Native JNI methods
  private external fun nativeExtractTarBz2(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    progressCallback: Any?,
    promise: Promise
  )

  private external fun nativeCancelExtract()
}

