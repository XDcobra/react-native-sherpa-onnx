package com.sherpaonnx.reader.facade

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.fileio.FileIOHelper
import com.sherpaonnx.reader.ReaderNative
import java.util.concurrent.Executors

/** TurboModule side of `react-native-sherpa-onnx/reader` (results are JSON strings). */
internal class SherpaOnnxReaderHelper(reactContext: ReactApplicationContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private val fileIO = FileIOHelper(reactContext)

  private fun run(promise: Promise, block: () -> Array<String>) {
    executor.execute {
      try {
        settle(block(), promise)
      } catch (e: Exception) {
        Log.e(TAG, "reader call failed", e)
        promise.reject(ERR_INVALID, e.message, e)
      }
    }
  }

  private fun settle(result: Array<String>, promise: Promise) {
    if (result.size >= 2 && result[1].isEmpty() && !result[0].startsWith("ERR_")) {
      promise.resolve(result[0])
    } else {
      val code = result.getOrNull(0) ?: ERR_INVALID
      promise.reject(code, "$code: ${result.getOrNull(1) ?: ""}")
    }
  }

  fun computeFileSourceSha256(source: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        val opened = fileIO.openSeekableSourceOrReject(source, promise, ERR_INVALID, TAG)
          ?: return@execute
        val result =
          try {
            ReaderNative.nativeSha256OfSource(opened.path, opened.fd)
          } finally {
            opened.close()
          }
        settle(result, promise)
      } catch (e: Exception) {
        promise.reject(ERR_INVALID, e.message, e)
      }
    }
  }

  fun createReaderDocument(textBufferId: String, imageBufferId: String, key: String, promise: Promise) =
    run(promise) { ReaderNative.nativeCreateDocument(textBufferId, imageBufferId, key) }

  fun insertReaderSection(
    documentId: String,
    after: String,
    sectionId: String,
    title: String,
    keys: ReadableArray,
    types: ReadableArray,
    texts: ReadableArray,
    levels: ReadableArray,
    promise: Promise,
  ) {
    val k = Array(keys.size()) { keys.getString(it) ?: "" }
    val ty = Array(types.size()) { types.getString(it) ?: "" }
    val tx = Array(texts.size()) { texts.getString(it) ?: "" }
    val lv = IntArray(levels.size()) { levels.getDouble(it).toInt() }
    run(promise) { ReaderNative.nativeInsertSection(documentId, after, sectionId, title, k, ty, tx, lv) }
  }

  fun removeReaderSection(documentId: String, sectionId: String, promise: Promise) =
    run(promise) { ReaderNative.nativeRemoveSection(documentId, sectionId) }

  fun getReaderBlocks(documentId: String, start: Double, maxCount: Double, includeText: Boolean, promise: Promise) =
    run(promise) {
      ReaderNative.nativeGetBlocks(
        documentId,
        start.toInt().coerceAtLeast(0),
        maxCount.toInt().coerceIn(0, 4096),
        includeText,
      )
    }

  fun findReaderBlockByHash(documentId: String, textHash: String, hintBlockId: String, promise: Promise) =
    run(promise) { ReaderNative.nativeFindBlockByHash(documentId, textHash, hintBlockId) }

  fun mapReaderTextRanges(documentId: String, starts: ReadableArray, ends: ReadableArray, promise: Promise) {
    val s = IntArray(starts.size()) { starts.getDouble(it).toInt() }
    val e = IntArray(ends.size()) { ends.getDouble(it).toInt() }
    run(promise) { ReaderNative.nativeMapTextRanges(documentId, s, e) }
  }

  fun getReaderToc(documentId: String, promise: Promise) =
    run(promise) { ReaderNative.nativeGetToc(documentId) }

  fun releaseReaderDocument(documentId: String, promise: Promise) {
    promise.resolve(ReaderNative.nativeReleaseDocument(documentId))
  }

  fun shutdown() {
    executor.shutdownNow()
  }

  companion object {
    private const val TAG = "SherpaOnnxReader"
    private const val ERR_INVALID = "ERR_READER_INVALID_ARGUMENT"
  }
}
