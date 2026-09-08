#include "pyannote-segmentation-session.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace sherpaonnx::diarization {

PyannoteSegmentationSession::PyannoteSegmentationSession() = default;
PyannoteSegmentationSession::~PyannoteSegmentationSession() { Release(); }

void PyannoteSegmentationSession::Release() {
  segmentation_.Release();
  timeline_config_ = {};
  initialized_ = false;
}

bool PyannoteSegmentationSession::isInitialized() const {
  return initialized_;
}

const PyannoteMeta& PyannoteSegmentationSession::meta() const {
  return segmentation_.meta();
}

Status PyannoteSegmentationSession::Initialize(
    const PyannoteSegOptions& options) {
  Release();

  if (options.model_path.empty()) {
    return Status::Fail(kErrInvalidArgument, "model_path is required");
  }

  PyannoteLoadOptions seg_opts;
  seg_opts.model_path = options.model_path;
  seg_opts.window_shift_ratio = options.window_shift_ratio;
  seg_opts.num_threads = options.num_threads;
  seg_opts.provider = options.provider;
  seg_opts.debug = options.debug;

  Status st = segmentation_.Load(seg_opts);
  if (!st.ok) {
    return st;
  }

  timeline_config_.meta = segmentation_.meta();
  timeline_config_.min_duration_on = options.min_duration_on;
  timeline_config_.min_duration_off = options.min_duration_off;
  initialized_ = true;
  return Status::Ok();
}

std::vector<float> PyannoteSegmentationSession::ResampleIfNeeded(
    const float* input, int32_t n, int32_t src_rate, int32_t dst_rate) const {
  if (input == nullptr || n <= 0 || src_rate <= 0 || dst_rate <= 0 ||
      src_rate == dst_rate) {
    if (input == nullptr || n <= 0) {
      return {};
    }
    return std::vector<float>(input, input + n);
  }
  const size_t output_length = std::max<size_t>(
      1, static_cast<size_t>(
             std::floor(static_cast<double>(n) * dst_rate / src_rate)));
  std::vector<float> output(output_length, 0.f);
  const double ratio = static_cast<double>(src_rate) / dst_rate;
  const size_t input_size = static_cast<size_t>(n);
  for (size_t i = 0; i < output_length; ++i) {
    const double src_pos = static_cast<double>(i) * ratio;
    const size_t left = static_cast<size_t>(std::floor(src_pos));
    const size_t right = std::min(left + 1, input_size - 1);
    const double frac = src_pos - static_cast<double>(left);
    const float left_val = input[std::min(left, input_size - 1)];
    const float right_val = input[right];
    output[i] = static_cast<float>(left_val + (right_val - left_val) * frac);
  }
  return output;
}

Status PyannoteSegmentationSession::ProcessMono(
    const float* samples, int32_t n, int32_t sample_rate,
    std::vector<PyannoteSpeechSpan>* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "out is required");
  }
  out->clear();

  if (!initialized_) {
    return Status::Fail(kErrNotInitialized,
                        "pyannote segmentation session not initialized");
  }
  if (samples == nullptr || n <= 0 || sample_rate <= 0) {
    return Status::Fail(kErrInvalidArgument,
                        "empty audio or invalid sample rate");
  }

  const int32_t target_sr = segmentation_.meta().sample_rate;
  std::vector<float> audio =
      ResampleIfNeeded(samples, n, sample_rate, target_sr);
  const int32_t audio_n = static_cast<int32_t>(audio.size());
  if (audio_n <= 0) {
    return Status::Ok();
  }

  const auto& meta = segmentation_.meta();
  std::vector<Int8Matrix> chunk_labels;

  int32_t num_chunks = 1;
  bool has_last = false;
  if (audio_n > meta.window_size) {
    num_chunks = (audio_n - meta.window_size) / meta.window_shift + 1;
    has_last = ((audio_n - meta.window_size) % meta.window_shift) > 0;
  }
  const int32_t total_windows = num_chunks + (has_last ? 1 : 0);
  chunk_labels.reserve(static_cast<size_t>(total_windows));

  auto process_window = [&](const float* ptr) -> Status {
    std::vector<float> logits;
    int32_t frames = 0;
    Status st =
        segmentation_.ForwardWindow(ptr, meta.window_size, &logits, &frames);
    if (!st.ok) {
      return st;
    }
    Int8Matrix labels = segmentation_.powerset().Decode(
        logits.data(), frames, meta.num_classes);
    chunk_labels.push_back(std::move(labels));
    return Status::Ok();
  };

  if (audio_n <= meta.window_size) {
    std::vector<float> buf(static_cast<size_t>(meta.window_size), 0.f);
    std::copy(audio.begin(), audio.end(), buf.begin());
    Status st = process_window(buf.data());
    if (!st.ok) {
      return st;
    }
  } else {
    const float* p = audio.data();
    for (int32_t i = 0; i < num_chunks; ++i, p += meta.window_shift) {
      Status st = process_window(p);
      if (!st.ok) {
        return st;
      }
    }
    if (has_last) {
      std::vector<float> buf(static_cast<size_t>(meta.window_size), 0.f);
      const int32_t remaining =
          static_cast<int32_t>(audio.data() + audio_n - p);
      std::copy(p, p + remaining, buf.begin());
      Status st = process_window(buf.data());
      if (!st.ok) {
        return st;
      }
    }
  }

  if (chunk_labels.empty()) {
    return Status::Ok();
  }

  if (chunk_labels.size() == 1) {
    Int8Matrix trimmed =
        TrimLabelsForNumSamples(chunk_labels[0], audio_n, meta);
    // Collapse multi-speaker columns to a single speech/silence column.
    Int8Matrix union_labels;
    union_labels.resize(trimmed.rows, 1, 0);
    for (int32_t r = 0; r < trimmed.rows; ++r) {
      int8_t any = 0;
      for (int32_t c = 0; c < trimmed.cols; ++c) {
        if (trimmed.at(r, c) > 0) {
          any = 1;
          break;
        }
      }
      union_labels.at(r, 0) = any;
    }
    auto segments = ComputeResult(union_labels, timeline_config_);
    out->reserve(segments.size());
    for (const auto& seg : segments) {
      PyannoteSpeechSpan span;
      span.start = seg.start;
      span.end = seg.end;
      out->push_back(span);
    }
    return Status::Ok();
  }

  auto speakers_per_frame = ComputeSpeakersPerFrame(chunk_labels, meta);
  Int8Matrix union_labels = SpeechUnionLabels(speakers_per_frame);
  auto segments = ComputeResult(union_labels, timeline_config_);
  out->reserve(segments.size());
  for (const auto& seg : segments) {
    PyannoteSpeechSpan span;
    span.start = seg.start;
    span.end = seg.end;
    out->push_back(span);
  }
  return Status::Ok();
}

}  // namespace sherpaonnx::diarization
