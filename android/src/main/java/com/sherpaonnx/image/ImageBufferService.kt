package com.sherpaonnx.image

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Offline ImageBuffer create/release with HEIC via platform ImageDecoder,
 * JPEG/PNG/WebP/… via C++ (stb + libwebp).
 */
internal object ImageBufferService {
  private const val TAG = "SherpaOnnx:image"
  private const val DEFAULT_MAX_SIDE = 4096

  private val cancelFlags = ConcurrentHashMap<String, AtomicBoolean>()
  @Volatile private var initialized = false

  fun ensureInitialized(context: Context) {
    if (initialized) return
    synchronized(this) {
      if (initialized) return
      val cacheDir = File(context.cacheDir, "sherpa-image").apply { mkdirs() }
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      val memInfo = ActivityManager.MemoryInfo()
      am?.getMemoryInfo(memInfo)
      val totalRam = memInfo.totalMem.takeIf { it > 0 } ?: (6L * 1024 * 1024 * 1024)
      ImageBufferNative.nativeInit(cacheDir.absolutePath, totalRam)
      initialized = true
      Log.i(TAG, "ImageBufferService initialized cacheDir=${cacheDir.absolutePath}")
    }
  }

  fun requestCancel(operationId: String) {
    cancelFlags.getOrPut(operationId) { AtomicBoolean(false) }.set(true)
  }

  fun clearCancel(operationId: String) {
    cancelFlags.remove(operationId)
  }

  private fun isCancelled(operationId: String?): Boolean {
    if (operationId.isNullOrEmpty()) return false
    return cancelFlags[operationId]?.get() == true
  }

  fun createEmpty(): Map<String, Any> {
    val id = ImageBufferNative.nativeCreateEmpty()
    return ImageBufferNative.nativeGetInfo(id)
      ?: mapOf(
        "bufferId" to id,
        "kind" to "offlineImageBuffer",
        "state" to "immutable",
        "frameCount" to 0,
        "totalBytes" to 0L,
        "storageKind" to "ram",
      )
  }

  fun release(bufferId: String): Boolean = ImageBufferNative.nativeRelease(bufferId)

  fun getInfo(bufferId: String): Map<String, Any>? = ImageBufferNative.nativeGetInfo(bufferId)

  fun getFrameInfo(bufferId: String, frameIndex: Int): Map<String, Any>? =
    ImageBufferNative.nativeGetFrameInfo(bufferId, frameIndex)

  /**
   * Ensure frame RGB is resident. For non-lazy buffers returns current frame info.
   * @return frame info map on success; map with errorCode/errorMessage on failure; null if JNI null.
   */
  fun ensureFrame(bufferId: String, frameIndex: Int): Map<String, Any>? {
    val result = ImageBufferNative.nativeEnsureFrame(bufferId, frameIndex) ?: return null
    val ok = result["ok"] as? Boolean ?: false
    if (!ok) {
      return mapOf(
        "errorCode" to (result["errorCode"] as? String ?: "ERR_IMAGE_INTERNAL"),
        "errorMessage" to (result["errorMessage"] as? String ?: "ensure frame failed"),
      )
    }
    val out = mutableMapOf<String, Any>(
      "index" to ((result["index"] as? Number)?.toInt() ?: frameIndex),
      "width" to ((result["width"] as? Number)?.toInt() ?: 0),
      "height" to ((result["height"] as? Number)?.toInt() ?: 0),
      "byteSize" to ((result["byteSize"] as? Number)?.toLong() ?: 0L),
      "storageKind" to (result["storageKind"] as? String ?: "ram"),
    )
    (result["pageNumber"] as? Number)?.toInt()?.takeIf { it > 0 }?.let {
      out["pageNumber"] = it
    }
    (result["dpi"] as? Number)?.toInt()?.takeIf { it > 0 }?.let {
      out["dpi"] = it
    }
    return out
  }

  /**
   * Encode [frameIndex] to an absolute filesystem path (caller owns FileDestination).
   * @return null on success; otherwise a map with errorCode/errorMessage.
   */
  fun exportFrameToPath(
    bufferId: String,
    frameIndex: Int,
    outPath: String,
    format: String,
    quality: Int,
    maxSide: Int,
  ): Map<String, Any>? {
    val result = ImageBufferNative.nativeExportFrame(
      bufferId,
      frameIndex,
      outPath,
      format,
      quality,
      maxSide,
    ) ?: return mapOf(
      "errorCode" to "ERR_IMAGE_INTERNAL",
      "errorMessage" to "nativeExportFrame returned null",
    )
    val ok = result["ok"] as? Boolean ?: false
    if (ok) return null
    return mapOf(
      "errorCode" to (result["errorCode"] as? String ?: "ERR_IMAGE_ENCODE_FAILED"),
      "errorMessage" to (result["errorMessage"] as? String ?: "encode failed"),
    )
  }

  /** Build an ARGB_8888 bitmap for FrameView preview (JNI fill; not via JS). */
  fun copyFrameBitmap(bufferId: String, frameIndex: Int, maxSide: Int): Bitmap? =
    ImageBufferNative.nativeCreateFrameBitmap(bufferId, frameIndex, maxSide)

