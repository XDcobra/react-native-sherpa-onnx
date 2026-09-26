package com.sherpaonnx.audio.pipeline

import java.io.File

/**
 * Loads committed mono WAV fixtures from the unit-test classpath
 * (`test/fixtures/audiobuffer` via android `sourceSets.test.resources`).
 */
internal object WavFixtureLoader {

  data class PcmFixture(
    val sampleRate: Int,
    val samples: FloatArray,
  ) {
    val numSamples: Int get() = samples.size
    val durationMs: Double
      get() = if (sampleRate > 0) (numSamples.toDouble() / sampleRate) * 1000.0 else 0.0
  }

  fun loadTone16k(): PcmFixture = loadResource("audiobuffer/tone-16k-mono.wav")

  fun loadTone48k(): PcmFixture = loadResource("audiobuffer/tone-48k-mono.wav")

  fun loadResource(resourcePath: String): PcmFixture {
    val url =
      WavFixtureLoader::class.java.classLoader?.getResource(resourcePath)
        ?: error("Missing test resource: $resourcePath")
    val file = File(url.toURI())
    val meta =
      parseWavHeader(file.absolutePath)
        ?: error("Unsupported WAV fixture: $resourcePath")
    val samples = FloatArray(meta.numSamples)
    FileBackedReader(file.absolutePath, meta).use { reader ->
      var offset = 0
      while (offset < samples.size) {
        val n = reader.readSamples(samples, offset, samples.size - offset)
        if (n <= 0) break
        offset += n
      }
      require(offset == samples.size) {
        "Incomplete WAV read for $resourcePath: got $offset of ${samples.size}"
      }
    }
    return PcmFixture(sampleRate = meta.sampleRate, samples = samples)
  }

  /** Same integer length formula as [Resampler.resampleLinear]. */
  fun expectedResampledLength(inputSamples: Int, inputRate: Int, outputRate: Int): Int {
    if (inputSamples <= 0 || inputRate <= 0 || outputRate <= 0 || inputRate == outputRate) {
      return inputSamples
    }
    return kotlin.math.max(1, ((inputSamples.toLong() * outputRate) / inputRate).toInt())
  }
}
