package com.sherpaonnx.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioSaveRangesTest {
  @Test
  fun normalizeMergesOverlappingAndTouching() {
    val merged = AudioSaveRanges.normalizeMs(
      listOf(
        AudioSaveRanges.MsRange(100.0, 200.0),
        AudioSaveRanges.MsRange(50.0, 80.0),
        AudioSaveRanges.MsRange(180.0, 250.0),
        AudioSaveRanges.MsRange(250.0, 300.0),
      )
    )
    assertEquals(2, merged.size)
    assertEquals(50.0, merged[0].startMs, 0.0)
    assertEquals(80.0, merged[0].endMs, 0.0)
    assertEquals(100.0, merged[1].startMs, 0.0)
    assertEquals(300.0, merged[1].endMs, 0.0)
  }

  @Test
  fun toFrameSpansClampsAndDropsEmpty() {
    // 16 kHz: 1000 ms = 16000 frames
    val spans = AudioSaveRanges.toFrameSpans(
      listOf(
        AudioSaveRanges.MsRange(-100.0, 500.0),
        AudioSaveRanges.MsRange(900.0, 2000.0),
        AudioSaveRanges.MsRange(1500.0, 1500.0),
      ),
      sampleRate = 16000,
      totalFrames = 16000L,
    )
    assertEquals(2, spans.size)
    assertEquals(0L, spans[0].startFrame)
    assertEquals(8000L, spans[0].endFrame)
    assertEquals(14400L, spans[1].startFrame)
    assertEquals(16000L, spans[1].endFrame)
    assertEquals(9600L, AudioSaveRanges.totalFrames(spans))
  }

  @Test
  fun emptySelectionWhenAllOutOfBounds() {
    val spans = AudioSaveRanges.toFrameSpans(
      listOf(AudioSaveRanges.MsRange(5000.0, 6000.0)),
      sampleRate = 16000,
      totalFrames = 16000L,
    )
    assertTrue(spans.isEmpty())
    assertEquals(0L, AudioSaveRanges.totalFrames(spans))
  }
}
