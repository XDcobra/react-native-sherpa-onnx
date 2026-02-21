package com.sherpaonnx

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Archive extraction helper using native libarchive for fast .tar.bz2 extraction.
 * This class delegates to C++ native implementation via JNI.
 */
class SherpaOnnxArchiveHelper {
  private val cancelRequested = AtomicBoolean(false)

  companion object {
    /** Single-thread executor so extractions run off the React Native bridge thread and do not block listDownloadedModelsByCategory / RNFS. */
    private val extractExecutor: ExecutorService = Executors.newSingleThreadExecutor()

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
    val promiseSettled = AtomicBoolean(false)
    fun resolveOnce(success: Boolean, reason: String? = null) {
      if (!promiseSettled.compareAndSet(false, true)) return
      val result = Arguments.createMap()
      result.putBoolean("success", success)
      if (reason != null) result.putString("reason", reason)
      promise.resolve(result)
    }

    try {
      cancelRequested.set(false)

      // Create a progress callback object that JNI can call
      val progressCallback = object : Any() {
        fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
          onProgress(bytesExtracted, totalBytes, percent)
        }
      }

      // Run extraction on a background thread so the React Native bridge thread is not blocked.
      // Otherwise listDownloadedModelsByCategory (RNFS) and other native calls would wait until extraction finishes.
      extractExecutor.execute {
        try {
          nativeExtractTarBz2(sourcePath, targetPath, force, progressCallback, promise)
        } catch (e: Exception) {
          resolveOnce(false, "Archive extraction error: ${e.message}")
        }
      }
    } catch (e: Exception) {
      resolveOnce(false, "Archive extraction error: ${e.message}")
    }
  }

  fun computeFileSha256(filePath: String, promise: Promise) {
    nativeComputeFileSha256(filePath, promise)
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

  private external fun nativeComputeFileSha256(
    filePath: String,
    promise: Promise
  )
}

