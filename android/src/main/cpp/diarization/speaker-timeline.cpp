#include "speaker-timeline.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_map>

namespace sherpaonnx::diarization {
namespace {

struct PairHash {
  size_t operator()(const ChunkSpeakerKey& p) const {
    size_t seed = static_cast<size_t>(p.chunk);
    seed ^= static_cast<size_t>(p.local_speaker) + 0x9e3779b9 + (seed << 6) +
            (seed >> 2);
    return seed;
  }
};

std::vector<int32_t> TopkIndex(const int8_t* row, int32_t size, int32_t topk) {
  const int32_t k_num = std::max(0, std::min(size, topk));
  std::vector<int32_t> idx(static_cast<size_t>(size));
  std::iota(idx.begin(), idx.end(), 0);
  std::partial_sort(
      idx.begin(), idx.begin() + k_num, idx.end(),
      [row](int32_t a, int32_t b) { return row[a] > row[b]; });
  if (k_num == size) {
    return idx;
  }
  return {idx.begin(), idx.begin() + k_num};
}

}  // namespace

std::vector<int32_t> ComputeSpeakersPerFrame(
    const std::vector<Int8Matrix>& labels, const PyannoteMeta& meta) {
  if (labels.empty() || meta.receptive_field_shift <= 0) {
    return {};
  }
  const int32_t num_chunks = static_cast<int32_t>(labels.size());
  const int32_t num_frames =
      (meta.window_size + (num_chunks - 1) * meta.window_shift) /
          meta.receptive_field_shift +
      1;

  std::vector<float> count(static_cast<size_t>(num_frames), 0.f);
  std::vector<float> weight(static_cast<size_t>(num_frames), 0.f);

  for (int32_t i = 0; i < num_chunks; ++i) {
    const int32_t start = static_cast<int32_t>(
        static_cast<float>(i) * meta.window_shift / meta.receptive_field_shift +
        0.5f);
    const auto& label = labels[static_cast<size_t>(i)];
    for (int32_t r = 0; r < label.rows; ++r) {
      const int32_t frame = start + r;
      if (frame < 0 || frame >= num_frames) {
        continue;
      }
      int32_t sum = 0;
      for (int32_t c = 0; c < label.cols; ++c) {
        sum += label.at(r, c);
      }
      count[static_cast<size_t>(frame)] += static_cast<float>(sum);
      weight[static_cast<size_t>(frame)] += 1.f;
    }
  }

  std::vector<int32_t> out(static_cast<size_t>(num_frames), 0);
  for (int32_t i = 0; i < num_frames; ++i) {
    out[static_cast<size_t>(i)] = static_cast<int32_t>(
        count[static_cast<size_t>(i)] /
            (weight[static_cast<size_t>(i)] + 1e-12f) +
        0.5f);
  }
  return out;
}

std::vector<Int8Matrix> ExcludeOverlap(
    const std::vector<Int8Matrix>& labels) {
  std::vector<Int8Matrix> ans;
  ans.reserve(labels.size());
  for (const auto& label : labels) {
    Int8Matrix neu;
    neu.resize(label.rows, label.cols, 0);
    for (int32_t r = 0; r < label.rows; ++r) {
      int32_t sum = 0;
      for (int32_t c = 0; c < label.cols; ++c) {
        sum += label.at(r, c);
      }
      if (sum < 2) {
        for (int32_t c = 0; c < label.cols; ++c) {
          neu.at(r, c) = label.at(r, c);
        }
      }
    }
    ans.push_back(std::move(neu));
  }
  return ans;
}

std::vector<ChunkSpeakerSamples> GetChunkSpeakerSampleIndexes(
    const std::vector<Int8Matrix>& labels, const PyannoteMeta& meta) {
  auto non_overlap = ExcludeOverlap(labels);
  std::vector<ChunkSpeakerSamples> out;

  int32_t chunk_index = 0;
  for (const auto& label : non_overlap) {
    const int32_t num_frames = label.rows;
    const int32_t num_speakers = label.cols;
    const int32_t sample_offset = chunk_index * meta.window_shift;

    for (int32_t speaker = 0; speaker < num_speakers; ++speaker) {
      int32_t active_sum = 0;
      for (int32_t f = 0; f < num_frames; ++f) {
        active_sum += label.at(f, speaker);
      }
      if (active_sum < 10) {
        continue;
      }

      ChunkSpeakerSamples entry;
      entry.key = {chunk_index, speaker};

      bool is_active = false;
      int32_t start_index = 0;
      for (int32_t k = 0; k < num_frames; ++k) {
        if (label.at(k, speaker) != 0) {
          if (!is_active) {
            is_active = true;
            start_index = k;
          }
        } else if (is_active) {
          is_active = false;
          const int32_t start_samples = static_cast<int32_t>(
              static_cast<float>(start_index) / num_frames * meta.window_size +
              sample_offset);
          const int32_t end_samples = static_cast<int32_t>(
              static_cast<float>(k) / num_frames * meta.window_size +
              sample_offset);
          entry.ranges.push_back({start_samples, end_samples});
        }
      }
      if (is_active) {
        const int32_t start_samples = static_cast<int32_t>(
            static_cast<float>(start_index) / num_frames * meta.window_size +
            sample_offset);
        const int32_t end_samples = static_cast<int32_t>(
            static_cast<float>(num_frames - 1) / num_frames * meta.window_size +
            sample_offset);
        entry.ranges.push_back({start_samples, end_samples});
      }

      out.push_back(std::move(entry));
    }
    ++chunk_index;
  }
  return out;
}

std::vector<Int8Matrix> Relabel(const std::vector<Int8Matrix>& labels,
                                int32_t num_clusters,
                                const std::vector<ChunkSpeakerKey>& keys,
                                const std::vector<int32_t>& cluster_labels) {
  std::unordered_map<ChunkSpeakerKey, int32_t, PairHash> map;
  const size_t n = std::min(keys.size(), cluster_labels.size());
  for (size_t i = 0; i < n; ++i) {
    map[keys[i]] = cluster_labels[i];
  }

  std::vector<Int8Matrix> new_labels;
  new_labels.reserve(labels.size());
  const int32_t cols = std::max(1, num_clusters);

  for (int32_t chunk = 0; chunk < static_cast<int32_t>(labels.size()); ++chunk) {
    const auto& label = labels[static_cast<size_t>(chunk)];
    Int8Matrix neu;
    neu.resize(label.rows, cols, 0);
    for (int32_t speaker = 0; speaker < label.cols; ++speaker) {
      auto it = map.find(ChunkSpeakerKey{chunk, speaker});
      if (it == map.end()) {
        continue;
      }
      const int32_t new_speaker = it->second;
      if (new_speaker < 0 || new_speaker >= cols) {
        continue;
      }
      for (int32_t f = 0; f < label.rows; ++f) {
        if (label.at(f, speaker) == 1) {
          neu.at(f, new_speaker) = 1;
        }
      }
    }
    new_labels.push_back(std::move(neu));
  }
  return new_labels;
}

Int8Matrix ComputeSpeakerCount(const std::vector<Int8Matrix>& relabeled,
                               int32_t num_samples, const PyannoteMeta& meta) {
  Int8Matrix count;
  if (relabeled.empty() || meta.receptive_field_shift <= 0) {
    return count;
  }
  const int32_t num_chunks = static_cast<int32_t>(relabeled.size());
  const int32_t num_frames =
      (meta.window_size + (num_chunks - 1) * meta.window_shift) /
          meta.receptive_field_shift +
      1;
  const int32_t num_cols = relabeled[0].cols;
  // Use int16 accumulation then clamp — counts can exceed int8.
  std::vector<int32_t> acc(static_cast<size_t>(num_frames) *
                               static_cast<size_t>(num_cols),
                           0);

  for (int32_t i = 0; i < num_chunks; ++i) {
    const int32_t start = static_cast<int32_t>(
        static_cast<float>(i) * meta.window_shift / meta.receptive_field_shift +
        0.5f);
    const auto& label = relabeled[static_cast<size_t>(i)];
    for (int32_t r = 0; r < label.rows; ++r) {
      const int32_t frame = start + r;
      if (frame < 0 || frame >= num_frames) {
        continue;
      }
      for (int32_t c = 0; c < label.cols && c < num_cols; ++c) {
        acc[static_cast<size_t>(frame) * static_cast<size_t>(num_cols) +
            static_cast<size_t>(c)] += label.at(r, c);
      }
    }
  }

  bool has_last_chunk =
      ((num_samples - meta.window_size) % meta.window_shift) > 0;
  int32_t keep_frames = num_frames;
  if (has_last_chunk) {
    int32_t last_frame = num_samples / meta.receptive_field_shift;
    if (last_frame >= num_frames) {
      last_frame = num_frames - 1;
    }
    keep_frames = last_frame + 1;
  }

  count.resize(keep_frames, num_cols, 0);
  for (int32_t r = 0; r < keep_frames; ++r) {
    for (int32_t c = 0; c < num_cols; ++c) {
      const int32_t v =
          acc[static_cast<size_t>(r) * static_cast<size_t>(num_cols) +
              static_cast<size_t>(c)];
      count.at(r, c) =
          static_cast<int8_t>(std::min(127, std::max(0, v)));
    }
  }
  return count;
}

Int8Matrix FinalizeLabels(const Int8Matrix& speaker_count,
                          const std::vector<int32_t>& speakers_per_frame) {
  Int8Matrix ans;
  ans.resize(speaker_count.rows, speaker_count.cols, 0);
  const int32_t rows =
      std::min(speaker_count.rows,
               static_cast<int32_t>(speakers_per_frame.size()));
  for (int32_t i = 0; i < rows; ++i) {
    const int32_t k = speakers_per_frame[static_cast<size_t>(i)];
    if (k <= 0) {
      continue;
    }
    const int8_t* row =
        speaker_count.data.data() +
        static_cast<size_t>(i) * static_cast<size_t>(speaker_count.cols);
    auto top = TopkIndex(row, speaker_count.cols, k);
    for (int32_t m : top) {
      if (m >= 0 && m < speaker_count.cols) {
        ans.at(i, m) = 1;
      }
    }
  }
  return ans;
}

std::vector<DiarizationSegment> ComputeResult(const Int8Matrix& final_labels,
                                              const TimelineConfig& config) {
  std::vector<DiarizationSegment> result;
  if (final_labels.rows <= 0 || final_labels.cols <= 0 ||
      config.meta.sample_rate <= 0 ||
      config.meta.receptive_field_shift <= 0) {
    return result;
  }

  const auto& meta = config.meta;
  const float scale =
      static_cast<float>(meta.receptive_field_shift) / meta.sample_rate;
  const float scale_offset =
      0.5f * static_cast<float>(meta.receptive_field_size) / meta.sample_rate;

  for (int32_t speaker = 0; speaker < final_labels.cols; ++speaker) {
    std::vector<DiarizationSegment> this_speaker;
    bool is_active = final_labels.at(0, speaker) > 0;
    int32_t start_index = is_active ? 0 : -1;

    for (int32_t frame = 1; frame < final_labels.rows; ++frame) {
      if (is_active) {
        if (final_labels.at(frame, speaker) == 0) {
          DiarizationSegment seg;
          seg.start = start_index * scale + scale_offset;
          seg.end = frame * scale + scale_offset;
          seg.speaker = speaker;
          this_speaker.push_back(seg);
          is_active = false;
        }
      } else if (final_labels.at(frame, speaker) == 1) {
        is_active = true;
        start_index = frame;
      }
    }
    if (is_active) {
      DiarizationSegment seg;
      seg.start = start_index * scale + scale_offset;
      seg.end = final_labels.rows * scale + scale_offset;
      seg.speaker = speaker;
      this_speaker.push_back(seg);
    }

    // Merge gaps shorter than min_duration_off
    bool changed = true;
    while (changed) {
      changed = false;
      for (size_t i = 0; i + 1 < this_speaker.size(); ++i) {
        const float gap = this_speaker[i + 1].start - this_speaker[i].end;
        if (gap <= config.min_duration_off) {
          this_speaker[i].end = this_speaker[i + 1].end;
          this_speaker.erase(this_speaker.begin() +
                             static_cast<std::ptrdiff_t>(i + 1));
          changed = true;
          break;
        }
      }
    }

    for (const auto& seg : this_speaker) {
      if ((seg.end - seg.start) > config.min_duration_on) {
        result.push_back(seg);
      }
    }
  }

  std::sort(result.begin(), result.end(),
            [](const DiarizationSegment& a, const DiarizationSegment& b) {
              if (a.start != b.start) {
                return a.start < b.start;
              }
              return a.speaker < b.speaker;
            });
  return result;
}

Int8Matrix SpeechUnionLabels(const std::vector<int32_t>& speakers_per_frame) {
  Int8Matrix out;
  const int32_t rows = static_cast<int32_t>(speakers_per_frame.size());
  out.resize(rows, 1, 0);
  for (int32_t r = 0; r < rows; ++r) {
    out.at(r, 0) = speakers_per_frame[static_cast<size_t>(r)] >= 1 ? 1 : 0;
  }
  return out;
}

Int8Matrix TrimLabelsForNumSamples(const Int8Matrix& labels,
                                   int32_t num_samples,
                                   const PyannoteMeta& meta) {
  if (labels.rows <= 0 || meta.receptive_field_shift <= 0) {
    return labels;
  }
  const bool has_last =
      ((num_samples - meta.window_size) % meta.window_shift) > 0;
  if (!has_last) {
    return labels;
  }
  int32_t new_num_frames = num_samples / meta.receptive_field_shift;
  int32_t keep = std::min(new_num_frames, labels.rows);
  if (keep <= 0) {
    return labels;
  }
  Int8Matrix out;
  out.resize(keep, labels.cols, 0);
  for (int32_t r = 0; r < keep; ++r) {
    for (int32_t c = 0; c < labels.cols; ++c) {
      out.at(r, c) = labels.at(r, c);
    }
  }
  return out;
}

}  // namespace sherpaonnx::diarization
