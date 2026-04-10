package com.sherpaonnx.tts.core

/** User-facing explanation when a [com.sherpaonnx.tts.core.BatchPcmSink] generation no longer matches. */
internal fun ttsStaleGenerationUserMessage(requested: Long, current: Long): String =
  "Generation $requested is no longer available; the native sink now holds generation $current. " +
    "Each TTS engine keeps only the latest synthesis in that sink - call getSamples() or " +
    "saveAudioFromGeneration() before the next generateSpeech on the same engine, or use a " +
    "second createTTS() instance. See docs/tts-offline.md (Data lifetime)."
