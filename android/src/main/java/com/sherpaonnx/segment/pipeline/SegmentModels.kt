package com.sherpaonnx.segment.pipeline

data class SegmentRecord(
  val id: String,
  val kind: String,
  val sourceAudioBufferId: String,
  val startSample: Int,
  val endSample: Int,
  val sampleRate: Int,
  val durationMs: Int,
  val confidence: Double? = null,
  val payloadJson: String? = null,
)

enum class SegmentSpoolingMode {
  OFF,
  AUTO,
  ON;

  fun rawValue(): String = when (this) {
    OFF -> "off"
    AUTO -> "auto"
    ON -> "on"
  }

  companion object {
    fun fromRaw(raw: String?): SegmentSpoolingMode {
      return when (raw?.trim()?.lowercase()) {
        "off" -> OFF
        "auto" -> AUTO
        "on", null, "" -> ON
        else -> throw SegmentPipelineException(
          SegmentErrorCodes.INVALID_ARGUMENT,
          "Invalid segment spooling mode: $raw. Use 'off', 'auto', or 'on'."
        )
      }
    }
  }
}
