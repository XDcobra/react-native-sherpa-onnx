package com.sherpaonnx.audio.pipeline

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineResampleRegistryTest {

  @After
  fun tearDown() {
    PipelineAudioRegistry.clear()
  }

  @Test
  fun createOfflineFromOffline_sameRate_copiesIndependentBuffer() {
    val source =
      PipelineAudioRegistry.createOfflineFromFloatArray(
        floatArrayOf(0.1f, 0.2f, 0.3f, 0.4f),
        sampleRate = 16_000,
      )
    val copy = PipelineAudioRegistry.createOfflineFromOffline(source.bufferId, targetSampleRateHz = null)
    assertNotEquals(source.bufferId, copy.bufferId)
    assertEquals(16_000, copy.sampleRate)
    assertEquals(source.numSamples, copy.numSamples)
    assertEquals(source.readAllSamples().toList(), copy.readAllSamples().toList())
  }

  @Test
  fun createOfflineFromOffline_16kTo48k_resamples() {
    val source =
      PipelineAudioRegistry.createOfflineFromFloatArray(
        FloatArray(160) { 0.25f },
        sampleRate = 16_000,
      )
    val resampled =
      PipelineAudioRegistry.createOfflineFromOffline(source.bufferId, targetSampleRateHz = 48_000)
    assertEquals(48_000, resampled.sampleRate)
    assertEquals(480, resampled.numSamples)
    // Source remains usable at original rate.
    assertEquals(16_000, source.sampleRate)
    assertEquals(160, source.numSamples)
  }

  @Test
  fun createOfflineFromLive_windowSnapshot_16kTo48k_resamples() {
    val live = PipelineAudioRegistry.createLive(sampleRate = 16_000, windowSeconds = 2.0)
    PipelineAudioRegistry.appendSamplesToLive(
      live.bufferId,
      FloatArray(320) { 0.1f },
      sampleRate = 16_000,
    )
    PipelineAudioRegistry.finalizeLive(live.bufferId)

    val offline =
      PipelineAudioRegistry.createOfflineFromLive(
        live.bufferId,
        mode = "windowSnapshot",
        targetSampleRateHz = 48_000,
      )
    assertEquals(48_000, offline.sampleRate)
    assertEquals(960, offline.numSamples)
  }

  @Test
  fun createOfflineFromLive_matchingRate_keepsRate() {
    val live = PipelineAudioRegistry.createLive(sampleRate = 16_000, windowSeconds = 2.0)
    PipelineAudioRegistry.appendSamplesToLive(
      live.bufferId,
      FloatArray(100) { 0.2f },
      sampleRate = 16_000,
    )
    PipelineAudioRegistry.finalizeLive(live.bufferId)

    val offline =
      PipelineAudioRegistry.createOfflineFromLive(
        live.bufferId,
        mode = "windowSnapshot",
        targetSampleRateHz = 0,
      )
    assertEquals(16_000, offline.sampleRate)
    assertTrue(offline.numSamples > 0)
  }
}
