package com.sherpaonnx.audio.pipeline

/**
 * Shared Live audio buffer types (events, origins, persistence).
 * PCM storage SoT lives in shared C++ AudioRegistry / PaLiveEntry.
 */

enum class LiveAudioIngressSource(val wireValue: String) {
  MIC("mic"),
  APPEND("append"),
  APPEND_OFFLINE("append_offline"),
  FILE_INGEST("file_ingest"),
}

enum class LiveAudioPipelineWriter(val wireValue: String) {
  ENHANCEMENT("enhancement"),
  TTS("tts"),
  SEPARATION("separation"),
}

enum class LiveAudioAppendKind(val wireValue: String) {
  INGRESS("ingress"),
  PIPELINE("pipeline"),
  MIXED("mixed"),
}

sealed class LiveAppendOrigin {
  data class Ingress(val source: LiveAudioIngressSource) : LiveAppendOrigin()
  data class Pipeline(val writer: LiveAudioPipelineWriter) : LiveAppendOrigin()
}

data class LiveAppendEventConfig(
  val enabled: Boolean = false,
  val minIntervalMs: Int = 0,
)

data class LiveFramesAppendedEvent(
  val liveBufferId: String,
  val appendKind: LiveAudioAppendKind,
  val ingressSource: LiveAudioIngressSource?,
  val pipelineWriter: LiveAudioPipelineWriter?,
  val sampleRate: Int,
  val frameCount: Int,
  val totalSamplesWritten: Long,
) {
  companion object {
    fun fromOrigin(
      liveBufferId: String,
      origin: LiveAppendOrigin,
      sampleRate: Int,
      frameCount: Int,
      totalSamplesWritten: Long,
    ): LiveFramesAppendedEvent =
      when (origin) {
        is LiveAppendOrigin.Ingress ->
          LiveFramesAppendedEvent(
            liveBufferId = liveBufferId,
            appendKind = LiveAudioAppendKind.INGRESS,
            ingressSource = origin.source,
            pipelineWriter = null,
            sampleRate = sampleRate,
            frameCount = frameCount,
            totalSamplesWritten = totalSamplesWritten,
          )
        is LiveAppendOrigin.Pipeline ->
          LiveFramesAppendedEvent(
            liveBufferId = liveBufferId,
            appendKind = LiveAudioAppendKind.PIPELINE,
            ingressSource = null,
            pipelineWriter = origin.writer,
            sampleRate = sampleRate,
            frameCount = frameCount,
            totalSamplesWritten = totalSamplesWritten,
          )
      }

    fun mixed(
      liveBufferId: String,
      sampleRate: Int,
      frameCount: Int,
      totalSamplesWritten: Long,
    ): LiveFramesAppendedEvent =
      LiveFramesAppendedEvent(
        liveBufferId = liveBufferId,
        appendKind = LiveAudioAppendKind.MIXED,
        ingressSource = null,
        pipelineWriter = null,
        sampleRate = sampleRate,
        frameCount = frameCount,
        totalSamplesWritten = totalSamplesWritten,
      )
  }
}

enum class RetentionMode {
  AUTO,
  SESSION,
  MAX_SECONDS,
  PATH,
  NONE,
}

data class PersistenceConfig(
  val filePath: String,
  val retentionMode: RetentionMode = RetentionMode.SESSION,
  val retentionSeconds: Double = 0.0,
)

class CursorLagExceededException(message: String) : RuntimeException(message)
