package com.sherpaonnx.segment.pipeline

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveSegmentEntryCommitListenerTest {

  private fun newEntry(): LiveSegmentEntry = LiveSegmentEntry(
    bufferId = "seg_live_test",
    sourceAudioBufferId = "audio_live_test",
    maxSegments = 32,
    spoolingMode = SegmentSpoolingMode.OFF,
  )

  @Test
  fun addCommitListener_firesOnAppend() {
    val entry = newEntry()
    val callbacks = AtomicInteger(0)
    var observedId = ""
    var observedIndex = -1

    entry.addCommitListener { segmentId, segmentIndex, record ->
      callbacks.incrementAndGet()
      observedId = segmentId
      observedIndex = segmentIndex
      assertEquals("speech", record.kind)
    }

    val (segmentId, segmentIndex) = entry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = "audio_live_test",
      startSample = 0,
      endSample = 1600,
      sampleRate = 16000,
      durationMs = 100,
      confidence = null,
      payloadJson = "{}",
    )

    assertEquals(1, callbacks.get())
    assertEquals(segmentId, observedId)
    assertEquals(segmentIndex, observedIndex)
  }

  @Test
  fun removeCommitListener_stopsCallbacks() {
    val entry = newEntry()
    val callbacks = AtomicInteger(0)

    val token = entry.addCommitListener { _, _, _ ->
      callbacks.incrementAndGet()
    }

    entry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = "audio_live_test",
      startSample = 0,
      endSample = 1600,
      sampleRate = 16000,
      durationMs = 100,
      confidence = null,
      payloadJson = "{}",
    )
    entry.removeCommitListener(token)
    entry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = "audio_live_test",
      startSample = 1600,
      endSample = 3200,
      sampleRate = 16000,
      durationMs = 100,
      confidence = null,
      payloadJson = "{}",
    )

    assertEquals(1, callbacks.get())
  }

  @Test
  fun finalize_blocksFurtherCommits() {
    val entry = newEntry()
    val callbacks = AtomicInteger(0)

    entry.addCommitListener { _, _, _ ->
      callbacks.incrementAndGet()
    }

    entry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = "audio_live_test",
      startSample = 0,
      endSample = 1600,
      sampleRate = 16000,
      durationMs = 100,
      confidence = null,
      payloadJson = "{}",
    )
    entry.finalize_()

    val failed = runCatching {
      entry.appendSegment(
        kind = "speech",
        sourceAudioBufferId = "audio_live_test",
        startSample = 1600,
        endSample = 3200,
        sampleRate = 16000,
        durationMs = 100,
        confidence = null,
        payloadJson = "{}",
      )
    }.isFailure

    assertTrue(failed)
    assertEquals(1, callbacks.get())
  }
}
