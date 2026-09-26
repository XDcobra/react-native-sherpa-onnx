package com.sherpaonnx.audio.pipeline

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ResamplerTest {

  @Test
  fun resampleLinear_sameRate_returnsInput() {
    val input = floatArrayOf(0.1f, 0.2f, 0.3f)
    val out = Resampler.resampleLinear(input, 16_000, 16_000)
    assertSame(input, out)
  }

  @Test
  fun resampleLinear_16kTo48k_triplesLength() {
    val input = FloatArray(160) { i -> (i % 10) / 10f }
    val out = Resampler.resampleLinear(input, 16_000, 48_000)
    assertEquals(480, out.size)
    assertEquals(input[0], out[0], 1e-5f)
  }

  @Test
  fun resampleLinear_48kTo16k_shortensLength() {
    val input = FloatArray(480) { 0.5f }
    val out = Resampler.resampleLinear(input, 48_000, 16_000)
    assertEquals(160, out.size)
    assertTrue(out.all { kotlin.math.abs(it - 0.5f) < 1e-4f })
  }

  @Test
  fun resampleLinear_empty_returnsEmpty() {
    val out = Resampler.resampleLinear(floatArrayOf(), 16_000, 48_000)
    assertArrayEquals(floatArrayOf(), out, 0f)
  }
}
