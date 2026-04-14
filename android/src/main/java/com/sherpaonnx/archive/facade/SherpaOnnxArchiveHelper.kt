package com.sherpaonnx.archive.facade

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.sherpaonnx.archive.core.SherpaOnnxExtractionNotificationHelper
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Archive extraction helper using native libarchive.
 * Supports resumable extraction via skipEntries and per-operation cancellation.
 */
class SherpaOnnxArchiveHelper {
  companion object {
    /** Thread pool for extractions - allows up to 2 concurrent extractions. */
    private val extractExecutor: ExecutorService = Executors.newFixedThreadPool(2)

    init {
      try {
        System.loadLibrary("sherpaonnx")
      } catch (e: UnsatisfiedLinkError) {
        throw RuntimeException("Failed to load sherpaonnx library: ${e.message}")
      }
    }
  }

  /**
   * Extract an archive (tar.bz2/tar.zst - auto-detected) to target directory.
   * Runs on background thread. Promise resolves with result map containing:
   * success, paused, lastEntryIndex, lastEntryPath, bytesExtracted, path, sha256, reason.
   */
  fun extract(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    skipEntries: Int,
    operationId: String,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double, entryIndex: Int) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
  ) {
    extractExecutor.execute {
      val notif = extractionNotification
      try {
        notif?.start()
        val wrappedCallback = object : Any() {
          fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double, entryIndex: Int) {
            onProgress(bytesExtracted, totalBytes, percent, entryIndex)
            notif?.updateProgress(percent)
          }
        }
        nativeExtract(sourcePath, targetPath, force, skipEntries, operationId, wrappedCallback, promise)
      } catch (e: Exception) {
        val result = Arguments.createMap()
        result.putBoolean("success", false)
        result.putBoolean("paused", false)
        result.putInt("lastEntryIndex", -1)
        result.putDouble("bytesExtracted", 0.0)
        result.putString("lastEntryPath", "")
        result.putString("reason", "Archive extraction error: ${e.message}")
        promise.resolve(result)
      } finally {
        notif?.finish()
      }
    }
  }

  /**
   * Extract from Android APK asset stream. Auto-detects compression format.
   */
  fun extractFromAsset(
    context: Context,
    assetPath: String,
    targetPath: String,
    force: Boolean,
    skipEntries: Int,
    operationId: String,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double, entryIndex: Int) -> Unit,
    extractionNotification: SherpaOnnxExtractionNotificationHelper? = null,
  ) {
    extractExecutor.execute {
      val notif = extractionNotification
      try {
        notif?.start()
        val progressCallback = object : Any() {
          fun invoke(bytesExtracted: Long, totalBytes: Long, percent: Double, entryIndex: Int) {
            onProgress(bytesExtracted, totalBytes, percent, entryIndex)
            notif?.updateProgress(percent)
          }
        }
        context.assets.open(assetPath).use { stream ->
          nativeExtractFromStream(stream, targetPath, force, skipEntries, operationId, progressCallback, promise)
        }
      } catch (e: Exception) {
        val result = Arguments.createMap()
        result.putBoolean("success", false)
        result.putBoolean("paused", false)
        result.putInt("lastEntryIndex", -1)
        result.putDouble("bytesExtracted", 0.0)
        result.putString("lastEntryPath", "")
        result.putString("reason", e.message ?: "Failed to open asset")
        promise.resolve(result)
      } finally {
        notif?.finish()
      }
    }
  }

  /** Cancel an ongoing extraction by operation ID. */
  fun cancelOperation(operationId: String) {
    nativeCancelOperation(operationId)
  }

  fun computeFileSha256(filePath: String, promise: Promise) {
    nativeComputeFileSha256(filePath, promise)
  }

  // Native JNI methods

  private external fun nativeExtract(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    skipEntries: Int,
    operationId: String,
    progressCallback: Any?,
    promise: Promise
  )

  private external fun nativeExtractFromStream(
    inputStream: java.io.InputStream,
    targetPath: String,
    force: Boolean,
    skipEntries: Int,
    operationId: String,
    progressCallback: Any?,
    promise: Promise
  )

  private external fun nativeCancelOperation(operationId: String)

  private external fun nativeComputeFileSha256(
    filePath: String,
    promise: Promise
  )
}