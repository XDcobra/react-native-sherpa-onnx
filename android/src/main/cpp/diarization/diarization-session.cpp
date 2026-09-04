#include "diarization-session.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace sherpaonnx::diarization {
namespace {

bool CheckCancel(const std::atomic<bool>& flag) { return flag.load(); }

}  // namespace

DiarizationSession::DiarizationSession() = default;
DiarizationSession::~DiarizationSession() { Release(); }

void DiarizationSession::Release() {
  requestCancel();
  segmentation_.Release();
  embedding_.Release();
  chunk_labels_.clear();
  speakers_per_frame_.clear();
  chunk_speaker_keys_.clear();
  embedding_matrix_ = {};
  last_cluster_labels_.clear();
  last_segments_.clear();
  last_num_samples_ = 0;
  working_sample_rate_ = 0;
  initialized_ = false;
  clearCancel();
}

bool DiarizationSession::isInitialized() const { return initialized_; }

int32_t DiarizationSession::sampleRate() const {
  return segmentation_.isLoaded() ? segmentation_.meta().sample_rate : 0;
}

void DiarizationSession::setClustering(int32_t num_clusters, float threshold) {
  ClusteringConfig cfg;
  cfg.num_clusters = num_clusters;
  cfg.threshold = threshold;
  clusterer_.setConfig(cfg);
}

void DiarizationSession::requestCancel() { cancel_.store(true); }
void DiarizationSession::clearCancel() { cancel_.store(false); }

Status DiarizationSession::Initialize(const DiarizationInitConfig& config) {
  Release();
  clearCancel();

  PyannoteLoadOptions seg_opts;
  seg_opts.model_path = config.segmentation_model;
  seg_opts.window_shift_ratio = config.window_shift_ratio;
  seg_opts.num_threads = config.num_threads;
  seg_opts.provider = config.provider;
  seg_opts.debug = config.debug;

  Status st = segmentation_.Load(seg_opts);
  if (!st.ok) {
    return st;
  }

  ::sherpaonnx::speaker_embedding::EmbeddingRunnerOptions emb_opts;
  emb_opts.model_path = config.embedding_model;
  emb_opts.num_threads = config.num_threads;
  emb_opts.provider = config.provider;
  emb_opts.debug = config.debug;
  st = embedding_.Acquire(emb_opts);
  if (!st.ok) {
    segmentation_.Release();
    return st;
  }

  setClustering(config.num_clusters, config.threshold);
  timeline_config_.meta = segmentation_.meta();
  timeline_config_.min_duration_on = config.min_duration_on;
  timeline_config_.min_duration_off = config.min_duration_off;
  working_sample_rate_ = segmentation_.meta().sample_rate;
  initialized_ = true;
  return Status::Ok();
}

std::vector<float> DiarizationSession::ResampleIfNeeded(
    const std::vector<float>& input, int32_t src_rate, int32_t dst_rate) const {
  if (input.empty() || src_rate <= 0 || dst_rate <= 0 || src_rate == dst_rate) {
    return input;
  }
  const size_t output_length = std::max<size_t>(
      1, static_cast<size_t>(std::floor(static_cast<double>(input.size()) *
                                        dst_rate / src_rate)));
  std::vector<float> output(output_length, 0.f);
  const double ratio = static_cast<double>(src_rate) / dst_rate;
  for (size_t i = 0; i < output_length; ++i) {
    const double src_pos = static_cast<double>(i) * ratio;
    const size_t left = static_cast<size_t>(std::floor(src_pos));
    const size_t right = std::min(left + 1, input.size() - 1);
    const double frac = src_pos - static_cast<double>(left);
    const float left_val = input[std::min(left, input.size() - 1)];
    const float right_val = input[right];
    output[i] = static_cast<float>(left_val + (right_val - left_val) * frac);
  }
  return output;
}

