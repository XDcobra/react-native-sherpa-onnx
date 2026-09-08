#include "sortformer-fbank.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace sherpaonnx::diarization {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kFSp = 200.0 / 3.0;
constexpr double kMinLogHz = 1000.0;
constexpr double kMinLogMel = kMinLogHz / kFSp; // 15.0
constexpr double kLogStep = 0.06875177742094912; // ln(6.4) / 27.0

inline double HzToMelSlaney(double hz) {
  if (hz < kMinLogHz) {
    return hz / kFSp;
  }
  return kMinLogMel + std::log(hz / kMinLogHz) / kLogStep;
}

inline double MelToHzSlaney(double mel) {
  if (mel < kMinLogMel) {
    return mel * kFSp;
  }
  return kMinLogHz * std::exp((mel - kMinLogMel) * kLogStep);
}

} // namespace

SortformerFbank::SortformerFbank(const SortformerFbankConfig& config)
    : config_(config) {
  if (config_.n_fft <= 0 || (config_.n_fft & (config_.n_fft - 1)) != 0) {
    throw std::invalid_argument("SortformerFbank: n_fft must be a power of 2");
  }
  if (config_.win_length <= 0 || config_.win_length > config_.n_fft) {
    throw std::invalid_argument("SortformerFbank: win_length must be in (0, n_fft]");
  }
  if (config_.hop_length <= 0) {
    throw std::invalid_argument("SortformerFbank: hop_length must be > 0");
  }
  if (config_.n_mels <= 0) {
    throw std::invalid_argument("SortformerFbank: n_mels must be > 0");
  }
  if (config_.sample_rate <= 0) {
    throw std::invalid_argument("SortformerFbank: sample_rate must be > 0");
  }

  freq_bins_ = config_.n_fft / 2 + 1;
  InitTables();
  BuildMelFilterbank();

  fft_real_.resize(config_.n_fft, 0.0f);
  fft_imag_.resize(config_.n_fft, 0.0f);
  power_spec_.resize(freq_bins_, 0.0f);
}

void SortformerFbank::InitTables() {
  const int32_t N = config_.n_fft;

  // Bit reversal permutation
  bit_rev_.resize(N);
  int32_t log2N = 0;
  while ((1 << log2N) < N) {
    log2N++;
  }
  for (int32_t i = 0; i < N; ++i) {
    int32_t rev = 0;
    for (int32_t j = 0; j < log2N; ++j) {
      if ((i >> j) & 1) {
        rev |= (1 << (log2N - 1 - j));
      }
    }
    bit_rev_[i] = rev;
  }

  // Twiddle factors: exp(-2 * pi * i * k / N)
  twiddle_cos_.resize(N / 2);
  twiddle_sin_.resize(N / 2);
  for (int32_t k = 0; k < N / 2; ++k) {
    double angle = 2.0 * kPi * static_cast<double>(k) / static_cast<double>(N);
    twiddle_cos_[k] = static_cast<float>(std::cos(angle));
    twiddle_sin_[k] = static_cast<float>(std::sin(angle));
  }

  // Periodic Hann window of length win_length, centered in n_fft
  fft_window_.assign(N, 0.0f);
  const int32_t win_offset = (N - config_.win_length) / 2;
  for (int32_t i = 0; i < config_.win_length; ++i) {
    // Periodic Hann: divide by win_length (same as librosa fftbins=True)
    double w = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) /
                                    static_cast<double>(config_.win_length));
    fft_window_[win_offset + i] = static_cast<float>(w);
  }
}

