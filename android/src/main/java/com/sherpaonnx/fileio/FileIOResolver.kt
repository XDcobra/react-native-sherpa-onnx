package com.sherpaonnx.fileio

import android.net.Uri
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.fileio.core.SherpaOnnxContentUriUtils
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * Central resolver for FileSource / FileDestination.
 * All file I/O operations go through this to avoid duplicated URI/path logic.
 */
internal class FileIOResolver(private val context: ReactApplicationContext) {

  /** Resolved read handle. Caller must close. */
  sealed class ReadHandle : Closeable {
    /** Local file — can be passed to APIs that require a path. */
    class FilePath(val file: File) : ReadHandle() {
      override fun close() {}
    }

    /** Seekable file descriptor path (e.g. /proc/self/fd/<n>). */
    class FileDescriptor(
      val pfd: ParcelFileDescriptor,
      val fdPath: String,
      val length: Long?,
    ) : ReadHandle() {
      override fun close() = pfd.close()
    }

    /** Content stream — for streaming reads (no random access). */
    class Stream(val inputStream: InputStream, val length: Long?) : ReadHandle() {
      override fun close() = inputStream.close()
    }
  }

  /** Resolved write handle. Caller must close. */
  sealed class WriteHandle : Closeable {
    /** Local file path. */
    class FilePath(val file: File) : WriteHandle() {
      override fun close() {}
    }

    /** SAF output stream — for streaming writes. */
    class Stream(
      val outputStream: OutputStream,
      val resultUri: Uri,
    ) : WriteHandle() {
      override fun close() = outputStream.close()
    }
  }

  fun resolveSource(source: ReadableMap): ReadHandle {
    val kind = source.getString("kind")
      ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'kind' in source")

    return when (kind) {
      "fs" -> {
        val path = source.getString("path")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'path' in fs source")
        val file = File(path)
        if (!file.exists()) throw FileIOException(FileIOErrorCodes.NOT_FOUND, "Source file not found: $path")
        if (!file.canRead()) throw FileIOException(FileIOErrorCodes.PERMISSION_DENIED, "Cannot read file: $path")
        ReadHandle.FilePath(file)
      }

      "app" -> {
        val base = source.getString("base")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'base' in app source")
        val path = source.getString("path")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'path' in app source")
        val file = if (base == "apkAsset") {
          resolveApkAssetFile(path)
        } else {
          resolveAppPath(base, path)
        }
        if (!file.exists()) throw FileIOException(FileIOErrorCodes.NOT_FOUND, "Source file not found: ${file.absolutePath}")
        if (!file.canRead()) throw FileIOException(FileIOErrorCodes.PERMISSION_DENIED, "Cannot read file: ${file.absolutePath}")
        ReadHandle.FilePath(file)
      }

      "contentUri" -> {
        val uriStr = source.getString("uri")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'uri' in contentUri source")
        val uri = Uri.parse(uriStr)
        val resolver = context.contentResolver
        val knownLength = queryContentLength(uri)

        var fdSecurityException: SecurityException? = null
        val pfd = try {
          resolver.openFileDescriptor(uri, "r")
        } catch (e: SecurityException) {
          fdSecurityException = e
          null
        } catch (_: Exception) {
          null
        }

        if (pfd != null) {
          val fdLength = pfd.statSize.takeIf { it >= 0 } ?: knownLength
          ReadHandle.FileDescriptor(
            pfd = pfd,
            fdPath = "/proc/self/fd/${pfd.fd}",
            length = fdLength,
          )
        } else {
          val inputStream = try {
            resolver.openInputStream(uri)
          } catch (e: SecurityException) {
            throw FileIOException(FileIOErrorCodes.PERMISSION_DENIED, "No permission for URI: $uriStr", fdSecurityException ?: e)
          } ?: throw FileIOException(FileIOErrorCodes.NOT_FOUND, "Cannot open input stream for URI: $uriStr")

          ReadHandle.Stream(inputStream, knownLength)
        }
      }

      "securityScoped" -> throw FileIOException(
        FileIOErrorCodes.UNSUPPORTED_ON_PLATFORM,
        "securityScoped is not supported on Android"
      )

      "pad" -> {
        val packName = source.getString("packName")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'packName' in pad source")
        val path = source.getString("path")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'path' in pad source")

        val assetPackPath = try {
          val assetPackManager = com.google.android.play.core.assetpacks.AssetPackManagerFactory.getInstance(context)
          val location = assetPackManager.getPackLocation(packName)
          location?.assetsPath()
        } catch (e: Exception) {
          null
        } ?: throw FileIOException(FileIOErrorCodes.RESOLVE_ERROR, "Cannot resolve PAD pack: $packName")

        val file = File(assetPackPath, path)
        if (!file.exists()) throw FileIOException(FileIOErrorCodes.NOT_FOUND, "PAD asset not found: ${file.absolutePath}")
        ReadHandle.FilePath(file)
      }

      else -> throw FileIOException(
        FileIOErrorCodes.UNSUPPORTED_LOCATION_KIND,
        "Unknown source kind: $kind"
      )
    }
  }

