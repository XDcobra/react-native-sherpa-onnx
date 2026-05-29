package com.sherpaonnx.download

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Foreground HTTP downloader with HTTP Range resume (pause, app restart, partial files on disk).
 * No foreground service or system notifications.
 */
object ForegroundDownloader {
  private const val TAG = "ForegroundDownloader"
  private const val CONNECT_TIMEOUT_MS = 30_000
  private const val READ_TIMEOUT_MS = 120_000
  private const val BUFFER_SIZE = 64 * 1024
  private const val PROGRESS_MIN_INTERVAL_MS = 200L
  private const val USER_AGENT = "react-native-sherpa-onnx/1.0"

  interface EventListener {
    fun onBegin(id: String, expectedBytes: Long, headers: Map<String, String>)
    fun onProgress(id: String, bytesDownloaded: Long, bytesTotal: Long)
    fun onComplete(id: String, location: String, bytesDownloaded: Long, bytesTotal: Long)
    fun onError(id: String, error: String, errorCode: Int)
  }

  @Volatile
  var eventListener: EventListener? = null

  data class DownloadState(
    val id: String,
    val url: String,
    val destination: String,
    val headers: Map<String, String>,
    val isPaused: AtomicBoolean = AtomicBoolean(false),
    val isCancelled: AtomicBoolean = AtomicBoolean(false),
    val bytesDownloaded: AtomicLong = AtomicLong(0),
    @Volatile var bytesTotal: Long = -1,
    @Volatile var thread: Thread? = null,
    @Volatile var call: okhttp3.Call? = null,
    @Volatile var inputStream: InputStream? = null,
    var hasReportedBegin: Boolean = false,
    val sessionId: AtomicLong = AtomicLong(0),
    @Volatile var lastProgressEmitMs: Long = 0,
  )

  private val activeDownloads = ConcurrentHashMap<String, DownloadState>()

