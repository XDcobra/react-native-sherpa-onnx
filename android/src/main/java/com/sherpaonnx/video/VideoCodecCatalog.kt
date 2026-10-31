package com.sherpaonnx.video

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.Log

/**
 * Video codec listing for VideoBuffer.
 *
 * [find] stays HW-only (Phase 0 / current decode path). [dumpAll] logs every
 * AVC/HEVC codec when debug is on — evidence for the shared codec layer.
 */
internal object VideoCodecCatalog {
  private const val TAG = "SherpaOnnxCodec"

  data class Names(val decoder: String?, val encoder: String?)

  data class Entry(
    val name: String,
    val mime: String,
    val encoder: Boolean,
    val hardware: Boolean,
    val minW: Int,
    val minH: Int,
    val maxW: Int,
    val maxH: Int,
    val alignW: Int,
    val alignH: Int,
    val maxBlocks: Long,
    val blockW: Int,
    val blockH: Int,
    val maxInstances: Int,
    val fps1080: Double,
  )

  fun find(mime: String): Names {
    var decoder: String? = null
    var encoder: String? = null
    val list = MediaCodecList(MediaCodecList.ALL_CODECS)
    for (info in list.codecInfos) {
      if (!info.supportedTypes.any { it.equals(mime, ignoreCase = true) }) continue
      if (!isHardware(info)) continue
      if (info.isEncoder) {
        if (encoder == null) encoder = info.name
      } else if (decoder == null) {
        decoder = info.name
      }
    }
    return Names(decoder, encoder)
  }

  fun listAvcHevc(): List<Entry> {
    val out = ArrayList<Entry>()
    val list = MediaCodecList(MediaCodecList.ALL_CODECS)
    for (mime in arrayOf("video/avc", "video/hevc")) {
      for (info in list.codecInfos) {
        if (!info.supportedTypes.any { it.equals(mime, ignoreCase = true) }) continue
        out.add(toEntry(info, mime))
      }
    }
    return out
  }

  /** Log every AVC/HEVC codec. Safe to call on a background thread. */
  fun dumpAll() {
    for (e in listAvcHevc()) {
      Log.i(
        TAG,
        "codec.catalog.raw name=${e.name} mime=${e.mime} encoder=${if (e.encoder) 1 else 0} " +
          "hw=${if (e.hardware) 1 else 0} max=${e.maxW}x${e.maxH} min=${e.minW}x${e.minH} " +
          "align=${e.alignW}x${e.alignH} blocks=${e.maxBlocks} block=${e.blockW}x${e.blockH} " +
          "inst=${e.maxInstances} fps1080=${e.fps1080.toInt()}",
      )
    }
  }

  private fun toEntry(info: MediaCodecInfo, mime: String): Entry {
    val hardware = isHardware(info)
    var maxW = 0
    var maxH = 0
    var minW = 0
    var minH = 0
    var alignW = 1
    var alignH = 1
    var maxBlocks = 0L
    var blockW = 16
    var blockH = 16
    var inst = 0
    var fps1080 = 0.0
    try {
      val caps = info.getCapabilitiesForType(mime)
      val vc = caps.videoCapabilities
      if (vc != null) {
        minW = vc.supportedWidths.lower
        maxW = vc.supportedWidths.upper
        minH = vc.supportedHeights.lower
        maxH = vc.supportedHeights.upper
        alignW = vc.widthAlignment
        alignH = vc.heightAlignment
        val block = tryInvoke(vc, "getBlockSize")
        blockW = parseBlockDim(block, 0).takeIf { it > 0 } ?: 16
        blockH = parseBlockDim(block, 1).takeIf { it > 0 } ?: 16
        val blocks = tryInvoke(vc, "getSupportedBlocks")
        maxBlocks = Regex("\\d+").findAll(blocks).map { it.value.toLong() }.maxOrNull()
          ?: if (maxW > 0 && maxH > 0) {
            ((maxW + blockW - 1) / blockW).toLong() * ((maxH + blockH - 1) / blockH)
          } else {
            0L
          }
        fps1080 = measuredFps1080(vc).toDouble()
      }
      if (Build.VERSION.SDK_INT >= 23) {
        inst = caps.maxSupportedInstances
      }
    } catch (e: Exception) {
      Log.w(TAG, "codec.catalog entry name=${info.name} mime=$mime failed: ${e.message}")
    }
    return Entry(
      name = info.name,
      mime = mime,
      encoder = info.isEncoder,
      hardware = hardware,
      minW = minW,
      minH = minH,
      maxW = maxW,
      maxH = maxH,
      alignW = alignW,
      alignH = alignH,
      maxBlocks = maxBlocks,
      blockW = blockW,
      blockH = blockH,
      maxInstances = inst,
      fps1080 = fps1080,
    )
  }

  private fun measuredFps1080(vc: MediaCodecInfo.VideoCapabilities): Int {
    if (Build.VERSION.SDK_INT < 29) return 0
    val points = vc.supportedPerformancePoints ?: return 0
    var best = 0
    for (fps in intArrayOf(24, 25, 30, 48, 50, 60, 90, 120, 240)) {
      val probe = MediaCodecInfo.VideoCapabilities.PerformancePoint(1920, 1080, fps)
      for (p in points) {
        if (p.covers(probe)) best = maxOf(best, fps)
      }
    }
    return best
  }

  private fun tryInvoke(target: Any, method: String): String {
    return try {
      val m = target.javaClass.methods.firstOrNull { it.name == method && it.parameterCount == 0 }
        ?: return "-"
      m.invoke(target)?.toString() ?: "-"
    } catch (_: Throwable) {
      "-"
    }
  }

  private fun parseBlockDim(block: String, index: Int): Int {
    // "Point(16, 16)" or "16x16"
    val nums = Regex("\\d+").findAll(block).map { it.value.toInt() }.toList()
    return nums.getOrNull(index) ?: 0
  }

  private fun isHardware(info: MediaCodecInfo): Boolean {
    val name = info.name.lowercase()
    if (name.startsWith("c2.android.") || name.startsWith("omx.google.")) {
      return false
    }
    if (Build.VERSION.SDK_INT >= 29) {
      return info.isHardwareAccelerated
    }
    return !name.contains("sw") && !name.contains("software")
  }
}
