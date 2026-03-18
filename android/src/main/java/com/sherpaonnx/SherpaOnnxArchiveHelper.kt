package com.sherpaonnx

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Archive extraction helper using native libarchive for fast .tar.bz2 extraction.
 * This class delegates to C++ native implementation via JNI.
 */
class SherpaOnnxArchiveHelper {
  companion object {
    /** Thread pool for extractions – allows up to 2 concurrent extractions while keeping them off the React Native bridge thread. */
    private val extractExecutor: ExecutorService = Executors.newFixedThreadPool(2)

    /** Per-source-path cancellation flags. Key = absolute source archive path. */
    private val cancelFlags = ConcurrentHashMap<String, AtomicBoolean>()

    init {
      try {
        System.loadLibrary("sherpaonnx")
      } catch (e: UnsatisfiedLinkError) {
        throw RuntimeException("Failed to load sherpaonnx library: ${e.message}")
      }
    }
  }

  fun cancelExtractTarBz2() {
    // Cancel ALL ongoing extractions (legacy global cancel)
    for (flag in cancelFlags.values) flag.set(true)
    nativeCancelExtract()
  }

  fun cancelExtractTarZst() {
    // Cancel ALL ongoing extractions (legacy global cancel)
    for (flag in cancelFlags.values) flag.set(true)
    nativeCancelExtract()
  }

  /** Cancel a specific extraction identified by its source archive path. */
  fun cancelExtractBySourcePath(sourcePath: String) {
    cancelFlags[sourcePath]?.set(true)
    // Also signal native layer in case extraction is blocked in C++
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
      // Register per-path cancel flag
      val cancelFlag = AtomicBoolean(false)
      cancelFlags[sourcePath] = cancelFlag

      // Create a progress callback object that JNI can call
      val progressCallback = object : Any() {
        fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
          onProgress(bytesExtracted, totalBytes, percent)
        }
      }

      // Run extraction on a background thread so the React Native bridge thread is not blocked.
      // The thread pool allows multiple extractions in parallel.
      extractExecutor.execute {
        try {
          nativeExtractTarBz2(sourcePath, targetPath, force, progressCallback, promise)
        } catch (e: Exception) {
          resolveOnce(false, "Archive extraction error: ${e.message}")
        } finally {
          cancelFlags.remove(sourcePath)
        }
      }
    } catch (e: Exception) {
      cancelFlags.remove(sourcePath)
      resolveOnce(false, "Archive extraction error: ${e.message}")
    }
  }

  fun extractTarZst(
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
      val cancelFlag = AtomicBoolean(false)
      cancelFlags[sourcePath] = cancelFlag

      val progressCallback = object : Any() {
        fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
          onProgress(bytesExtracted, totalBytes, percent)
        }
      }
      extractExecutor.execute {
        try {
          nativeExtractTarZst(sourcePath, targetPath, force, progressCallback, promise)
        } catch (e: Exception) {
          resolveOnce(false, "Archive extraction error: ${e.message}")
        } finally {
          cancelFlags.remove(sourcePath)
        }
      }
    } catch (e: Exception) {
      cancelFlags.remove(sourcePath)
      resolveOnce(false, "Archive extraction error: ${e.message}")
    }
  }

  fun extractTarZstFromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit
  ) {
    if (BuildConfig.DEBUG) {
      Log.i("SherpaOnnx", "extractTarZstFromAsset assetPath=$assetPath targetPath=$targetPath")
    }
    val progressCallback = object : Any() {
      fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
        onProgress(bytesExtracted, totalBytes, percent)
      }
    }
    extractExecutor.execute {
      try {
        context.assets.open(assetPath).use { stream ->
          nativeExtractTarZstFromStream(stream, targetPath, force, progressCallback, promise)
        }
      } catch (e: Exception) {
        val result = Arguments.createMap()
        result.putBoolean("success", false)
        result.putString("reason", e.message ?: "Failed to open asset")
        promise.resolve(result)
      }
    }
  }

  fun extractTarBz2FromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit
  ) {
    extractTarZstFromAsset(context, assetPath, targetPath, force, promise, onProgress)
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

  private external fun nativeExtractTarZst(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    progressCallback: Any?,
    promise: Promise
  )

  private external fun nativeExtractTarZstFromStream(
    inputStream: java.io.InputStream,
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

