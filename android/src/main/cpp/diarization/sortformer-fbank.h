#ifndef SHERPA_ONNX_DIARIZATION_SORTFORMER_FBANK_H
#define SHERPA_ONNX_DIARIZATION_SORTFORMER_FBANK_H

#include <cstddef>
#include <cstdint>
#include <vector>

namespace sherpaonnx::diarization {

struct SortformerFbankConfig {
  int32_t sample_rate = 16000;
  int32_t n_fft = 512;
  int32_t win_length = 400;
  int32_t hop_length = 160;
  int32_t n_mels = 128;
  float f_min = 0.0f;
  float f_max = 8000.0f;
  float preemph = 0.97f;
  float log_guard = 5.9604645e-8f; // 2^-24
};

struct SparseMelFilter {
  int32_t first_bin = 0;
  std::vector<float> weights;
};

/**
 * High-performance, allocation-free C++ DSP audio front-end for NeMo Sortformer.
 * Implements pre-emphasis -> Hann STFT (center=true) -> Slaney Mel filterbank -> log(x + eps).
 */
class SortformerFbank {
 public:
  explicit SortformerFbank(const SortformerFbankConfig& config = {});
  ~SortformerFbank() = default;

  const SortformerFbankConfig& config() const { return config_; }
  int32_t freqBins() const { return freq_bins_; }
  const std::vector<SparseMelFilter>& melFilters() const { return mel_filters_; }

  /**
   * Compute mel spectrogram from raw float PCM mono audio (sample_rate Hz).
   *
   * @param audio Input audio samples.
   * @param num_samples Number of audio samples.
   * @param out_mel Output flat vector of shape (out_num_frames * n_mels), row-major.
   * @param out_num_frames Number of time frames produced.
   */
  void ComputeMel(const float* audio, size_t num_samples,
                  std::vector<float>& out_mel, int32_t& out_num_frames);

  /**
   * Compute mel spectrogram into a pre-allocated buffer.
   *
   * @param audio Input audio samples.
   * @param num_samples Number of audio samples.
   * @param out_mel Destination buffer (must have capacity >= max_frames * n_mels).
   * @param max_frames Maximum frames destination can hold.
   * @param out_num_frames Actual number of frames written.
   */
  void ComputeMel(const float* audio, size_t num_samples,
                  float* out_mel, int32_t max_frames, int32_t* out_num_frames);

  /**
   * Compute Radix-2 Real FFT directly for testing or diagnostics.
   * Input in_real has length n_fft. Outputs out_real and out_imag have length n_fft.
   */
  void ComputeRfft(const float* in_real, float* out_real, float* out_imag);

 private:
  void InitTables();
  void BuildMelFilterbank();
  void Radix2FFT(float* real, float* imag);

  SortformerFbankConfig config_;
  int32_t freq_bins_ = 257;

  // Precomputed tables
  std::vector<int32_t> bit_rev_;
  std::vector<float> twiddle_cos_;
  std::vector<float> twiddle_sin_;
  std::vector<float> fft_window_; // size = n_fft (with Hann centered)
  std::vector<SparseMelFilter> mel_filters_;

  // Scratch buffers to avoid steady-state heap allocations
  std::vector<float> preemph_audio_;
  std::vector<float> padded_audio_;
  std::vector<float> fft_real_;
  std::vector<float> fft_imag_;
  std::vector<float> power_spec_;
};

} // namespace sherpaonnx::diarization

#endif // SHERPA_ONNX_DIARIZATION_SORTFORMER_FBANK_H