void SortformerFbank::BuildMelFilterbank() {
  const int32_t n_mels = config_.n_mels;
  const int32_t n_fft = config_.n_fft;
  const int32_t sr = config_.sample_rate;

  double fmax = config_.f_max > 0.0f ? static_cast<double>(config_.f_max)
                                     : static_cast<double>(sr) / 2.0;
  double fmin = static_cast<double>(config_.f_min);

  double mel_min = HzToMelSlaney(fmin);
  double mel_max = HzToMelSlaney(fmax);

  std::vector<double> mel_points(static_cast<size_t>(n_mels + 2));
  for (size_t i = 0; i <= static_cast<size_t>(n_mels + 1); ++i) {
    double mel = mel_min + (mel_max - mel_min) * static_cast<double>(i) /
                               static_cast<double>(n_mels + 1);
    mel_points[i] = MelToHzSlaney(mel);
  }

  std::vector<double> fft_freqs(static_cast<size_t>(freq_bins_));
  for (size_t i = 0; i < static_cast<size_t>(freq_bins_); ++i) {
    fft_freqs[i] = static_cast<double>(i) * static_cast<double>(sr) /
                   static_cast<double>(n_fft);
  }

  std::vector<double> fdiff(static_cast<size_t>(n_mels + 1));
  for (size_t i = 0; i <= static_cast<size_t>(n_mels); ++i) {
    fdiff[i] = mel_points[i + 1] - mel_points[i];
  }

  mel_filters_.clear();
  mel_filters_.reserve(n_mels);

  for (int32_t i = 0; i < n_mels; ++i) {
    double p_left = mel_points[static_cast<size_t>(i)];
    double p_mid = mel_points[static_cast<size_t>(i + 1)];
    double p_right = mel_points[static_cast<size_t>(i + 2)];
    double df_left = fdiff[static_cast<size_t>(i)];
    double df_right = fdiff[static_cast<size_t>(i + 1)];
    double enorm = 2.0 / (p_right - p_left);

    int32_t first_bin = -1;
    int32_t last_bin = -1;
    std::vector<float> dense(static_cast<size_t>(freq_bins_), 0.0f);

    for (int32_t k = 0; k < freq_bins_; ++k) {
      double freq = fft_freqs[static_cast<size_t>(k)];
      double lower = (freq - p_left) / df_left;
      double upper = (p_right - freq) / df_right;
      double w = std::max(0.0, std::min(lower, upper));
      if (w > 0.0) {
        float val = static_cast<float>(w * enorm);
        dense[static_cast<size_t>(k)] = val;
        if (first_bin < 0) {
          first_bin = k;
        }
        last_bin = k;
      }
    }

    SparseMelFilter smf;
    if (first_bin >= 0 && last_bin >= first_bin) {
      smf.first_bin = first_bin;
      smf.weights.assign(dense.begin() + first_bin, dense.begin() + last_bin + 1);
    } else {
      smf.first_bin = 0;
      smf.weights.clear();
    }
    mel_filters_.push_back(std::move(smf));
  }
}

void SortformerFbank::Radix2FFT(float* real, float* imag) {
  const int32_t N = config_.n_fft;

  // 1. Bit-reversal permutation
  for (int32_t i = 0; i < N; ++i) {
    int32_t j = bit_rev_[static_cast<size_t>(i)];
    if (i < j) {
      std::swap(real[i], real[j]);
      std::swap(imag[i], imag[j]);
    }
  }

  // 2. Butterfly stages
  for (int32_t len = 2; len <= N; len <<= 1) {
    int32_t half_len = len >> 1;
    int32_t step = N / len;

    for (int32_t i = 0; i < N; i += len) {
      for (int32_t j = 0; j < half_len; ++j) {
        int32_t k = j * step;
        float u_r = real[i + j];
        float u_i = imag[i + j];
        float v_r = real[i + j + half_len];
        float v_i = imag[i + j + half_len];

        // Twiddle factor: exp(-2 * pi * i * k / N) = cos - i * sin
        float w_r = twiddle_cos_[static_cast<size_t>(k)];
        float w_i = -twiddle_sin_[static_cast<size_t>(k)];

        // t = v * w = (v_r + i * v_i) * (w_r + i * w_i)
        float t_r = v_r * w_r - v_i * w_i;
        float t_i = v_r * w_i + v_i * w_r;

        real[i + j] = u_r + t_r;
        imag[i + j] = u_i + t_i;
        real[i + j + half_len] = u_r - t_r;
        imag[i + j + half_len] = u_i - t_i;
      }
    }
  }
}

void SortformerFbank::ComputeRfft(const float* in_real, float* out_real,
                                  float* out_imag) {
  const int32_t N = config_.n_fft;
  std::copy(in_real, in_real + N, out_real);
  std::fill_n(out_imag, N, 0.0f);
  Radix2FFT(out_real, out_imag);
}

