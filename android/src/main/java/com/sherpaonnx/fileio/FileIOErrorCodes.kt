package com.sherpaonnx.fileio

/**
 * Error codes for file I/O operations, matching the JS-side FileIOErrorCode.
 */
object FileIOErrorCodes {
  const val INVALID_ARGUMENT = "FILEIO_INVALID_ARGUMENT"
  const val UNSUPPORTED_LOCATION_KIND = "FILEIO_UNSUPPORTED_LOCATION_KIND"
  const val UNSUPPORTED_ON_PLATFORM = "FILEIO_UNSUPPORTED_ON_PLATFORM"
  const val PERMISSION_DENIED = "FILEIO_PERMISSION_DENIED"
  const val NOT_FOUND = "FILEIO_NOT_FOUND"
  const val ALREADY_EXISTS = "FILEIO_ALREADY_EXISTS"
  const val READ_ERROR = "FILEIO_READ_ERROR"
  const val WRITE_ERROR = "FILEIO_WRITE_ERROR"
  const val RESOLVE_ERROR = "FILEIO_RESOLVE_ERROR"
  const val CANCELLED = "FILEIO_CANCELLED"
  const val PATH_TRAVERSAL_BLOCKED = "FILEIO_PATH_TRAVERSAL_BLOCKED"
}

/**
 * Exception carrying a FILEIO_* error code.
 */
internal class FileIOException(
  val code: String,
  override val message: String,
  override val cause: Throwable? = null,
) : RuntimeException(message, cause)