ProcessResult DiarizationSession::Process(const std::vector<float>& mono_samples,
                                          int32_t sample_rate,
                                          const ProcessOptions& options) {
  ProcessResult result;
  if (!initialized_) {
    result.status =
        Status::Fail(kErrNotInitialized, "diarization session not initialized");
    return result;
  }
  clearCancel();

  if (mono_samples.empty() || sample_rate <= 0) {
    result.status =
        Status::Fail(kErrInvalidArgument, "empty audio or invalid sample rate");
    return result;
  }

  const int32_t target_sr = segmentation_.meta().sample_rate;
  std::vector<float> audio =
      ResampleIfNeeded(mono_samples, sample_rate, target_sr);
  const int32_t n = static_cast<int32_t>(audio.size());
  const auto& meta = segmentation_.meta();

  // --- Segmentation ---
  chunk_labels_.clear();
  speakers_per_frame_.clear();
  chunk_speaker_keys_.clear();
  embedding_matrix_ = {};
  last_cluster_labels_.clear();
  last_segments_.clear();
  last_num_samples_ = n;

  auto report = [&](const char* phase, int32_t cur, int32_t tot, float base,
                    float span) {
    if (!options.on_progress) {
      return;
    }
    DiarizationProgress p;
    p.phase = phase;
    p.current = cur;
    p.total = tot;
    p.fraction = base + (tot > 0 ? span * (static_cast<float>(cur) / tot) : span);
    options.on_progress(p);
  };

  if (n <= 0) {
    result.status = Status::Ok();
    return result;
  }

  int32_t num_chunks = 1;
  bool has_last = false;
  if (n > meta.window_size) {
    num_chunks = (n - meta.window_size) / meta.window_shift + 1;
    has_last = ((n - meta.window_size) % meta.window_shift) > 0;
  }
  const int32_t total_windows = num_chunks + (has_last ? 1 : 0);
  chunk_labels_.reserve(static_cast<size_t>(total_windows));

  auto process_window = [&](const float* ptr) -> Status {
    std::vector<float> logits;
    int32_t frames = 0;
    Status st =
        segmentation_.ForwardWindow(ptr, meta.window_size, &logits, &frames);
    if (!st.ok) {
      return st;
    }
    Int8Matrix labels =
        segmentation_.powerset().Decode(logits.data(), frames, meta.num_classes);
    chunk_labels_.push_back(std::move(labels));
    return Status::Ok();
  };

  if (n <= meta.window_size) {
    std::vector<float> buf(static_cast<size_t>(meta.window_size), 0.f);
    std::copy(audio.begin(), audio.end(), buf.begin());
    Status st = process_window(buf.data());
    if (!st.ok) {
      result.status = st;
      return result;
    }
    report("segmentation", 1, 1, 0.f, 0.45f);
  } else {
    const float* p = audio.data();
    for (int32_t i = 0; i < num_chunks; ++i, p += meta.window_shift) {
      if (CheckCancel(cancel_)) {
        result.status = Status::Fail(kErrCancelled, "cancelled during segmentation");
        return result;
      }
      Status st = process_window(p);
      if (!st.ok) {
        result.status = st;
        return result;
      }
      report("segmentation", i + 1, total_windows, 0.f, 0.45f);
    }
    if (has_last) {
      if (CheckCancel(cancel_)) {
        result.status = Status::Fail(kErrCancelled, "cancelled during segmentation");
        return result;
      }
      std::vector<float> buf(static_cast<size_t>(meta.window_size), 0.f);
      const int32_t remaining =
          static_cast<int32_t>(audio.data() + n - p);
      std::copy(p, p + remaining, buf.begin());
      Status st = process_window(buf.data());
      if (!st.ok) {
        result.status = st;
        return result;
      }
      report("segmentation", total_windows, total_windows, 0.f, 0.45f);
    }
  }

  if (chunk_labels_.size() == 1) {
    Int8Matrix trimmed =
        TrimLabelsForNumSamples(chunk_labels_[0], n, meta);
    last_segments_ = ComputeResult(trimmed, timeline_config_);
    result.segments = last_segments_;
    result.num_speakers = 0;
    for (const auto& s : result.segments) {
      result.num_speakers = std::max(result.num_speakers, s.speaker + 1);
    }
    result.sample_rate = target_sr;
    if (options.include_overlap) {
      result.speakers_per_frame = ComputeSpeakersPerFrame(chunk_labels_, meta);
    }
    result.status = Status::Ok();
    report("clustering", 1, 1, 0.9f, 0.1f);
    return result;
  }

  speakers_per_frame_ = ComputeSpeakersPerFrame(chunk_labels_, meta);
  int32_t max_spf = 0;
  for (int32_t v : speakers_per_frame_) {
    max_spf = std::max(max_spf, v);
  }
  if (max_spf == 0) {
    result.status = Status::Ok();
    result.sample_rate = target_sr;
    return result;
  }

  auto sample_indexes =
      GetChunkSpeakerSampleIndexes(chunk_labels_, meta);
  if (sample_indexes.empty()) {
    result.status = Status::Ok();
    result.sample_rate = target_sr;
    return result;
  }

  // --- Embeddings ---
  const int32_t dim = embedding_.dim();
  FloatMatrix emb_mat;
  emb_mat.resize(static_cast<int32_t>(sample_indexes.size()), dim, 0.f);
  chunk_speaker_keys_.clear();
  chunk_speaker_keys_.reserve(sample_indexes.size());

  int32_t valid_rows = 0;
  const int32_t total_emb = static_cast<int32_t>(sample_indexes.size());
  for (int32_t i = 0; i < total_emb; ++i) {
    if (CheckCancel(cancel_)) {
      result.status = Status::Fail(kErrCancelled, "cancelled during embedding");
      return result;
    }
    std::vector<float> emb;
    Status st = embedding_.Compute(audio.data(), n, target_sr,
                                   sample_indexes[static_cast<size_t>(i)].ranges,
                                   &emb);
    report("embedding", i + 1, total_emb, 0.45f, 0.45f);
    if (!st.ok) {
      // Skip short / NaN — upstream filters these.
      continue;
    }
    std::copy(emb.begin(), emb.end(), emb_mat.rowPtr(valid_rows));
    chunk_speaker_keys_.push_back(sample_indexes[static_cast<size_t>(i)].key);
    ++valid_rows;
  }

  if (valid_rows == 0) {
    result.status = Status::Ok();
    result.sample_rate = target_sr;
    return result;
  }

  emb_mat.rows = valid_rows;
  emb_mat.data.resize(static_cast<size_t>(valid_rows) *
                      static_cast<size_t>(dim));
  embedding_matrix_ = std::move(emb_mat);

  return FinishFromCache(options);
}