  fun resolveDestination(
    destination: ReadableMap,
    overwrite: Boolean = true,
    createParentDirectories: Boolean = false,
  ): WriteHandle {
    val kind = destination.getString("kind")
      ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'kind' in destination")

    return when (kind) {
      "fs" -> {
        val path = destination.getString("path")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'path' in fs destination")
        val file = File(path)
        if (file.exists() && !overwrite) {
          throw FileIOException(FileIOErrorCodes.ALREADY_EXISTS, "Destination already exists: $path")
        }
        if (createParentDirectories) {
          file.parentFile?.mkdirs()
        }
        WriteHandle.FilePath(file)
      }

      "app" -> {
        val base = destination.getString("base")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'base' in app destination")
        val path = destination.getString("path")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'path' in app destination")
        val file = resolveAppPath(base, path)
        if (file.exists() && !overwrite) {
          throw FileIOException(FileIOErrorCodes.ALREADY_EXISTS, "Destination already exists: ${file.absolutePath}")
        }
        if (createParentDirectories) {
          file.parentFile?.mkdirs()
        }
        WriteHandle.FilePath(file)
      }

      "contentUri" -> {
        val uriStr = destination.getString("uri")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'uri' in contentUri destination")
        val uri = Uri.parse(uriStr)
        val resolver = context.contentResolver

        // Always use OutputStream for content:// document targets (same strategy as contentTree).
        // Do not use openFileDescriptor(rw) for seekable audio encode: native encoders fopen("/proc/self/fd/…")
        // is unreliable for many provider-backed URIs. SherpaOnnxModule resolves Stream destinations to a
        // cache temp file for encode, then copies bytes into this stream.
        val outputStream = try {
          resolver.openOutputStream(uri, "w")
        } catch (e: SecurityException) {
          throw FileIOException(FileIOErrorCodes.PERMISSION_DENIED, "No permission for URI: $uriStr", e)
        } ?: throw FileIOException(FileIOErrorCodes.WRITE_ERROR, "Cannot open output stream for URI: $uriStr")
        WriteHandle.Stream(outputStream, uri)
      }

      "contentTree" -> {
        val treeUriStr = destination.getString("treeUri")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'treeUri' in contentTree destination")
        val filename = destination.getString("filename")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'filename' in contentTree destination")
        val mimeType = destination.getString("mimeType")
          ?: throw FileIOException(FileIOErrorCodes.INVALID_ARGUMENT, "Missing 'mimeType' in contentTree destination")
        val treeUri = Uri.parse(treeUriStr)
        val resolver = context.contentResolver

        val docUri = try {
          SherpaOnnxContentUriUtils.createDocumentInDirectory(resolver, treeUri, filename, mimeType)
        } catch (e: SecurityException) {
          throw FileIOException(FileIOErrorCodes.PERMISSION_DENIED, "No permission for tree URI: $treeUriStr", e)
        } catch (e: Exception) {
          throw FileIOException(FileIOErrorCodes.WRITE_ERROR, "Failed to create document in tree: ${e.message}", e)
        }

        // SAF tree document: always OutputStream. Audio encode uses a temp file then copies (see SherpaOnnxModule).
        val outputStream = try {
          resolver.openOutputStream(docUri, "w")
        } catch (e: Exception) {
          throw FileIOException(FileIOErrorCodes.WRITE_ERROR, "Cannot open output stream for created document", e)
        } ?: throw FileIOException(FileIOErrorCodes.WRITE_ERROR, "Output stream is null for created document")
        WriteHandle.Stream(outputStream, docUri)
      }

      "securityScoped" -> throw FileIOException(
        FileIOErrorCodes.UNSUPPORTED_ON_PLATFORM,
        "securityScoped is not supported on Android"
      )

      else -> throw FileIOException(
        FileIOErrorCodes.UNSUPPORTED_LOCATION_KIND,
        "Unknown destination kind: $kind"
      )
    }
  }

