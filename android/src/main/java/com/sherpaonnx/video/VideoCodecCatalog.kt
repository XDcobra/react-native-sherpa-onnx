package com.sherpaonnx.video

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build

/**
 * HW-only codec names for VideoBuffer. Software `c2.android.*` / `OMX.google.*`
 * are excluded. Emulators typically have no HW decoder → decode APIs return
 * VIDEO_DECODER_UNAVAILABLE.
 */
internal object VideoCodecCatalog {
  data class Names(val decoder: String?, val encoder: String?)

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
