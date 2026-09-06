#include "sortformer-fbank.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

namespace sherpaonnx::diarization {
namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> GenerateSineWave(float freq_hz, int32_t sample_rate,
                                    size_t num_samples) {
  std::vector<float> wave(num_samples);
  for (size_t i = 0; i < num_samples; ++i) {
    wave[i] = std::sin(static_cast<float>(2.0 * kPi * freq_hz * i / sample_rate));
  }
  return wave;
}

} // namespace

TEST(SortformerFbankTest, FFTConcentratesPowerOnSineWave) {
  SortformerFbankConfig config;
  config.n_fft = 512;
  config.sample_rate = 16000;
  SortformerFbank fbank(config);

  // 1 kHz sine wave: bin = 1000 * 512 / 16000 = 32
  const int32_t expected_bin = 32;
  auto sine = GenerateSineWave(1000.0f, 16000, 512);

  std::vector<float> out_real(512);
  std::vector<float> out_imag(512);
  fbank.ComputeRfft(sine.data(), out_real.data(), out_imag.data());

  float peak_power = 0.0f;
  int32_t peak_bin = -1;
  // Inspect single-sided spectrum (0..256)
  for (int32_t k = 0; k <= 256; ++k) {
    float power = out_real[k] * out_real[k] + out_imag[k] * out_imag[k];
    if (power > peak_power) {
      peak_power = power;
      peak_bin = k;
    }
  }

  EXPECT_EQ(peak_bin, expected_bin);
  EXPECT_GT(peak_power, 50000.0f);
}

TEST(SortformerFbankTest, MelFilterbankDimensionAndSparseness) {
  SortformerFbankConfig config;
  SortformerFbank fbank(config);

  EXPECT_EQ(fbank.freqBins(), 257);
  const auto& filters = fbank.melFilters();
  ASSERT_EQ(filters.size(), 128u);

  // Verify each filter has valid bins and non-empty weights
  for (size_t m = 0; m < filters.size(); ++m) {
    EXPECT_GE(filters[m].first_bin, 0);
    EXPECT_LT(filters[m].first_bin, 257);
    EXPECT_FALSE(filters[m].weights.empty());
    for (float w : filters[m].weights) {
      EXPECT_GE(w, 0.0f);
    }
  }
}

TEST(SortformerFbankTest, ComputesCorrectNumberOfFramesForFeedSamples) {
  SortformerFbankConfig config;
  SortformerFbank fbank(config);

  // feed_samples = (124 + 1) * 8 * 160 = 160,000 samples (10.0 seconds)
  const size_t feed_samples = 160000;
  std::vector<float> audio(feed_samples, 0.0f);

  std::vector<float> mel;
  int32_t num_frames = 0;
  fbank.ComputeMel(audio.data(), audio.size(), mel, num_frames);

  // Center=true padding adds 512 samples.
  // (160000 + 512 - 512) / 160 + 1 = 1001 frames
  EXPECT_EQ(num_frames, 1001);
  EXPECT_EQ(mel.size(), static_cast<size_t>(num_frames * 128));

  // Verify values are finite and around log(log_guard) for silence
  const float expected_silence_log = std::log(config.log_guard);
  for (size_t i = 0; i < 128; ++i) {
    EXPECT_NEAR(mel[i], expected_silence_log, 1e-4f);
  }
}

TEST(SortformerFbankTest, SineWaveMelEnergiesPeakInExpectedFilter) {
  SortformerFbankConfig config;
  SortformerFbank fbank(config);

  // 1 kHz sine wave for 1 second (16,000 samples)
  auto audio = GenerateSineWave(1000.0f, 16000, 16000);

  std::vector<float> mel;
  int32_t num_frames = 0;
  fbank.ComputeMel(audio.data(), audio.size(), mel, num_frames);

  EXPECT_GT(num_frames, 50);

  // Mid-frame (frame 50)
  const float* frame = mel.data() + 50 * 128;
  float max_val = -100.0f;
  int32_t max_mel_idx = -1;
  for (int32_t m = 0; m < 128; ++m) {
    if (frame[m] > max_val) {
      max_val = frame[m];
      max_mel_idx = m;
    }
  }

  // 1000 Hz in Slaney mel scale: 1000 / (200/3) = 15.
  // Mel range is 0 to ~40 (for 8000 Hz).
  // 15 / 40 * 128 approx 48. Expected max mel bin is between 40 and 55.
  EXPECT_GE(max_mel_idx, 40);
  EXPECT_LE(max_mel_idx, 55);
}

} // namespace sherpaonnx::diarization
