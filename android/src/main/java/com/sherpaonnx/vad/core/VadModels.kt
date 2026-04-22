package com.sherpaonnx.vad.core

data class VadInstanceConfig(
  val sampleRate: Int,
  val threshold: Double,
  val minSpeechDurationMs: Int,
  val minSilenceDurationMs: Int,
)

data class VadSummary(
  val chunksProcessed: Long,
  val unitsRead: Long,
  val unitsWritten: Long,
  val segmentCount: Int,
  val speechDurationMs: Long,
)
