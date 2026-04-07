package com.sherpaonnx

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * File persistence and sharing (SAF, cache copy, share sheet). Not TTS-engine-specific.
 * TurboModule methods are implemented on [SherpaOnnxModule].
 */
internal class SherpaOnnxFilesHelper(
  private val context: ReactApplicationContext
) {
  private val logTag = "SherpaOnnxFiles"

  fun saveTextToContentUri(
    text: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    try {
      val resolver = context.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = SherpaOnnxContentUriUtils.createDocumentInDirectory(resolver, dirUri, filename, mimeType)
      resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
        outputStream.write(text.toByteArray(Charsets.UTF_8))
      } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e(logTag, "TTS_SAVE_ERROR: Failed to save text to content URI", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to save text to content URI", e)
    }
  }

  /**
   * Copy a local file into a document under a SAF directory URI.
   */
  fun copyFileToContentUri(
    filePath: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  ) {
    try {
      val file = File(filePath)
      if (!file.isFile || !file.canRead()) {
        promise.reject("TTS_SAVE_ERROR", "File not found or not readable: $filePath")
        return
      }
      val resolver = context.contentResolver
      val dirUri = Uri.parse(directoryUri)
      val fileUri = SherpaOnnxContentUriUtils.createDocumentInDirectory(resolver, dirUri, filename, mimeType)
      FileInputStream(file).use { inputStream ->
        resolver.openOutputStream(fileUri, "w")?.use { outputStream ->
          SherpaOnnxContentUriUtils.copyStream(inputStream, outputStream)
        } ?: throw IllegalStateException("Failed to open output stream for URI: $fileUri")
      }
      promise.resolve(fileUri.toString())
    } catch (e: Exception) {
      Log.e(logTag, "TTS_SAVE_ERROR: Failed to copy file to content URI", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to copy file to content URI", e)
    }
  }

  fun copyContentUriToCache(fileUri: String, filename: String, promise: Promise) {
    try {
      val resolver = context.contentResolver
      val uri = Uri.parse(fileUri)
      val cacheFile = File(context.cacheDir, filename)
      resolver.openInputStream(uri)?.use { inputStream ->
        FileOutputStream(cacheFile).use { outputStream ->
          SherpaOnnxContentUriUtils.copyStream(inputStream, outputStream)
        }
      } ?: throw IllegalStateException("Failed to open input stream for URI: $fileUri")
      promise.resolve(cacheFile.absolutePath)
    } catch (e: Exception) {
      Log.e(logTag, "TTS_SAVE_ERROR: Failed to copy audio to cache", e)
      promise.reject("TTS_SAVE_ERROR", "Failed to copy audio to cache", e)
    }
  }

  fun shareAudioFile(fileUri: String, mimeType: String, promise: Promise) {
    try {
      val uri = if (fileUri.startsWith("content://")) {
        Uri.parse(fileUri)
      } else {
        val path = if (fileUri.startsWith("file://")) {
          try {
            Uri.parse(fileUri).path ?: fileUri.replaceFirst("file://", "")
          } catch (_: Exception) {
            fileUri.replaceFirst("file://", "")
          }
        } else {
          fileUri
        }
        val file = File(path)
        val authority = context.packageName + ".fileprovider"
        FileProvider.getUriForFile(context, authority, file)
      }
      val shareIntent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(shareIntent, "Share audio")
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.e(logTag, "TTS_SHARE_ERROR: Failed to share audio", e)
      promise.reject("TTS_SHARE_ERROR", "Failed to share audio", e)
    }
  }
}