void SortformerFbank::ComputeMel(const float* audio, size_t num_samples,
                                 std::vector<float>& out_mel,
                                 int32_t& out_num_frames) {
  if (num_samples == 0 || audio == nullptr) {
    out_mel.clear();
    out_num_frames = 0;
    return;
  }

  int32_t estimated_frames =
      static_cast<int32_t>(num_samples / static_cast<size_t>(config_.hop_length)) + 1;
  out_mel.resize(static_cast<size_t>(estimated_frames) *
                 static_cast<size_t>(config_.n_mels));

  ComputeMel(audio, num_samples, out_mel.data(), estimated_frames,
             &out_num_frames);
  out_mel.resize(static_cast<size_t>(out_num_frames) *
                 static_cast<size_t>(config_.n_mels));
}

void SortformerFbank::ComputeMel(const float* audio, size_t num_samples,
                                 float* out_mel, int32_t max_frames,
                                 int32_t* out_num_frames) {
  if (num_samples == 0 || audio == nullptr || max_frames <= 0) {
    if (out_num_frames) *out_num_frames = 0;
    return;
  }

  const int32_t n_fft = config_.n_fft;
  const int32_t hop = config_.hop_length;
  const int32_t pad = n_fft / 2; // center=true (256 samples)
  const size_t padded_len = num_samples + 2 * static_cast<size_t>(pad);

  // 1. Pre-emphasis in scratch buffer
  if (preemph_audio_.size() < num_samples) {
    preemph_audio_.resize(num_samples);
  }
  preemph_audio_[0] = audio[0];
  const float preemph = config_.preemph;
  for (size_t i = 1; i < num_samples; ++i) {
    preemph_audio_[i] = audio[i] - preemph * audio[i - 1];
  }

  // 2. Center padding: [pad zeros] + [pre-emphasized audio] + [pad zeros]
  if (padded_audio_.size() < padded_len) {
    padded_audio_.resize(padded_len);
  }
  std::fill_n(padded_audio_.data(), pad, 0.0f);
  std::copy(preemph_audio_.data(), preemph_audio_.data() + num_samples,
            padded_audio_.data() + pad);
  std::fill_n(padded_audio_.data() + pad + num_samples, pad, 0.0f);

  // 3. Compute STFT frames
  int32_t num_frames =
      static_cast<int32_t>((padded_len - static_cast<size_t>(n_fft)) /
                           static_cast<size_t>(hop)) + 1;
  if (num_frames > max_frames) {
    num_frames = max_frames;
  }

  const int32_t n_mels = config_.n_mels;
  const float log_guard = config_.log_guard;

  for (int32_t t = 0; t < num_frames; ++t) {
    size_t start = static_cast<size_t>(t) * static_cast<size_t>(hop);

    // Apply Hann window
    for (int32_t i = 0; i < n_fft; ++i) {
      fft_real_[static_cast<size_t>(i)] =
          padded_audio_[start + static_cast<size_t>(i)] *
          fft_window_[static_cast<size_t>(i)];
      fft_imag_[static_cast<size_t>(i)] = 0.0f;
    }

    // FFT
    Radix2FFT(fft_real_.data(), fft_imag_.data());

    // Power spectrum
    for (int32_t k = 0; k < freq_bins_; ++k) {
      float r = fft_real_[static_cast<size_t>(k)];
      float im = fft_imag_[static_cast<size_t>(k)];
      power_spec_[static_cast<size_t>(k)] = r * r + im * im;
    }

    // Sparse Mel filterbank + Log
    float* frame_out = out_mel + static_cast<size_t>(t) * static_cast<size_t>(n_mels);
    for (int32_t m = 0; m < n_mels; ++m) {
      const auto& filter = mel_filters_[static_cast<size_t>(m)];
      float sum = 0.0f;
      if (!filter.weights.empty()) {
        const float* p = power_spec_.data() + filter.first_bin;
        const size_t w_size = filter.weights.size();
        const float* w = filter.weights.data();
        for (size_t j = 0; j < w_size; ++j) {
          sum += p[j] * w[j];
        }
      }
      frame_out[m] = std::log(sum + log_guard);
    }
  }

  if (out_num_frames) {
    *out_num_frames = num_frames;
  }
}

} // namespace sherpaonnx::diarization
