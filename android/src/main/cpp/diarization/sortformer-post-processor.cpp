#include "sortformer-post-processor.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace sherpaonnx::diarization {

SortformerPostProcessor::SortformerPostProcessor(
    const SortformerPostProcessorConfig& config)
    : config_(config) {}

void SortformerPostProcessor::ApplyMedianFilter(const float* preds,
                                                int32_t num_frames,
                                                int32_t num_speakers,
                                                float* out_filtered) {
  if (num_frames <= 0 || num_speakers <= 0 || preds == nullptr ||
      out_filtered == nullptr) {
    return;
  }

  const int32_t window = config_.median_window;
  if (window <= 1) {
    std::copy(preds, preds + static_cast<size_t>(num_frames * num_speakers),
              out_filtered);
    return;
  }

  const int32_t half = window / 2;
  std::vector<float> win_buf(static_cast<size_t>(window));

  for (int32_t spk = 0; spk < num_speakers; ++spk) {
    for (int32_t t = 0; t < num_frames; ++t) {
      int32_t start_t = std::max(0, t - half);
      int32_t end_t = std::min(num_frames, t + half + 1);
      int32_t count = end_t - start_t;

      for (int32_t i = 0; i < count; ++i) {
        win_buf[static_cast<size_t>(i)] =
            preds[static_cast<size_t>((start_t + i) * num_speakers + spk)];
      }

      // Quick median via nth_element
      auto mid_it = win_buf.begin() + count / 2;
      std::nth_element(win_buf.begin(), mid_it, win_buf.begin() + count);

      out_filtered[static_cast<size_t>(t * num_speakers + spk)] = *mid_it;
    }
  }
}

void SortformerPostProcessor::Binarize(
    const float* preds, int32_t num_frames, int32_t num_speakers,
    int64_t sample_offset, int64_t max_sample_bound,
    std::vector<DiarizationSegment>& out_segments) {
  if (num_frames <= 0 || num_speakers <= 0 || preds == nullptr) {
    return;
  }

  const float sr = static_cast<float>(config_.sample_rate);
  const int64_t samples_per_frame =
      static_cast<int64_t>(std::round(config_.frame_duration * sr));

  const int64_t pad_onset_samples =
      static_cast<int64_t>(std::round(config_.pad_onset * sr));
  const int64_t pad_offset_samples =
      static_cast<int64_t>(std::round(config_.pad_offset * sr));
  const int64_t min_dur_on_samples =
      static_cast<int64_t>(std::round(config_.min_duration_on * sr));
  const int64_t min_dur_off_samples =
      static_cast<int64_t>(std::round(config_.min_duration_off * sr));

  struct RawSegment {
    int64_t start_s = 0;
    int64_t end_s = 0;
    int32_t speaker = 0;
  };

  std::vector<RawSegment> all_raw;

  for (int32_t spk = 0; spk < num_speakers; ++spk) {
    bool in_seg = false;
    int32_t seg_start = 0;
    std::vector<RawSegment> spk_segs;

    for (int32_t t = 0; t < num_frames; ++t) {
      float p = preds[static_cast<size_t>(t * num_speakers + spk)];

      if (p >= config_.onset && !in_seg) {
        in_seg = true;
        seg_start = t;
      } else if (p < config_.offset && in_seg) {
        in_seg = false;
        int64_t start_s = static_cast<int64_t>(seg_start) * samples_per_frame;
        start_s = std::max<int64_t>(0, start_s - pad_onset_samples);
        int64_t end_s = static_cast<int64_t>(t) * samples_per_frame + pad_offset_samples;

        if (end_s - start_s >= min_dur_on_samples) {
          spk_segs.push_back({start_s, end_s, spk});
        }
      }
    }

    if (in_seg) {
      int64_t start_s = static_cast<int64_t>(seg_start) * samples_per_frame;
      start_s = std::max<int64_t>(0, start_s - pad_onset_samples);
      int64_t end_s = static_cast<int64_t>(num_frames) * samples_per_frame +
                      pad_offset_samples;

      if (end_s - start_s >= min_dur_on_samples) {
        spk_segs.push_back({start_s, end_s, spk});
      }
    }

    // Merge close segments (gap <= min_dur_off_samples)
    if (spk_segs.size() > 1) {
      std::vector<RawSegment> merged;
      merged.push_back(spk_segs[0]);

      for (size_t i = 1; i < spk_segs.size(); ++i) {
        auto& last = merged.back();
        int64_t gap = spk_segs[i].start_s - last.end_s;
        if (gap <= min_dur_off_samples) {
          last.end_s = std::max(last.end_s, spk_segs[i].end_s);
        } else {
          merged.push_back(spk_segs[i]);
        }
      }
      spk_segs = std::move(merged);
    }

    // Shift by sample_offset and clip to bounds
    for (auto& s : spk_segs) {
      s.start_s += sample_offset;
      s.end_s += sample_offset;
      if (max_sample_bound > 0) {
        s.end_s = std::min(s.end_s, max_sample_bound);
      }
      if (s.end_s > s.start_s) {
        all_raw.push_back(s);
      }
    }
  }

  // Sort by start time
  std::sort(all_raw.begin(), all_raw.end(),
            [](const RawSegment& a, const RawSegment& b) {
              if (a.start_s != b.start_s) return a.start_s < b.start_s;
              return a.speaker < b.speaker;
            });

  out_segments.reserve(out_segments.size() + all_raw.size());
  for (const auto& r : all_raw) {
    DiarizationSegment seg;
    seg.start = static_cast<float>(r.start_s) / sr;
    seg.end = static_cast<float>(r.end_s) / sr;
    seg.speaker = r.speaker;
    out_segments.push_back(seg);
  }
}

void SortformerPostProcessor::Process(
    const float* raw_preds, int32_t num_frames, int32_t num_speakers,
    int64_t sample_offset, int64_t max_sample_bound,
    std::vector<DiarizationSegment>& out_segments) {
  if (num_frames <= 0 || num_speakers <= 0 || raw_preds == nullptr) {
    return;
  }

  size_t total = static_cast<size_t>(num_frames * num_speakers);
  if (filtered_scratch_.size() < total) {
    filtered_scratch_.resize(total);
  }

  ApplyMedianFilter(raw_preds, num_frames, num_speakers,
                    filtered_scratch_.data());
  Binarize(filtered_scratch_.data(), num_frames, num_speakers, sample_offset,
           max_sample_bound, out_segments);
}

} // namespace sherpaonnx::diarization
