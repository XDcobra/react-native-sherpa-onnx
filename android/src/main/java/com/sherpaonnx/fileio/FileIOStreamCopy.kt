package com.sherpaonnx.fileio

import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Stream copy engine with progress reporting and cancellation.
 * Used by copyFile and as fallback for audio conversion.
 */
internal object FileIOStreamCopy {

  private const val BUFFER_SIZE = 65536 // 64 KB

  /** Active cancellation flags, keyed by operationId. */
  private val cancelledOps = ConcurrentHashMap<String, AtomicBoolean>()

  /** Register an operation for cancellation support. */
  fun registerOperation(operationId: String): AtomicBoolean {
    val flag = AtomicBoolean(false)
    cancelledOps[operationId] = flag
    return flag
  }

  /** Cancel a running operation. */
  fun cancelOperation(operationId: String) {
    cancelledOps[operationId]?.set(true)
  }

  /** Unregister an operation (cleanup). */
  fun unregisterOperation(operationId: String) {
    cancelledOps.remove(operationId)
  }

  /**
   * Copy from [input] to [output] with progress and cancellation.
   *
   * @param totalBytes Total bytes if known, 0 otherwise.
   * @param cancelFlag Checked per buffer read.
   * @param onProgress Called per buffer with (bytesTransferred, totalBytes, percent).
   * @return Total bytes copied.
   */
  fun copy(
    input: InputStream,
    output: OutputStream,
    totalBytes: Long = 0,
    cancelFlag: AtomicBoolean? = null,
    onProgress: ((bytesTransferred: Long, totalBytes: Long, percent: Int) -> Unit)? = null,
  ): Long {
    val buffer = ByteArray(BUFFER_SIZE)
    var totalTransferred = 0L

    var bytesRead = input.read(buffer)
    while (bytesRead > 0) {
      if (cancelFlag?.get() == true) {
        throw FileIOException(FileIOErrorCodes.CANCELLED, "Operation cancelled")
      }
      output.write(buffer, 0, bytesRead)
      totalTransferred += bytesRead

      onProgress?.let { cb ->
        val percent = if (totalBytes > 0) {
          ((totalTransferred * 100) / totalBytes).toInt().coerceAtMost(100)
        } else 0
        cb(totalTransferred, totalBytes, percent)
      }

      bytesRead = input.read(buffer)
    }
    output.flush()
    return totalTransferred
  }
}