ProcessResult DiarizationSession::FinishFromCache(
    const ProcessOptions& options) {
  ProcessResult result;
  result.sample_rate = working_sample_rate_;

  if (embedding_matrix_.rows <= 0) {
    result.status = Status::Ok();
    return result;
  }

  // Copy features — Cluster normalizes in place.
  FloatMatrix features = embedding_matrix_;
  last_cluster_labels_ = clusterer_.Cluster(
      features.data.data(), features.rows, features.cols);
  if (last_cluster_labels_.empty()) {
    result.status = Status::Ok();
    return result;
  }

  int32_t max_cluster =
      *std::max_element(last_cluster_labels_.begin(),
                        last_cluster_labels_.end());
  const int32_t num_clusters = max_cluster + 1;

  auto relabeled =
      Relabel(chunk_labels_, num_clusters, chunk_speaker_keys_,
              last_cluster_labels_);
  Int8Matrix speaker_count =
      ComputeSpeakerCount(relabeled, last_num_samples_, timeline_config_.meta);
  Int8Matrix final_labels =
      FinalizeLabels(speaker_count, speakers_per_frame_);
  last_segments_ = ComputeResult(final_labels, timeline_config_);

  result.segments = last_segments_;
  result.num_speakers = num_clusters;
  if (options.include_overlap) {
    result.speakers_per_frame = speakers_per_frame_;
  }
  result.status = Status::Ok();

  if (options.on_progress) {
    DiarizationProgress p;
    p.phase = "clustering";
    p.current = 1;
    p.total = 1;
    p.fraction = 1.f;
    options.on_progress(p);
  }
  return result;
}

ProcessResult DiarizationSession::Recluster(int32_t num_clusters,
                                            float threshold) {
  ProcessResult result;
  if (!initialized_) {
    result.status =
        Status::Fail(kErrNotInitialized, "diarization session not initialized");
    return result;
  }
  if (embedding_matrix_.rows <= 0) {
    result.status =
        Status::Fail(kErrInvalidArgument, "no cached embeddings to recluster");
    return result;
  }
  setClustering(num_clusters, threshold);
  ProcessOptions opts;
  opts.include_overlap = false;
  return FinishFromCache(opts);
}

std::vector<ClusterEmbedding> DiarizationSession::getClusterEmbeddings()
    const {
  std::vector<ClusterEmbedding> out;
  if (embedding_matrix_.rows <= 0 || last_cluster_labels_.empty()) {
    return out;
  }
  const int32_t dim = embedding_matrix_.cols;
  int32_t max_c = 0;
  for (int32_t c : last_cluster_labels_) {
    max_c = std::max(max_c, c);
  }
  const int32_t num = max_c + 1;
  std::vector<std::vector<float>> sums(static_cast<size_t>(num),
                                       std::vector<float>(static_cast<size_t>(dim),
                                                          0.f));
  std::vector<int32_t> counts(static_cast<size_t>(num), 0);

  for (int32_t i = 0; i < embedding_matrix_.rows; ++i) {
    const int32_t c = last_cluster_labels_[static_cast<size_t>(i)];
    if (c < 0 || c >= num) {
      continue;
    }
    const float* row = embedding_matrix_.rowPtr(i);
    for (int32_t d = 0; d < dim; ++d) {
      sums[static_cast<size_t>(c)][static_cast<size_t>(d)] += row[d];
    }
    counts[static_cast<size_t>(c)] += 1;
  }

  for (int32_t c = 0; c < num; ++c) {
    if (counts[static_cast<size_t>(c)] <= 0) {
      continue;
    }
    ClusterEmbedding ce;
    ce.speaker = c;
    ce.embedding.resize(static_cast<size_t>(dim));
    const float inv = 1.f / static_cast<float>(counts[static_cast<size_t>(c)]);
    for (int32_t d = 0; d < dim; ++d) {
      ce.embedding[static_cast<size_t>(d)] =
          sums[static_cast<size_t>(c)][static_cast<size_t>(d)] * inv;
    }
    out.push_back(std::move(ce));
  }
  return out;
}

}  // namespace sherpaonnx::diarization
