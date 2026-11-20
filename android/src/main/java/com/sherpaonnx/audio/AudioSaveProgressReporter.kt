package com.sherpaonnx.audio

/**
 * Throttled progress for one `saveAudioAsFile` operation (`audioSaveProgress` event).
 *
 * - [report] is called after every encoded chunk. It forwards an `encode` event only when the
 *   percent moved by at least 1 or [minIntervalMs] passed since the last event, so long encodes
 *   do not flood the bridge. The first call always emits. While encoding, percent is capped at 99.
 * - [complete] emits one final `finalize` event with percent 100. It is not throttled and runs once.
 *
 * Not thread-safe: use one instance per operation, from the thread that drives the encode.
 * Mirrors the iOS `PaSaveProgressThrottle` in `SherpaOnnx+PipelineAudio.mm`.
 */
class AudioSaveProgressReporter(
  private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val emit: (phase: String, framesProcessed: Long, totalFramesEstimate: Long, percent: Int) -> Unit,
) {
  private var lastPercent = -1
  private var lastEmitMs = 0L
  private var lastEmittedFrames = -1L
  private var framesSeen = 0L
  private var completed = false

  fun report(framesProcessed: Long, totalFramesEstimate: Long) {
    if (completed) return
    framesSeen = framesProcessed
    val percent = percentOf(framesProcessed, totalFramesEstimate)
    val now = nowMs()
    if (lastPercent >= 0) {
      if (framesProcessed <= lastEmittedFrames) return
      if (percent < lastPercent + 1 && now - lastEmitMs < minIntervalMs) return
    }
    lastPercent = maxOf(lastPercent, percent)
    lastEmitMs = now
    lastEmittedFrames = framesProcessed
    emit(PHASE_ENCODE, framesProcessed, maxOf(0L, totalFramesEstimate), lastPercent)
  }

  /** Final 100 % event. [framesProcessed] < 0 uses the last reported frame count. */
  fun complete(framesProcessed: Long = -1L) {
    if (completed) return
    completed = true
    val frames = if (framesProcessed >= 0L) framesProcessed else framesSeen
    emit(PHASE_FINALIZE, frames, frames, 100)
  }

  companion object {
    const val DEFAULT_MIN_INTERVAL_MS = 100L
    const val PHASE_ENCODE = "encode"
    const val PHASE_FINALIZE = "finalize"

    /** 0..99 while encoding (100 is reserved for [complete]); 0 when the total is unknown. */
    fun percentOf(framesProcessed: Long, totalFramesEstimate: Long): Int {
      if (totalFramesEstimate <= 0L || framesProcessed <= 0L) return 0
      val pct = (framesProcessed.toDouble() * 100.0 / totalFramesEstimate.toDouble()).toInt()
      return pct.coerceIn(0, 99)
    }
  }
}
