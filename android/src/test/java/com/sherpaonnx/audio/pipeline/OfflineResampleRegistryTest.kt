package com.sherpaonnx.audio.pipeline

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Buffer sample-rate conversion matrix using committed mono WAV fixtures.
 *
 * Covers offline→offline, live→offline, offline→live for 16k↔48k.
 * Does not cover FFmpeg file decode or real mic hardware.
 */
@RunWith(Parameterized::class)
class OfflineResampleRegistryTest(
  private val caseName: String,
  private val sourceRate: Int,
  private val targetRateOrKeep: Int?,
) {

  data class Cell(
    val name: String,
    val sourceRate: Int,
    /** null or 0 = keep source rate; otherwise force target. */
    val targetRateOrKeep: Int?,
  )

  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0}")
    fun cells(): Collection<Array<Any?>> {
      val list =
        listOf(
          Cell("16k_keep", 16_000, null),
          Cell("16k_to_16k", 16_000, 16_000),
          Cell("16k_to_48k", 16_000, 48_000),
          Cell("48k_keep", 48_000, null),
          Cell("48k_to_48k", 48_000, 48_000),
          Cell("48k_to_16k", 48_000, 16_000),
          Cell("16k_target0_keep", 16_000, 0),
        )
      return list.map { arrayOf(it.name, it.sourceRate, it.targetRateOrKeep) }
    }

    private fun fixtureFor(sourceRate: Int): WavFixtureLoader.PcmFixture =
      when (sourceRate) {
        16_000 -> WavFixtureLoader.loadTone16k()
        48_000 -> WavFixtureLoader.loadTone48k()
        else -> error("unsupported sourceRate=$sourceRate")
      }

    private fun effectiveTarget(sourceRate: Int, targetRateOrKeep: Int?): Int =
      when {
        targetRateOrKeep == null || targetRateOrKeep == 0 -> sourceRate
        else -> targetRateOrKeep
      }
  }

  @After
  fun tearDown() {
    PipelineAudioRegistry.clear()
  }

  @Test
  fun offlineToOffline_matrix() {
    val fixture = fixtureFor(sourceRate)
    assertEquals(sourceRate, fixture.sampleRate)
    val source =
      PipelineAudioRegistry.createOfflineFromFloatArray(fixture.samples, fixture.sampleRate)
    val effective = effectiveTarget(sourceRate, targetRateOrKeep)
    val out =
      PipelineAudioRegistry.createOfflineFromOffline(source.bufferId, targetRateOrKeep)

    assertNotEquals("$caseName distinct buffer", source.bufferId, out.bufferId)
    assertEquals("$caseName sampleRate", effective, out.sampleRate)
    assertEquals(
      "$caseName numSamples",
      WavFixtureLoader.expectedResampledLength(fixture.numSamples, sourceRate, effective),
      out.numSamples,
    )
    assertEquals("$caseName source rate unchanged", sourceRate, source.sampleRate)
    assertEquals("$caseName source length unchanged", fixture.numSamples, source.numSamples)
    assertDurationClose(caseName, fixture.durationMs, out.durationMs)
  }

  @Test
  fun liveToOffline_windowSnapshot_matrix() {
    val fixture = fixtureFor(sourceRate)
    val live = PipelineAudioRegistry.createLive(sampleRate = sourceRate, windowSeconds = 2.0)
    PipelineAudioRegistry.appendSamplesToLive(live.bufferId, fixture.samples, sourceRate)
    PipelineAudioRegistry.finalizeLive(live.bufferId)

    val effective = effectiveTarget(sourceRate, targetRateOrKeep)
    val out =
      PipelineAudioRegistry.createOfflineFromLive(
        live.bufferId,
        mode = "windowSnapshot",
        targetSampleRateHz = targetRateOrKeep,
      )

    assertEquals("$caseName sampleRate", effective, out.sampleRate)
    assertEquals(
      "$caseName numSamples",
      WavFixtureLoader.expectedResampledLength(fixture.numSamples, sourceRate, effective),
      out.numSamples,
    )
    assertDurationClose(caseName, fixture.durationMs, out.durationMs)
  }

  @Test
  fun offlineToLive_append_matrix() {
    val fixture = fixtureFor(sourceRate)
    val source =
      PipelineAudioRegistry.createOfflineFromFloatArray(fixture.samples, fixture.sampleRate)
    val effective = effectiveTarget(sourceRate, targetRateOrKeep)
    val live = PipelineAudioRegistry.createLive(sampleRate = effective, windowSeconds = 2.0)
    PipelineAudioRegistry.appendOfflineToLive(live.bufferId, source.bufferId)
    PipelineAudioRegistry.finalizeLive(live.bufferId)

    val ring = live.snapshotRing()
    assertEquals("$caseName live sampleRate", effective, live.sampleRate)
    val expectedSamples =
      WavFixtureLoader.expectedResampledLength(fixture.numSamples, sourceRate, effective)
    // appendOfflineToLive resamples per read chunk (8192), so length can differ
    // by a few samples from a single whole-buffer Resampler pass.
    val delta = kotlin.math.abs(live.numSamples - expectedSamples.toLong())
    assertTrue(
      "$caseName live numSamples expected≈$expectedSamples actual=${live.numSamples} (Δ=$delta)",
      delta <= 2L,
    )
    assertEquals("$caseName ring length", live.numSamples.toInt(), ring.size)
    assertDurationClose(
      caseName,
      fixture.durationMs,
      if (effective > 0) (live.numSamples.toDouble() / effective) * 1000.0 else 0.0,
    )
  }

  private fun assertDurationClose(label: String, expectedMs: Double, actualMs: Double) {
    val delta = kotlin.math.abs(expectedMs - actualMs)
    assertTrue(
      "$label duration expected≈$expectedMs ms actual=$actualMs ms (Δ=$delta)",
      delta < 2.0,
    )
  }
}

class OfflineResampleRegistryNegativeTest {

  @After
  fun tearDown() {
    PipelineAudioRegistry.clear()
  }

  @Test
  fun createOfflineFromFloatArray_rejectsStereo() {
    try {
      PipelineAudioRegistry.createOfflineFromFloatArray(
        floatArrayOf(0.1f, 0.2f),
        sampleRate = 16_000,
        channelCount = 2,
      )
      fail("expected IllegalArgumentException for stereo create")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message?.contains("mono") == true)
    }
  }

  @Test
  fun createOfflineFromOffline_rejectsStereoResample() {
    val mono =
      PipelineAudioRegistry.createOfflineFromFloatArray(
        floatArrayOf(0.1f, 0.2f, 0.3f, 0.4f),
        sampleRate = 16_000,
      )
    PipelineAudioRegistry.replaceOfflineEntry(
      mono.bufferId,
      OfflineEntry.InMemory(
        bufferId = mono.bufferId,
        sampleRate = 16_000,
        channelCount = 2,
        samples = floatArrayOf(0.1f, 0.2f, 0.3f, 0.4f),
      ),
    )
    try {
      PipelineAudioRegistry.createOfflineFromOffline(mono.bufferId, targetSampleRateHz = 48_000)
      fail("expected IllegalArgumentException for stereo resample")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message?.contains("mono") == true)
    }
  }
}
