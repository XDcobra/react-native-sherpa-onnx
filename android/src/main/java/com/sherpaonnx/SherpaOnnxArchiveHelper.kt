package com.sherpaonnx

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.apache.commons.io.input.CountingInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

class SherpaOnnxArchiveHelper {
  private val cancelRequested = AtomicBoolean(false)

  fun cancelExtractTarBz2() {
    cancelRequested.set(true)
  }

  fun extractTarBz2(
    sourcePath: String,
    targetPath: String,
    force: Boolean,
    promise: Promise,
    onProgress: (bytes: Long, totalBytes: Long, percent: Double) -> Unit
  ) {
    val result = Arguments.createMap()

    try {
      cancelRequested.set(false)
      val sourceFile = File(sourcePath)
      if (!sourceFile.exists()) {
        result.putBoolean("success", false)
        result.putString("reason", "Source file does not exist")
        promise.resolve(result)
        return
      }

      val targetDir = File(targetPath)
      if (targetDir.exists()) {
        if (force) {
          targetDir.deleteRecursively()
        } else {
          result.putBoolean("success", false)
          result.putString("reason", "Target path already exists")
          promise.resolve(result)
          return
        }
      }

      if (!targetDir.mkdirs()) {
        result.putBoolean("success", false)
        result.putString("reason", "Failed to create target directory")
        promise.resolve(result)
        return
      }

      val canonicalTarget = targetDir.canonicalPath + File.separator
      val totalBytes = sourceFile.length()
      var extractedBytes = 0L
      var lastPercent = -1
      var lastEmitBytes = 0L

      FileInputStream(sourceFile).use { fis ->
        CountingInputStream(fis).use { countingIn ->
          BZip2CompressorInputStream(countingIn).use { bzIn ->
            TarArchiveInputStream(bzIn).use { tarIn ->
              var entry: TarArchiveEntry? = tarIn.nextTarEntry
              while (entry != null) {
                if (cancelRequested.get()) {
                  throw CancellationException("Extraction cancelled")
                }
                val entryFile = File(targetDir, entry.name)
                val canonicalEntry = entryFile.canonicalPath
                if (!canonicalEntry.startsWith(canonicalTarget)) {
                  throw IOException("Blocked path traversal: ${entry.name}")
                }

                if (entry.isDirectory) {
                  if (!entryFile.exists() && !entryFile.mkdirs()) {
                    throw IOException("Failed to create directory: ${entryFile.path}")
                  }
                } else {
                  val parent = entryFile.parentFile
                  if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw IOException("Failed to create directory: ${parent.path}")
                  }
                  FileOutputStream(entryFile).use { out ->
                    val buffer = ByteArray(32 * 1024)
                    var read = tarIn.read(buffer)
                    while (read != -1) {
                      if (cancelRequested.get()) {
                        throw CancellationException("Extraction cancelled")
                      }
                      out.write(buffer, 0, read)
                      extractedBytes += read.toLong()

                      if (totalBytes > 0) {
                        val compressedBytes = countingIn.byteCount
                        val percent = ((compressedBytes * 100) / totalBytes).toInt()
                        if (percent != lastPercent) {
                          lastPercent = percent
                          onProgress(compressedBytes, totalBytes, percent.toDouble())
                        }
                      } else if (extractedBytes - lastEmitBytes >= 1024 * 1024) {
                        lastEmitBytes = extractedBytes
                        onProgress(extractedBytes, totalBytes, 0.0)
                      }

                      read = tarIn.read(buffer)
                    }
                  }
                }

                entry = tarIn.nextTarEntry
              }
            }
          }
        }
      }

      if (totalBytes > 0) {
        onProgress(totalBytes, totalBytes, 100.0)
      }

      result.putBoolean("success", true)
      result.putString("path", targetDir.absolutePath)
      promise.resolve(result)
    } catch (e: Exception) {
      result.putBoolean("success", false)
      result.putString("reason", e.message ?: "Unknown extraction error")
      promise.resolve(result)
    }
  }

}
