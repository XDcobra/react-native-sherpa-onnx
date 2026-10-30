package com.sherpaonnx.fileio

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File

/**
 * LRU + age cache for stream-only FileSources materialized under
 * `<cache>/fileio_nofd/`. Pinned paths (open demuxers) are never deleted.
 */
internal class NoFdCache(private val context: ReactApplicationContext) {

  companion object {
    const val DIR_NAME = "fileio_nofd"
    const val DEFAULT_MAX_BYTES = 512L * 1024L * 1024L
    const val DEFAULT_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    private const val TAG = "SherpaOnnxFileIO"
  }

  @Volatile
  var maxBytes: Long = DEFAULT_MAX_BYTES
    private set

  @Volatile
  var maxAgeMs: Long = DEFAULT_MAX_AGE_MS
    private set

  private val mu = Any()
  private val pins = HashMap<String, Int>()

  fun root(): File = File(context.cacheDir, DIR_NAME).canonicalFile

  fun isCachePath(path: String): Boolean {
    return try {
      val file = File(path).canonicalFile
      val root = root()
      file.path == root.path || file.path.startsWith(root.path + File.separator)
    } catch (_: Exception) {
      false
    }
  }

  fun pin(path: String) {
    if (!isCachePath(path)) return
    val key = canonical(path) ?: return
    val count = synchronized(mu) {
      val n = (pins[key] ?: 0) + 1
      pins[key] = n
      n
    }
    Log.i(TAG, "nofd pin path=$key count=$count")
  }

  fun unpin(path: String) {
    if (!isCachePath(path)) return
    val key = canonical(path) ?: return
    synchronized(mu) {
      val n = (pins[key] ?: 0) - 1
      if (n <= 0) pins.remove(key) else pins[key] = n
      Log.i(TAG, "nofd unpin path=$key count=${pins[key] ?: 0}")
    }
    evict()
  }

  fun touch(file: File) {
    try {
      file.setLastModified(System.currentTimeMillis())
    } catch (_: Exception) {
    }
  }

  fun configure(maxBytes: Long?, maxAgeMs: Long?) {
    if (maxBytes != null) {
      if (maxBytes <= 0L) {
        throw FileIOException(
          FileIOErrorCodes.INVALID_ARGUMENT,
          "noFdCache.maxBytes must be > 0",
        )
      }
      this.maxBytes = maxBytes
    }
    if (maxAgeMs != null) {
      if (maxAgeMs < 0L) {
        throw FileIOException(
          FileIOErrorCodes.INVALID_ARGUMENT,
          "noFdCache.maxAgeMs must be >= 0",
        )
      }
      this.maxAgeMs = maxAgeMs
    }
    Log.i(TAG, "nofd policy maxBytes=${this.maxBytes} maxAgeMs=${this.maxAgeMs}")
    evict()
  }

  fun evict() {
    val dir = try {
      root()
    } catch (_: Exception) {
      return
    }
    if (!dir.isDirectory) return
    val now = System.currentTimeMillis()
    val ageLimit = maxAgeMs
    val cap = maxBytes

    fun entries(): List<Ent> {
      val files = dir.listFiles() ?: return emptyList()
      return synchronized(mu) {
        files.mapNotNull { f ->
          if (!f.isFile || f.name.endsWith(".tmp")) {
            return@mapNotNull null
          }
          val key = canonical(f.absolutePath) ?: f.absolutePath
          Ent(f, key, f.length(), f.lastModified(), (pins[key] ?: 0) > 0)
        }
      }
    }

    for (e in entries()) {
      if (e.pinned) continue
      val expired = if (ageLimit == 0L) true else now - e.mtime > ageLimit
      if (expired) {
        Log.i(TAG, "nofd evict age path=${e.file.absolutePath} ageMs=${now - e.mtime}")
        try {
          e.file.delete()
        } catch (_: Exception) {
        }
      }
    }

    val live = entries()
    var total = live.sumOf { it.size }
    if (total <= cap) return
    val unpinned = live.filter { !it.pinned }.sortedBy { it.mtime }
    for (e in unpinned) {
      if (total <= cap) break
      Log.i(
        TAG,
        "nofd evict lru path=${e.file.absolutePath} size=${e.size} total=$total cap=$cap",
      )
      try {
        if (e.file.delete()) {
          total -= e.size
        }
      } catch (_: Exception) {
      }
    }
  }

  private fun canonical(path: String): String? {
    return try {
      File(path).canonicalFile.absolutePath
    } catch (_: Exception) {
      null
    }
  }

  private data class Ent(
    val file: File,
    val key: String,
    val size: Long,
    val mtime: Long,
    val pinned: Boolean,
  )
}