  private val httpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(CONNECT_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
      .readTimeout(READ_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
      .followRedirects(true)
      .followSslRedirects(true)
      .dns(
        object : Dns {
          override fun lookup(hostname: String): List<InetAddress> {
            return InetAddress.getAllByName(hostname)
              .sortedBy { if (it.hostAddress?.contains(":") == true) 1 else 0 }
          }
        }
      )
      .build()
  }

  private sealed class DownloadResult {
    data class Success(
      val id: String,
      val location: String,
      val bytesDownloaded: Long,
      val bytesTotal: Long,
    ) : DownloadResult()

    data class Paused(val id: String, val bytesDownloaded: Long, val bytesTotal: Long) :
      DownloadResult()

    data class Cancelled(val id: String) : DownloadResult()
    data class SessionInvalidated(val id: String) : DownloadResult()

    data class Error(val id: String, val message: String, val errorCode: Int) :
      DownloadResult() {
      companion object {
        fun httpError(id: String, code: Int, message: String? = null): Error {
          val msg = message ?: "HTTP $code"
          return Error(id, msg, code)
        }
      }
    }
  }

  /**
   * Start or resume a download. If [destination] already has bytes on disk, uses Range resume.
   */
  fun start(
    id: String,
    url: String,
    destination: String,
    headers: Map<String, String>,
  ): Boolean {
    val destFile = File(destination)
    val existingOnDisk =
      if (destFile.exists() && destFile.isFile) destFile.length() else 0L

    val existingState = activeDownloads[id]
    if (existingState != null) {
      cancelInternal(existingState, deletePartialFile = false)
    }

    val state =
      DownloadState(
        id = id,
        url = url,
        destination = destination,
        headers = headers,
      )

    if (existingOnDisk > 0) {
      state.bytesDownloaded.set(existingOnDisk)
      state.hasReportedBegin = true
      Log.d(TAG, "Resuming from disk: $id at byte $existingOnDisk")
    }

    activeDownloads[id] = state
    val sessionId = state.sessionId.get()
    val thread =
      Thread {
        downloadWithResume(state, sessionId)
      }
    state.thread = thread
    thread.start()
    return true
  }

  fun pause(id: String): Boolean {
    val state = activeDownloads[id] ?: return false
    state.sessionId.incrementAndGet()
    state.isPaused.set(true)
    try {
      state.inputStream?.close()
    } catch (_: Exception) {
    }
    try {
      state.call?.cancel()
    } catch (_: Exception) {
    }
    state.thread?.interrupt()
    Log.d(TAG, "Paused: $id at ${state.bytesDownloaded.get()} bytes")
    return true
  }

  fun resume(id: String): Boolean {
    val state = activeDownloads[id] ?: return false
    if (!state.isPaused.get()) {
      return false
    }
    state.isPaused.set(false)
    val sessionId = state.sessionId.get()
    val thread =
      Thread {
        downloadWithResume(state, sessionId)
      }
    state.thread = thread
    thread.start()
    Log.d(TAG, "Resumed in-process: $id from ${state.bytesDownloaded.get()} bytes")
    return true
  }

  /** Stop network activity; does not delete the partial file (caller cleans up). */
  fun cancel(id: String): Boolean {
    val state = activeDownloads.remove(id) ?: return false
    cancelInternal(state, deletePartialFile = false)
    return true
  }

  private fun cancelInternal(state: DownloadState, deletePartialFile: Boolean) {
    state.sessionId.incrementAndGet()
    state.isCancelled.set(true)
    state.isPaused.set(false)
    try {
      state.inputStream?.close()
    } catch (_: Exception) {
    }
    try {
      state.call?.cancel()
    } catch (_: Exception) {
    }
    state.thread?.interrupt()
    if (deletePartialFile) {
      val destFile = File(state.destination)
      if (destFile.exists()) {
        destFile.delete()
      }
    }
  }

  private fun downloadWithResume(state: DownloadState, expectedSessionId: Long) {
    val listener = eventListener
    if (listener == null) {
      Log.w(TAG, "No event listener registered")
      return
    }

    when (val result = executeDownload(state, listener, expectedSessionId)) {
      is DownloadResult.Success -> {
        // onComplete already emitted
      }
      is DownloadResult.Paused -> {
        Log.d(TAG, "Paused (async): ${result.id} at ${result.bytesDownloaded}")
      }
      is DownloadResult.Cancelled -> {
        Log.d(TAG, "Cancelled: ${result.id}")
      }
      is DownloadResult.SessionInvalidated -> {
        Log.d(TAG, "Session invalidated: ${result.id}")
      }
      is DownloadResult.Error -> {
        // onError already emitted
      }
    }
  }

  private fun executeDownload(
    state: DownloadState,
    listener: EventListener,
    expectedSessionId: Long,
  ): DownloadResult {
    var response: Response? = null
    var inputStream: InputStream? = null
    var outputStream: FileOutputStream? = null

    try {
      if (state.sessionId.get() != expectedSessionId) {
        return DownloadResult.SessionInvalidated(state.id)
      }
      if (state.isCancelled.get()) {
        return DownloadResult.Cancelled(state.id)
      }

      val destFile = File(state.destination)
      val parentDir = destFile.parentFile
      if (parentDir != null && !parentDir.exists()) {
        parentDir.mkdirs()
      }

      // Sync bytes from disk (app restart / external write)
      if (destFile.exists() && destFile.isFile) {
        val diskBytes = destFile.length()
        if (diskBytes > state.bytesDownloaded.get()) {
          state.bytesDownloaded.set(diskBytes)
        }
      }

      val requestBuilder = Request.Builder().url(state.url)
      for ((key, value) in state.headers) {
        requestBuilder.header(key, value)
      }
      if (!state.headers.keys.any { it.equals("User-Agent", ignoreCase = true) }) {
        requestBuilder.header("User-Agent", USER_AGENT)
      }

      val startByte = state.bytesDownloaded.get()
      if (startByte > 0) {
        requestBuilder.header("Range", "bytes=$startByte-")
        Log.d(TAG, "Range request: bytes=$startByte- for ${state.id}")
      }

      val call = httpClient.newCall(requestBuilder.get().build())
      state.call = call
      response = call.execute()
      val responseCode = response.code

      when (responseCode) {
        HttpURLConnection.HTTP_OK -> {
          val contentLength = response.body?.contentLength() ?: -1
          state.bytesTotal = contentLength

          if (startByte > 0) {
            Log.w(
              TAG,
              "Server returned 200 instead of 206; restarting from beginning for ${state.id}"
            )
            state.bytesDownloaded.set(0)
            destFile.delete()
          }

          if (!state.hasReportedBegin) {
            state.hasReportedBegin = true
            listener.onBegin(state.id, state.bytesTotal, responseHeaders(response))
          }
        }
        HttpURLConnection.HTTP_PARTIAL -> {
          val contentRange = response.header("Content-Range")
          if (contentRange != null) {
            val total = contentRange.substringAfter("/").toLongOrNull()
            if (total != null) {
              state.bytesTotal = total
            }
          }
          if (state.bytesTotal <= 0) {
            val partialLength = response.body?.contentLength() ?: -1
            state.bytesTotal =
              if (partialLength > 0) startByte + partialLength else -1
          }
          if (!state.hasReportedBegin) {
            state.hasReportedBegin = true
            listener.onBegin(state.id, state.bytesTotal, responseHeaders(response))
          }
        }
        416 -> {
          if (
            destFile.exists() &&
            state.bytesTotal > 0 &&
            destFile.length() >= state.bytesTotal
          ) {
            activeDownloads.remove(state.id)
            val total = state.bytesTotal
            listener.onComplete(state.id, state.destination, total, total)
            return DownloadResult.Success(state.id, state.destination, total, total)
          }
          val error = DownloadResult.Error.httpError(state.id, 416, "Range not satisfiable")
          listener.onError(state.id, error.message, error.errorCode)
          return error
        }
        else -> {
          val error = DownloadResult.Error.httpError(state.id, responseCode)
          listener.onError(state.id, error.message, error.errorCode)
          return error
        }
      }

      inputStream = response.body?.byteStream()
      if (inputStream == null) {
        val error = DownloadResult.Error.httpError(state.id, responseCode, "Empty body")
        listener.onError(state.id, error.message, error.errorCode)
        return error
      }
      state.inputStream = inputStream

      val shouldAppend =
        startByte > 0 && responseCode == HttpURLConnection.HTTP_PARTIAL
      outputStream = FileOutputStream(destFile, shouldAppend)

      val buffer = ByteArray(BUFFER_SIZE)
      while (true) {
        if (state.sessionId.get() != expectedSessionId) {
          return DownloadResult.SessionInvalidated(state.id)
        }
        if (state.isCancelled.get()) {
          return DownloadResult.Cancelled(state.id)
        }
        if (state.isPaused.get()) {
          outputStream.flush()
          return DownloadResult.Paused(
            state.id,
            state.bytesDownloaded.get(),
            state.bytesTotal,
          )
        }

        val bytesRead = inputStream.read(buffer)
        if (bytesRead == -1) {
          break
        }

        if (state.sessionId.get() != expectedSessionId) {
          return DownloadResult.SessionInvalidated(state.id)
        }
        if (state.isCancelled.get()) {
          return DownloadResult.Cancelled(state.id)
        }

        outputStream.write(buffer, 0, bytesRead)
        val newTotal = state.bytesDownloaded.addAndGet(bytesRead.toLong())

        if (state.sessionId.get() == expectedSessionId && !state.isCancelled.get()) {
          maybeEmitProgress(state, listener, newTotal)
        }
      }

      outputStream.flush()

      if (state.sessionId.get() != expectedSessionId) {
        return DownloadResult.SessionInvalidated(state.id)
      }
      if (state.isCancelled.get()) {
        return DownloadResult.Cancelled(state.id)
      }

      val bytesDownloaded = state.bytesDownloaded.get()
      val bytesTotal = state.bytesTotal
      activeDownloads.remove(state.id)
      listener.onComplete(state.id, state.destination, bytesDownloaded, bytesTotal)
      return DownloadResult.Success(
        state.id,
        state.destination,
        bytesDownloaded,
        bytesTotal,
      )
    } catch (e: Exception) {
      if (state.isPaused.get()) {
        return DownloadResult.Paused(
          state.id,
          state.bytesDownloaded.get(),
          state.bytesTotal,
        )
      }
      if (state.isCancelled.get() || state.sessionId.get() != expectedSessionId) {
        return DownloadResult.Cancelled(state.id)
      }
      val message = e.message ?: e.javaClass.simpleName
      listener.onError(state.id, message, -1)
      return DownloadResult.Error(state.id, message, -1)
    } finally {
      try {
        inputStream?.close()
      } catch (_: Exception) {
      }
      try {
        outputStream?.close()
      } catch (_: Exception) {
      }
      try {
        response?.close()
      } catch (_: Exception) {
      }
      state.inputStream = null
      state.call = null
    }
  }

  private fun maybeEmitProgress(
    state: DownloadState,
    listener: EventListener,
    bytesDownloaded: Long,
  ) {
    val now = System.currentTimeMillis()
    if (now - state.lastProgressEmitMs < PROGRESS_MIN_INTERVAL_MS) {
      return
    }
    state.lastProgressEmitMs = now
    listener.onProgress(state.id, bytesDownloaded, state.bytesTotal)
  }

  private fun responseHeaders(response: Response): Map<String, String> {
    val map = mutableMapOf<String, String>()
    response.headers.names().forEach { key ->
      response.header(key)?.let { value ->
        map[key] = value
      }
    }
    return map
  }
}