  /**
   * Create from already-resolved image bytes.
   * [fileOrigin] selects mmap threshold path (true for FileSource create, false for base64/heap).
   */
  fun createFromBytesList(
    context: Context,
    blobs: List<ByteArray>,
    maxSide: Int = DEFAULT_MAX_SIDE,
    operationId: String? = null,
    fileOrigin: Boolean = false,
    onProgress: ((done: Int, total: Int, phase: String) -> Unit)? = null,
  ): Map<String, Any> {
    ensureInitialized(context)
    if (blobs.isEmpty()) {
      throw RuntimeException("ERR_IMAGE_INVALID_ARGUMENT: no blobs")
    }
    if (!operationId.isNullOrEmpty()) {
      cancelFlags[operationId] = AtomicBoolean(false)
    }
    val bufferId = ImageBufferNative.nativeCreateEmpty()
    try {
      val total = blobs.size
      blobs.forEachIndexed { index, bytes ->
        if (isCancelled(operationId)) {
          ImageBufferNative.nativeRelease(bufferId)
          throw RuntimeException("ERR_IMAGE_CANCELLED: cancelled")
        }
        onProgress?.invoke(index, total, "decode")
        appendDecoded(
          context,
          bufferId,
          bytes,
          maxSide,
          fileOrigin = fileOrigin,
          sourceHint = "bytes[$index]",
        )
      }
      onProgress?.invoke(total, total, "done")
      ImageBufferNative.nativeMaybeUpgrade(bufferId, fileOrigin)
      return ImageBufferNative.nativeGetInfo(bufferId)
        ?: throw RuntimeException("ERR_IMAGE_DECODE_FAILED: missing info after create")
    } catch (e: Exception) {
      ImageBufferNative.nativeRelease(bufferId)
      throw e
    } finally {
      if (!operationId.isNullOrEmpty()) clearCancel(operationId)
    }
  }

  private fun appendDecoded(
    context: Context,
    bufferId: String,
    bytes: ByteArray,
    maxSide: Int,
    fileOrigin: Boolean,
    sourceHint: String,
  ) {
    val format = ImageBufferNative.nativeDetectFormat(bytes)
    if (format == "heic") {
      val rgb = decodeHeicToRgb(context, bytes, maxSide)
        ?: throw RuntimeException("ERR_IMAGE_FORMAT_UNSUPPORTED: HEIC decode failed ($sourceHint)")
      val result = ImageBufferNative.nativeAppendRgb(
        bufferId, rgb.width, rgb.height, rgb.rgb, fileOrigin
      ) ?: throw RuntimeException("ERR_IMAGE_DECODE_FAILED: appendRgb null")
      if (result["ok"] != true) {
        val code = result["errorCode"] as? String ?: "ERR_IMAGE_DECODE_FAILED"
        val msg = result["errorMessage"] as? String ?: "HEIC append failed"
        throw RuntimeException("$code: $msg ($sourceHint)")
      }
      Log.i(TAG, "HEIC decoded ${rgb.width}x${rgb.height} -> $bufferId ($sourceHint)")
      return
    }

    val result = ImageBufferNative.nativeDecodeAndAppend(bufferId, bytes, maxSide, fileOrigin)
      ?: throw RuntimeException("ERR_IMAGE_DECODE_FAILED: decodeAndAppend null ($sourceHint)")
    if (result["ok"] != true) {
      val code = result["errorCode"] as? String ?: "ERR_IMAGE_DECODE_FAILED"
      val msg = result["errorMessage"] as? String ?: "decode failed"
      throw RuntimeException("$code: $msg ($sourceHint)")
    }
  }

  private data class RgbPack(val width: Int, val height: Int, val rgb: ByteArray)

  private fun decodeHeicToRgb(context: Context, bytes: ByteArray, maxSide: Int): RgbPack? {
    if (Build.VERSION.SDK_INT < 28) {
      Log.w(TAG, "HEIC requires API 28+ ImageDecoder")
      return null
    }
    var tempFile: File? = null
    return try {
      // ByteBuffer source is API 31+; use a temp file for API 28–30.
      val source = if (Build.VERSION.SDK_INT >= 31) {
        ImageDecoder.createSource(ByteBuffer.wrap(bytes))
      } else {
        tempFile = File.createTempFile("heic_", ".heic", context.cacheDir)
        tempFile.writeBytes(bytes)
        ImageDecoder.createSource(tempFile)
      }
      var bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        decoder.isMutableRequired = true
        val w = info.size.width
        val h = info.size.height
        val longest = max(w, h)
        if (maxSide > 0 && longest > maxSide) {
          val scale = maxSide.toFloat() / longest.toFloat()
          decoder.setTargetSize(
            (w * scale).roundToInt().coerceAtLeast(1),
            (h * scale).roundToInt().coerceAtLeast(1),
          )
        }
      }
      if (bitmap.config != Bitmap.Config.ARGB_8888) {
        bitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false)
      }
      val w = bitmap.width
      val h = bitmap.height
      val pixels = IntArray(w * h)
      bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
      val rgb = ByteArray(w * h * 3)
      var o = 0
      for (p in pixels) {
        rgb[o++] = ((p shr 16) and 0xff).toByte()
        rgb[o++] = ((p shr 8) and 0xff).toByte()
        rgb[o++] = (p and 0xff).toByte()
      }
      bitmap.recycle()
      RgbPack(w, h, rgb)
    } catch (e: Exception) {
      Log.w(TAG, "HEIC ImageDecoder failed: ${e.message}")
      null
    } finally {
      tempFile?.delete()
    }
  }

}
