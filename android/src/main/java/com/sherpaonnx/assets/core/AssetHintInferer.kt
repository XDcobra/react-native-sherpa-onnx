package com.sherpaonnx.assets.core

internal object AssetHintInferer {
  private val sttHints = listOf(
    "zipformer",
    "paraformer",
    "nemo",
    "parakeet",
    "whisper",
    "wenet",
    "sensevoice",
    "sense-voice",
    "sense",
    "funasr",
    "transducer",
    "ctc",
    "asr",
  )

  private val ttsHints = listOf(
    "vits",
    "piper",
    "matcha",
    "kokoro",
    "kitten",
    "pocket",
    "zipvoice",
    "melo",
    "coqui",
    "mms",
    "tts",
  )

  private val enhancementHints = listOf(
    "gtcrn",
    "dpdfnet",
  )

  /** Subtitle / forced CTC alignment (wav2vec2 bundles). Must run before STT heuristics. */
  private val alignmentHints = listOf(
    "wav2vec2",
  )

  fun inferModelHint(folderName: String): String {
    val name = folderName.lowercase()
    if (alignmentHints.any { name.contains(it) }) {
      return "alignment"
    }
    val isStt = sttHints.any { name.contains(it) }
    val isTts = ttsHints.any { name.contains(it) }
    val isEnhancement = enhancementHints.any { name.contains(it) }

    return when {
      isStt && !isTts -> "stt"
      isTts && !isStt -> "tts"
      isEnhancement && !isStt && !isTts -> "enhancement"
      else -> "unknown"
    }
  }
}
