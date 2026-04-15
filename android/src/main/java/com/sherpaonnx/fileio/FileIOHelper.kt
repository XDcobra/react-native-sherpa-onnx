package com.sherpaonnx.fileio

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * Android file I/O helper implementing copyFile, saveText, shareFile, cancelFileIO.
 * Delegates resolution to [FileIOResolver] and streaming to [FileIOStreamCopy].
 */
internal class FileIOHelper(private val context: ReactApplicationContext) {

  private val logTag = "SherpaOnnxFileIO"
  private val resolver = FileIOResolver(context)

  fun copyFile(
    source: ReadableMap,
    destination: ReadableMap,
    overwrite: Boolean,
    createParentDirectories: Boolean,
    operationId: String,
    promise: Promise,
  ) {
    val cancelFlag = FileIOStreamCopy.registerOperation(operationId)
    try {
      val readHandle = resolver.resolveSource(source)
      val writeHandle = resolver.resolveDestination(
        destination = destination,
        mode = FileIOResolver.WriteMode.SEQUENTIAL,
        overwrite = overwrite,
        createParentDirectories = createParentDirectories,
      )

      readHandle.use { rh ->
        writeHandle.use { wh ->
          fun copyFromReadHandleToOutput(output: OutputStream): Long {
            return when (rh) {
              is FileIOResolver.ReadHandle.FilePath -> {
                val totalBytes = rh.file.length()
                FileInputStream(rh.file).use { input ->
                  FileIOStreamCopy.copy(
                    input,
                    output,
                    totalBytes,
                    cancelFlag,
                  ) { transferred, total, percent ->
                    emitProgress(operationId, transferred, total, percent)
                  }
                }
              }
              is FileIOResolver.ReadHandle.FileDescriptor -> {
                val totalBytes = rh.length ?: 0L
                FileInputStream(rh.pfd.fileDescriptor).use { input ->
                  FileIOStreamCopy.copy(
                    input,
                    output,
                    totalBytes,
                    cancelFlag,
                  ) { transferred, total, percent ->
                    emitProgress(operationId, transferred, total, percent)
                  }
                }
              }
              is FileIOResolver.ReadHandle.Stream -> {
                val totalBytes = rh.length ?: 0L
                FileIOStreamCopy.copy(
                  rh.inputStream,
                  output,
                  totalBytes,
                  cancelFlag,
                ) { transferred, total, percent ->
                  emitProgress(operationId, transferred, total, percent)
                }
              }
            }
          }

          val bytesCopied: Long
          val outputKind: String
          val outputPath: String

          when (wh) {
            is FileIOResolver.WriteHandle.FilePath -> {
              outputKind = "fs"
              outputPath = wh.file.absolutePath
              wh.file.outputStream().use { output ->
                bytesCopied = copyFromReadHandleToOutput(output)
              }
            }
            is FileIOResolver.WriteHandle.FileDescriptor -> {
              outputKind = "contentUri"
              outputPath = wh.resultUri.toString()
              FileOutputStream(wh.pfd.fileDescriptor).use { output ->
                bytesCopied = copyFromReadHandleToOutput(output)
              }
            }
            is FileIOResolver.WriteHandle.Stream -> {
              outputKind = "contentUri"
              outputPath = wh.resultUri.toString()
              bytesCopied = copyFromReadHandleToOutput(wh.outputStream)
            }
          }

          val result = Arguments.createMap().apply {
            putDouble("bytesCopied", bytesCopied.toDouble())
            putString("outputKind", outputKind)
            putString("outputPath", outputPath)
          }
          promise.resolve(result)
        }
      }
    } catch (e: FileIOException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      Log.e(logTag, "copyFile error", e)
      promise.reject(FileIOErrorCodes.READ_ERROR, e.message, e)
    } finally {
      FileIOStreamCopy.unregisterOperation(operationId)
    }
  }

