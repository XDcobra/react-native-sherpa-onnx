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
    // Only set the per-path flag; do not call nativeCancelExtract() since that is
    // a global cancel that would also interrupt unrelated concurrent extractions.
    cancelFlags[sourcePath]?.set(true)
  }

  fun extractTarBz2(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
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

      // Run extraction on a background thread so the React Native bridge thread is not blocked.
      // The thread pool allows multiple extractions in parallel.
      extractExecutor.execute {
        val notif = extractionNotification
        try {
          // Check per-path cancel flag before starting the native extraction.
          if (cancelFlag.get()) {
            resolveOnce(false, "Cancelled")
            return@execute
          }
          notif?.start()
          val wrappedCallback = object : Any() {
            fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
              onProgress(bytesExtracted, totalBytes, percent)
              notif?.updateProgress(percent)
            }
          }
          nativeExtractTarBz2(sourcePath, targetPath, force, wrappedCallback, promise)
        } catch (e: Exception) {
          resolveOnce(false, "Archive extraction error: ${e.message}")
        } finally {
          notif?.finish()
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
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
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

      extractExecutor.execute {
        val notif = extractionNotification
        try {
          // Check per-path cancel flag before starting the native extraction.
          if (cancelFlag.get()) {
            resolveOnce(false, "Cancelled")
            return@execute
          }
          notif?.start()
          val wrappedCallback = object : Any() {
            fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
              onProgress(bytesExtracted, totalBytes, percent)
              notif?.updateProgress(percent)
            }
          }
          nativeExtractTarZst(sourcePath, targetPath, force, wrappedCallback, promise)
        } catch (e: Exception) {
          resolveOnce(false, "Archive extraction error: ${e.message}")
        } finally {
          notif?.finish()
          cancelFlags.remove(sourcePath)
        }
      }
    } catch (e: Exception) {
      cancelFlags.remove(sourcePath)
      resolveOnce(false, "Archive extraction error: ${e.message}")
    }
  }

  /**
   * Which JNI stream entry to use for APK asset extraction.
   *
   * Both paths invoke libarchive’s `ExtractFromStream`, which **auto-detects** compression
   * (`.tar.zst` vs `.tar.bz2`, etc.); `nativeExtractTarBz2FromStream` forwards to the same
   * native implementation as zst. Keeping distinct JNI symbols preserves a clear API and avoids
   * the impression that bz2 assets are mistakenly wired only to a “zst” method.
   */
  private enum class AssetTarStreamKind {
    ZST,
    BZ2,
  }

  fun extractTarZstFromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
  ) {
    extractTarArchiveFromAsset(
      context,
      assetPath,
      targetPath,
      force,
      promise,
      onProgress,
      extractionNotification,
      AssetTarStreamKind.ZST,
    )
  }

  fun extractTarBz2FromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
  ) {
    extractTarArchiveFromAsset(
      context,
      assetPath,
      targetPath,
      force,
      promise,
      onProgress,
      extractionNotification,
      AssetTarStreamKind.BZ2,
    )
  }

  private fun extractTarArchiveFromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
    kind: AssetTarStreamKind,
  ) {
    if (BuildConfig.DEBUG) {
      Log.i(
        "SherpaOnnx",
        "extractTar${if (kind == AssetTarStreamKind.ZST) "Zst" else "Bz2"}FromAsset assetPath=$assetPath targetPath=$targetPath",
      )
    }
    extractExecutor.execute {
      val notif = extractionNotification
      try {
        notif?.start()
        val progressCallback = object : Any() {
          fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double) {
            onProgress(bytesExtracted, totalBytes, percent)
            notif?.updateProgress(percent)
          }
        }
        context.assets.open(assetPath).use { stream ->
          when (kind) {
            AssetTarStreamKind.ZST ->
              nativeExtractTarZstFromStream(stream, targetPath, force, progressCallback, promise)
            AssetTarStreamKind.BZ2 ->
              nativeExtractTarBz2FromStream(stream, targetPath, force, progressCallback, promise)
          }
        }
      } catch (e: Exception) {
        val result = Arguments.createMap()
        result.putBoolean("success", false)
        result.putString("reason", e.message ?: "Failed to open asset")
        promise.resolve(result)
      } finally {
        notif?.finish()
      }
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

  private external fun nativeExtractTarBz2FromStream(
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

