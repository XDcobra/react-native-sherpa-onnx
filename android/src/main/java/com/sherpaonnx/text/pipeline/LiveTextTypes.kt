package com.sherpaonnx.text.pipeline

/**
 * Shared live-text types (segment + spooling mode).
 */

data class TextSegment(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val source: String,
  val segmentIndex: Int,
  val meta: Map<String, Any?>? = null,
)

enum class TextSpoolingMode {
  OFF,
  AUTO,
  ON;

  fun rawValue(): String =
    when (this) {
      OFF -> "off"
      AUTO -> "auto"
      ON -> "on"
    }

  companion object {
    fun fromRaw(raw: String?): TextSpoolingMode {
      return when (raw?.trim()?.lowercase()) {
        "off" -> OFF
        "auto" -> AUTO
        "on" -> ON
        null, "" -> ON
        else ->
          throw TextPipelineException(
            TextErrorCodes.INVALID_ARGUMENT,
            "Invalid text spooling mode: $raw. Use 'off', 'auto', or 'on'.",
          )
      }
    }
  }
}