  /**
   * Resolve a source to a local file path. If the source is a stream (contentUri),
   * copies to a temp file in cache first.
   */
  fun resolveSourceToFilePath(source: ReadableMap): File {
    val handle = resolveSource(source)
    return when (handle) {
      is ReadHandle.FilePath -> handle.file
      is ReadHandle.FileDescriptor -> {
        handle.use { h ->
          val tmpFile = File(context.cacheDir, "fileio_tmp_${java.util.UUID.randomUUID()}")
          FileInputStream(h.pfd.fileDescriptor).use { input ->
            tmpFile.outputStream().use { out ->
              input.copyTo(out, 65536)
            }
          }
          tmpFile
        }
      }
      is ReadHandle.Stream -> {
        handle.use { h ->
          val tmpFile = File(context.cacheDir, "fileio_tmp_${java.util.UUID.randomUUID()}")
          tmpFile.outputStream().use { out ->
            h.inputStream.copyTo(out, 65536)
          }
          tmpFile
        }
      }
    }
  }

  private fun resolveAppPath(base: String, relativePath: String): File {
    val baseDir = when (base) {
      "cache" -> context.cacheDir
      "documents" -> File(context.filesDir, "docs")
      "files" -> context.filesDir
      "tmp" -> File(context.cacheDir, "tmp")
      "externalFiles" -> context.getExternalFilesDir(null)
        ?: throw FileIOException(FileIOErrorCodes.UNSUPPORTED_ON_PLATFORM, "No external files directory available")
      "apkAsset" -> throw FileIOException(
        FileIOErrorCodes.INVALID_ARGUMENT,
        "apkAsset must be resolved via resolveApkAssetFile(), not resolveAppPath()"
      )
      else -> throw FileIOException(FileIOErrorCodes.UNSUPPORTED_LOCATION_KIND, "Unknown AppBaseDir: $base")
    }
    val resolved = File(baseDir, relativePath).canonicalFile
    if (!resolved.path.startsWith(baseDir.canonicalPath)) {
      throw FileIOException(FileIOErrorCodes.PATH_TRAVERSAL_BLOCKED, "Path escapes base directory")
    }
    return resolved
  }

  /**
   * Materialize a path under `android/app/src/main/assets/` to a readable cache file.
   * Used for {@code app} + {@code apkAsset} {@link FileSource} reads (probe/decode/encode/copy).
   */
  private fun resolveApkAssetFile(relativePath: String): File {
    val assetPath = relativePath.trim().removePrefix("/")
    if (assetPath.isEmpty() || assetPath.contains("..")) {
      throw FileIOException(FileIOErrorCodes.PATH_TRAVERSAL_BLOCKED, "Invalid apkAsset path: $relativePath")
    }
    val cacheRoot = File(context.cacheDir, "fileio_apkasset").canonicalFile
    val outFile = File(cacheRoot, assetPath.replace('/', File.separatorChar)).canonicalFile
    if (!outFile.path.startsWith(cacheRoot.path)) {
      throw FileIOException(FileIOErrorCodes.PATH_TRAVERSAL_BLOCKED, "apkAsset path escapes cache root")
    }
    if (outFile.exists() && outFile.isFile) {
      return outFile
    }
    outFile.parentFile?.mkdirs()
    try {
      context.assets.open(assetPath).use { input ->
        outFile.outputStream().use { output ->
          input.copyTo(output)
        }
      }
    } catch (e: java.io.FileNotFoundException) {
      throw FileIOException(
        FileIOErrorCodes.NOT_FOUND,
        "APK asset not found: $assetPath (expected under app/src/main/assets/)",
        e,
      )
    } catch (e: java.io.IOException) {
      throw FileIOException(
        FileIOErrorCodes.WRITE_ERROR,
        "Failed to materialize APK asset to cache: $assetPath — ${e.message}",
        e,
      )
    } catch (e: Exception) {
      throw FileIOException(
        FileIOErrorCodes.READ_ERROR,
        "Failed to read APK asset: $assetPath — ${e.message}",
        e,
      )
    }
    return outFile
  }

  private fun queryContentLength(uri: Uri): Long? {
    val resolver = context.contentResolver
    return try {
      var length: Long? = null
      resolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val idx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
          if (idx >= 0 && !cursor.isNull(idx)) {
            length = cursor.getLong(idx)
          }
        }
      }
      length
    } catch (_: Exception) {
      null
    }
  }
}