  fun saveText(
    text: String,
    destination: ReadableMap,
    encoding: String,
    overwrite: Boolean,
    promise: Promise,
  ) {
    try {
      val writeHandle = resolver.resolveDestination(
        destination = destination,
        mode = FileIOResolver.WriteMode.SEQUENTIAL,
        overwrite = overwrite,
        createParentDirectories = false,
      )
      writeHandle.use { wh ->
        val outputKind: String
        val outputPath: String
        val bytes = text.toByteArray(Charsets.UTF_8)

        when (wh) {
          is FileIOResolver.WriteHandle.FilePath -> {
            outputKind = "fs"
            outputPath = wh.file.absolutePath
            wh.file.writeBytes(bytes)
          }
          is FileIOResolver.WriteHandle.FileDescriptor -> {
            outputKind = "contentUri"
            outputPath = wh.resultUri.toString()
            FileOutputStream(wh.pfd.fileDescriptor).use { out ->
              out.write(bytes)
              out.flush()
            }
          }
          is FileIOResolver.WriteHandle.Stream -> {
            outputKind = "contentUri"
            outputPath = wh.resultUri.toString()
            wh.outputStream.write(bytes)
            wh.outputStream.flush()
          }
        }

        val result = Arguments.createMap().apply {
          putString("outputKind", outputKind)
          putString("outputPath", outputPath)
        }
        promise.resolve(result)
      }
    } catch (e: FileIOException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      Log.e(logTag, "saveText error", e)
      promise.reject(FileIOErrorCodes.WRITE_ERROR, e.message, e)
    }
  }

  fun shareFile(
    source: ReadableMap,
    mimeType: String,
    title: String,
    promise: Promise,
  ) {
    try {
      val readHandle = resolver.resolveSource(source)
      val uri: Uri = when (readHandle) {
        is FileIOResolver.ReadHandle.FilePath -> {
          readHandle.close()
          val authority = context.packageName + ".fileprovider"
          FileProvider.getUriForFile(context, authority, readHandle.file)
        }
        is FileIOResolver.ReadHandle.FileDescriptor -> {
          readHandle.close()
          val sourceKind = source.getString("kind")
          if (sourceKind == "contentUri") {
            Uri.parse(source.getString("uri")!!)
          } else {
            val tmpFile = resolver.resolveSourceToFilePath(source)
            val authority = context.packageName + ".fileprovider"
            FileProvider.getUriForFile(context, authority, tmpFile)
          }
        }
        is FileIOResolver.ReadHandle.Stream -> {
          readHandle.close()
          // For streams (contentUri), we can pass the URI directly
          val sourceKind = source.getString("kind")
          if (sourceKind == "contentUri") {
            Uri.parse(source.getString("uri")!!)
          } else {
            // For other stream sources, copy to temp file first
            val tmpFile = resolver.resolveSourceToFilePath(source)
            val authority = context.packageName + ".fileprovider"
            FileProvider.getUriForFile(context, authority, tmpFile)
          }
        }
      }

      val effectiveMimeType = mimeType.ifEmpty {
        context.contentResolver.getType(uri) ?: "application/octet-stream"
      }

      val shareIntent = Intent(Intent.ACTION_SEND).apply {
        type = effectiveMimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooserTitle = title.ifEmpty { "Share" }
      val chooser = Intent.createChooser(shareIntent, chooserTitle)
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(chooser)
      promise.resolve(null)
    } catch (e: FileIOException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      Log.e(logTag, "shareFile error", e)
      promise.reject(FileIOErrorCodes.READ_ERROR, "Failed to share file: ${e.message}", e)
    }
  }

  fun cancelFileIO(operationId: String, promise: Promise) {
    FileIOStreamCopy.cancelOperation(operationId)
    promise.resolve(null)
  }

  /**
   * Resolve a FileSource to a local file path.
   * Used by audio buffer import and conversion to get a path for FFmpeg.
   */
  fun resolveSourceToFilePath(source: ReadableMap): File = resolver.resolveSourceToFilePath(source)

  /**
   * Resolve a FileDestination to a WriteHandle.
   * Used by audio conversion to write encoder output.
   */
  fun resolveDestination(
    destination: ReadableMap,
    mode: FileIOResolver.WriteMode = FileIOResolver.WriteMode.SEQUENTIAL,
    overwrite: Boolean = true,
    createParentDirectories: Boolean = false,
  ): FileIOResolver.WriteHandle = resolver.resolveDestination(destination, mode, overwrite, createParentDirectories)

  /**
   * Resolve a FileSource to a ReadHandle.
   * Used by audio buffer import to support direct fd-backed reads.
   */
  fun resolveSource(source: ReadableMap): FileIOResolver.ReadHandle = resolver.resolveSource(source)

  private fun emitProgress(operationId: String, bytesTransferred: Long, totalBytes: Long, percent: Int) {
    try {
      val eventEmitter = context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val payload = Arguments.createMap().apply {
        putString("operationId", operationId)
        putDouble("bytesTransferred", bytesTransferred.toDouble())
        putDouble("totalBytes", totalBytes.toDouble())
        putInt("percent", percent)
      }
      eventEmitter.emit("fileIOProgress", payload)
    } catch (_: Exception) {
      // Ignore if JS module not available
    }
  }
}
