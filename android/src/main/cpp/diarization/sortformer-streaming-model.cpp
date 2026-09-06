#include "sortformer-streaming-model.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>

#if !defined(__has_include)
#error "Diarization requires a compiler with __has_include for ORT headers"
#endif

#if __has_include("onnxruntime_cxx_api.h")
#include "onnxruntime_cxx_api.h"  // NOLINT
#elif __has_include(<onnxruntime/core/session/onnxruntime_cxx_api.h>)
#include <onnxruntime/core/session/onnxruntime_cxx_api.h>
#else
#error \
    "Diarization requires onnxruntime_cxx_api.h — ORT headers must be on the include path"
#endif

namespace sherpaonnx::diarization {
namespace {

constexpr int32_t kSpkCacheSilFramesPerSpk = 3;
constexpr float kPredScoreThreshold = 0.25f;
constexpr float kStrongBoostRate = 0.75f;
constexpr float kWeakBoostRate = 1.5f;
constexpr float kMinPosScoresRate = 0.5f;
constexpr float kSilThreshold = 0.2f;
constexpr int32_t kMaxIndex = 99999;

std::string LookupMeta(const Ort::ModelMetadata& meta, OrtAllocator* alloc,
                       const char* key) {
#if ORT_API_VERSION >= 12
  auto value = meta.LookupCustomMetadataMapAllocated(key, alloc);
  return value ? std::string(value.get()) : std::string();
#else
  char* value = meta.LookupCustomMetadataMap(key, alloc);
  std::string ans = value ? value : "";
  if (value) {
    alloc->Free(alloc, value);
  }
  return ans;
#endif
}

bool ParseIntFromStr(const std::string& str, int32_t* out) {
  if (str.empty()) return false;
  try {
    size_t idx = 0;
    long v = std::stol(str, &idx, 10);
    if (idx != str.size()) return false;
    *out = static_cast<int32_t>(v);
    return true;
  } catch (...) {
    return false;
  }
}

int32_t ExtractJsonInt(const std::string& json, const std::string& key,
                       int32_t fallback) {
  std::string needle = "\"" + key + "\"";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return fallback;
  pos++;
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' ||
                               json[pos] == '\r' || json[pos] == '\n')) {
    pos++;
  }
  size_t end = pos;
  while (end < json.size() &&
         ((json[end] >= '0' && json[end] <= '9') || json[end] == '-')) {
    end++;
  }
  if (end > pos) {
    int32_t val = 0;
    if (ParseIntFromStr(json.substr(pos, end - pos), &val)) {
      return val;
    }
  }
  return fallback;
}

} // namespace

class SortformerStreamingModel::Impl {
 public:
  Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-sortformer"};
  Ort::SessionOptions session_options;
  std::unique_ptr<Ort::Session> session;
  Ort::AllocatorWithDefaultOptions allocator;
  Ort::MemoryInfo memory_info =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
};

SortformerStreamingModel::SortformerStreamingModel() = default;
SortformerStreamingModel::~SortformerStreamingModel() { Release(); }

bool SortformerStreamingModel::IsInitialized() const {
  return impl_ != nullptr && impl_->session != nullptr;
}

void SortformerStreamingModel::Release() {
  impl_.reset();
  fbank_.reset();
  post_processor_.reset();
  Reset();
}

void SortformerStreamingModel::Reset() {
  fifo_.clear();
  fifo_len_curr_ = 0;
  fifo_preds_.clear();

  spkcache_.clear();
  spkcache_len_curr_ = 0;
  spkcache_preds_.clear();

  mean_sil_emb_.assign(static_cast<size_t>(info_.embedding_dim), 0.0f);
  n_sil_frames_ = 0;
}

SortformerStreamingModel::StateSnapshot
SortformerStreamingModel::GetStateSnapshot() const {
  return {fifo_len_curr_, spkcache_len_curr_, n_sil_frames_};
}

void SortformerStreamingModel::TestSetState(
    const std::vector<float>& fifo_embs, int32_t fifo_len,
    const std::vector<float>& fifo_preds,
    const std::vector<float>& cache_embs, int32_t cache_len,
    const std::vector<float>& cache_preds,
    const std::vector<float>& mean_sil_emb, int32_t n_sil_frames) {
  fifo_ = fifo_embs;
  fifo_len_curr_ = fifo_len;
  fifo_preds_ = fifo_preds;

  spkcache_ = cache_embs;
  spkcache_len_curr_ = cache_len;
  spkcache_preds_ = cache_preds;

  mean_sil_emb_ = mean_sil_emb;
  n_sil_frames_ = n_sil_frames;
}

void SortformerStreamingModel::TestCompressCache() {
  CompressSpkCache();
}

void SortformerStreamingModel::TestUpdateSilenceProfile(
    const float* pop_embs, const float* pop_preds, int32_t num_frames) {
  UpdateSilenceProfile(pop_embs, pop_preds, num_frames);
}

Status SortformerStreamingModel::LoadMetadata(const std::string& model_path,
                                              const std::string& metadata_path) {
  (void)model_path;
  // Defaults
  info_.model_type = "sortformer";
  info_.sample_rate = 16000;
  info_.chunk_len = 124;
  info_.right_context = 1;
  info_.fifo_len = 124;
  info_.spkcache_len = 188;
  info_.max_speakers = 4;
  info_.feature_dim = 128;
  info_.embedding_dim = 512;
  info_.subsampling = 8;
  info_.hop_length = 160;

  // 1. Try reading external metadata.json if provided
  if (!metadata_path.empty()) {
    std::ifstream f(metadata_path);
    if (f.is_open()) {
      std::stringstream ss;
      ss << f.rdbuf();
      std::string json = ss.str();
      info_.chunk_len = ExtractJsonInt(json, "chunk_len", info_.chunk_len);
      info_.right_context = ExtractJsonInt(json, "right_context", info_.right_context);
      info_.fifo_len = ExtractJsonInt(json, "fifo_len", info_.fifo_len);
      info_.spkcache_len = ExtractJsonInt(json, "spkcache_len", info_.spkcache_len);
      info_.max_speakers = ExtractJsonInt(json, "max_speakers", info_.max_speakers);
      info_.sample_rate = ExtractJsonInt(json, "sample_rate", info_.sample_rate);
      info_.feature_dim = ExtractJsonInt(json, "feature_dim", info_.feature_dim);
      return Status::Ok();
    }
  }

  // 2. Read embedded ONNX metadata_props
  if (impl_ && impl_->session) {
    Ort::ModelMetadata meta = impl_->session->GetModelMetadata();
    OrtAllocator* alloc = impl_->allocator;

    int32_t v = 0;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "chunk_len"), &v)) info_.chunk_len = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "right_context"), &v)) info_.right_context = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "fifo_len"), &v)) info_.fifo_len = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "spkcache_len"), &v)) info_.spkcache_len = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "max_speakers"), &v)) info_.max_speakers = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "sample_rate"), &v)) info_.sample_rate = v;
    if (ParseIntFromStr(LookupMeta(meta, alloc, "feature_dim"), &v)) info_.feature_dim = v;
  }

  return Status::Ok();
}

Status SortformerStreamingModel::Initialize(const StreamingDiarizerConfig& config) {
  Release();
  config_ = config;

  if (config_.model_path.empty()) {
    return Status::Fail(kErrInvalidArgument, "Sortformer model path is empty");
  }

  try {
    auto impl = std::make_unique<Impl>();
    impl->session_options.SetIntraOpNumThreads(std::max(1, config_.num_threads));
    impl->session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

#if defined(_WIN32)
    std::wstring wide(config_.model_path.begin(), config_.model_path.end());
    impl->session = std::make_unique<Ort::Session>(impl->env, wide.c_str(), impl->session_options);
#else
    impl->session = std::make_unique<Ort::Session>(impl->env, config_.model_path.c_str(), impl->session_options);
#endif

    impl_ = std::move(impl);

    Status meta_st = LoadMetadata(config_.model_path, config_.metadata_path);
    if (!meta_st.ok) {
      return meta_st;
    }

    // Configure Fbank
    SortformerFbankConfig fbank_cfg;
    fbank_cfg.sample_rate = info_.sample_rate;
    fbank_cfg.n_fft = 512;
    fbank_cfg.win_length = 400;
    fbank_cfg.hop_length = info_.hop_length;
    fbank_cfg.n_mels = info_.feature_dim;
    fbank_ = std::make_unique<SortformerFbank>(fbank_cfg);

    // Configure Post Processor
    SortformerPostProcessorConfig pp_cfg;
    pp_cfg.onset = config_.onset;
    pp_cfg.offset = config_.offset;
    pp_cfg.pad_onset = config_.pad_onset;
    pp_cfg.pad_offset = config_.pad_offset;
    pp_cfg.min_duration_on = config_.min_duration_on;
    pp_cfg.min_duration_off = config_.min_duration_off;
    pp_cfg.median_window = config_.median_window;
    pp_cfg.sample_rate = info_.sample_rate;
    pp_cfg.max_speakers = info_.max_speakers;
    pp_cfg.frame_duration = 0.08f;
    post_processor_ = std::make_unique<SortformerPostProcessor>(pp_cfg);

    Reset();
    return Status::Ok();
  } catch (const std::exception& e) {
    return Status::Fail(kErrModelLoad, std::string("Failed to initialize Sortformer model: ") + e.what());
  }
}

void SortformerStreamingModel::UpdateSilenceProfile(const float* embs,
                                                    const float* preds,
                                                    int32_t num_frames) {
  if (num_frames <= 0 || embs == nullptr || preds == nullptr) return;

  const int32_t num_spk = info_.max_speakers;
  const int32_t emb_dim = info_.embedding_dim;

  if (mean_sil_emb_.size() != static_cast<size_t>(emb_dim)) {
    mean_sil_emb_.assign(static_cast<size_t>(emb_dim), 0.0f);
    n_sil_frames_ = 0;
  }

  for (int32_t t = 0; t < num_frames; ++t) {
    float sum = 0.0f;
    for (int32_t s = 0; s < num_spk; ++s) {
      sum += preds[static_cast<size_t>(t * num_spk + s)];
    }

    if (sum < kSilThreshold) {
      const float* emb = embs + static_cast<size_t>(t * emb_dim);
      float old_weight = static_cast<float>(n_sil_frames_);
      n_sil_frames_++;
      float new_weight = static_cast<float>(n_sil_frames_);

      for (int32_t d = 0; d < emb_dim; ++d) {
        mean_sil_emb_[static_cast<size_t>(d)] =
            (mean_sil_emb_[static_cast<size_t>(d)] * old_weight + emb[d]) / new_weight;
      }
    }
  }
}

void SortformerStreamingModel::CompressSpkCache() {
  const int32_t n_frames = spkcache_len_curr_;
  const int32_t num_spk = info_.max_speakers;
  const int32_t emb_dim = info_.embedding_dim;
  const int32_t spkcache_len = info_.spkcache_len;

  if (n_frames <= spkcache_len) return;

  const int32_t per_spk = spkcache_len / num_spk;
  if (per_spk <= kSpkCacheSilFramesPerSpk) {
    // Truncate if cache too small for compression
    spkcache_len_curr_ = spkcache_len;
    spkcache_.resize(static_cast<size_t>(spkcache_len * emb_dim));
    spkcache_preds_.resize(static_cast<size_t>(spkcache_len * num_spk));
    return;
  }

  const int32_t spkcache_len_per_spk = per_spk - kSpkCacheSilFramesPerSpk;
  const int32_t strong_boost_per_spk =
      static_cast<int32_t>(static_cast<float>(spkcache_len_per_spk) * kStrongBoostRate);
  const int32_t weak_boost_per_spk =
      static_cast<int32_t>(static_cast<float>(spkcache_len_per_spk) * kWeakBoostRate);
  const int32_t min_pos_scores_per_spk =
      static_cast<int32_t>(static_cast<float>(spkcache_len_per_spk) * kMinPosScoresRate);

  // 1. Log pred scores
  std::vector<float> scores(static_cast<size_t>(n_frames * num_spk), 0.0f);
  for (int32_t t = 0; t < n_frames; ++t) {
    float log_1_probs_sum = 0.0f;
    for (int32_t s = 0; s < num_spk; ++s) {
      float p = std::max(spkcache_preds_[static_cast<size_t>(t * num_spk + s)],
                         kPredScoreThreshold);
      float log_1_p = std::log(std::max(1.0f - p, kPredScoreThreshold));
      log_1_probs_sum += log_1_p;
    }

    for (int32_t s = 0; s < num_spk; ++s) {
      float p = std::max(spkcache_preds_[static_cast<size_t>(t * num_spk + s)],
                         kPredScoreThreshold);
      float log_p = std::log(p);
      float log_1_p = std::log(std::max(1.0f - p, kPredScoreThreshold));
      scores[static_cast<size_t>(t * num_spk + s)] =
          log_p - log_1_p + log_1_probs_sum - std::log(0.5f);
    }
  }

  // 2. Disable low scores
  std::vector<int32_t> pos_count(static_cast<size_t>(num_spk), 0);
  for (int32_t t = 0; t < n_frames; ++t) {
    for (int32_t s = 0; s < num_spk; ++s) {
      if (scores[static_cast<size_t>(t * num_spk + s)] > 0.0f) {
        pos_count[static_cast<size_t>(s)]++;
      }
    }
  }

  for (int32_t t = 0; t < n_frames; ++t) {
    for (int32_t s = 0; s < num_spk; ++s) {
      bool is_speech = spkcache_preds_[static_cast<size_t>(t * num_spk + s)] > 0.5f;
      if (!is_speech) {
        scores[static_cast<size_t>(t * num_spk + s)] =
            -std::numeric_limits<float>::infinity();
      } else {
        bool is_pos = scores[static_cast<size_t>(t * num_spk + s)] > 0.0f;
        if (!is_pos && pos_count[static_cast<size_t>(s)] >= min_pos_scores_per_spk) {
          scores[static_cast<size_t>(t * num_spk + s)] =
              -std::numeric_limits<float>::infinity();
        }
      }
    }
  }

  // 3. Boost top-K scores per speaker
  auto boost_topk = [&](int32_t n_boost, float scale_factor) {
    for (int32_t s = 0; s < num_spk; ++s) {
      std::vector<std::pair<int32_t, float>> col;
      col.reserve(static_cast<size_t>(n_frames));
      for (int32_t t = 0; t < n_frames; ++t) {
        col.push_back({t, scores[static_cast<size_t>(t * num_spk + s)]});
      }
      std::sort(col.begin(), col.end(),
                [](const auto& a, const auto& b) { return a.second > b.second; });

      int32_t take = std::min<int32_t>(n_boost, static_cast<int32_t>(col.size()));
      for (int32_t i = 0; i < take; ++i) {
        int32_t t = col[static_cast<size_t>(i)].first;
        if (scores[static_cast<size_t>(t * num_spk + s)] !=
            -std::numeric_limits<float>::infinity()) {
          scores[static_cast<size_t>(t * num_spk + s)] -= scale_factor * std::log(0.5f);
        }
      }
    }
  };

  boost_topk(strong_boost_per_spk, 2.0f);
  boost_topk(weak_boost_per_spk, 1.0f);

  // 4. Add silence placeholder frames
  const int32_t total_score_frames = n_frames + kSpkCacheSilFramesPerSpk;
  scores.reserve(static_cast<size_t>(total_score_frames * num_spk));
  for (int32_t i = 0; i < kSpkCacheSilFramesPerSpk; ++i) {
    for (int32_t s = 0; s < num_spk; ++s) {
      scores.push_back(std::numeric_limits<float>::infinity());
    }
  }

  // 5. Get top-K indices: flat_idx = s * total_score_frames + t
  std::vector<std::pair<int32_t, float>> flat_scores;
  flat_scores.reserve(static_cast<size_t>(total_score_frames * num_spk));
  for (int32_t s = 0; s < num_spk; ++s) {
    for (int32_t t = 0; t < total_score_frames; ++t) {
      int32_t flat_idx = s * total_score_frames + t;
      flat_scores.push_back({flat_idx, scores[static_cast<size_t>(t * num_spk + s)]});
    }
  }
  std::sort(flat_scores.begin(), flat_scores.end(),
            [](const auto& a, const auto& b) { return a.second > b.second; });

  std::vector<int32_t> topk_flat;
  topk_flat.reserve(static_cast<size_t>(spkcache_len));
  for (int32_t i = 0;
       i < spkcache_len && i < static_cast<int32_t>(flat_scores.size()); ++i) {
    if (flat_scores[static_cast<size_t>(i)].second ==
        -std::numeric_limits<float>::infinity()) {
      topk_flat.push_back(kMaxIndex);
    } else {
      topk_flat.push_back(flat_scores[static_cast<size_t>(i)].first);
    }
  }
  while (topk_flat.size() < static_cast<size_t>(spkcache_len)) {
    topk_flat.push_back(kMaxIndex);
  }
  std::sort(topk_flat.begin(), topk_flat.end());

  // 6. Gather selected frames
  std::vector<float> new_embs(static_cast<size_t>(spkcache_len * emb_dim), 0.0f);
  std::vector<float> new_preds(static_cast<size_t>(spkcache_len * num_spk), 0.0f);

  for (int32_t i = 0; i < spkcache_len; ++i) {
    int32_t flat_idx = topk_flat[static_cast<size_t>(i)];
    bool is_disabled = false;
    int32_t frame_idx = 0;

    if (flat_idx == kMaxIndex) {
      is_disabled = true;
    } else {
      frame_idx = flat_idx % total_score_frames;
      if (frame_idx >= n_frames) {
        is_disabled = true;
      }
    }

    if (is_disabled) {
      // Use mean silence embedding
      for (int32_t d = 0; d < emb_dim; ++d) {
        new_embs[static_cast<size_t>(i * emb_dim + d)] =
            mean_sil_emb_[static_cast<size_t>(d)];
      }
      // Predictions stay 0.0f
    } else {
      for (int32_t d = 0; d < emb_dim; ++d) {
        new_embs[static_cast<size_t>(i * emb_dim + d)] =
            spkcache_[static_cast<size_t>(frame_idx * emb_dim + d)];
      }
      for (int32_t s = 0; s < num_spk; ++s) {
        new_preds[static_cast<size_t>(i * num_spk + s)] =
            spkcache_preds_[static_cast<size_t>(frame_idx * num_spk + s)];
      }
    }
  }

  spkcache_ = std::move(new_embs);
  spkcache_preds_ = std::move(new_preds);
  spkcache_len_curr_ = spkcache_len;
}

Status SortformerStreamingModel::StreamingUpdate(const float* chunk_feat,
                                                 int32_t current_len,
                                                 std::vector<float>& out_chunk_preds,
                                                 int32_t& out_chunk_len) {
  if (!IsInitialized()) {
    return Status::Fail(kErrNotInitialized, "Model is not initialized");
  }

  const int32_t num_spk = info_.max_speakers;
  const int32_t emb_dim = info_.embedding_dim;
  const int32_t feat_dim = info_.feature_dim;
  const int32_t subsampling = info_.subsampling;

  try {
    Ort::MemoryInfo& mem = impl_->memory_info;

    // 1. chunk tensor (1, current_len, feat_dim)
    std::array<int64_t, 3> chunk_shape = {1, current_len, feat_dim};
    Ort::Value chunk_val = Ort::Value::CreateTensor<float>(
        mem, const_cast<float*>(chunk_feat),
        static_cast<size_t>(current_len * feat_dim), chunk_shape.data(), 3);

    // 2. chunk_lengths (1,)
    int64_t chunk_len_val_i64 = current_len;
    std::array<int64_t, 1> len_shape = {1};
    Ort::Value chunk_len_val = Ort::Value::CreateTensor<int64_t>(
        mem, &chunk_len_val_i64, 1, len_shape.data(), 1);

    // 3. spkcache tensor (1, spkcache_len_curr_, emb_dim)
    float dummy_zero = 0.0f;
    float* spkcache_ptr = spkcache_len_curr_ > 0 ? spkcache_.data() : &dummy_zero;
    std::array<int64_t, 3> spkcache_shape = {1, spkcache_len_curr_, emb_dim};
    Ort::Value spkcache_val = Ort::Value::CreateTensor<float>(
        mem, spkcache_ptr,
        static_cast<size_t>(spkcache_len_curr_ * emb_dim),
        spkcache_shape.data(), 3);

    // 4. spkcache_lengths (1,)
    int64_t spkcache_len_i64 = spkcache_len_curr_;
    Ort::Value spkcache_len_val = Ort::Value::CreateTensor<int64_t>(
        mem, &spkcache_len_i64, 1, len_shape.data(), 1);

    // 5. fifo tensor (1, fifo_len_curr_, emb_dim)
    float* fifo_ptr = fifo_len_curr_ > 0 ? fifo_.data() : &dummy_zero;
    std::array<int64_t, 3> fifo_shape = {1, fifo_len_curr_, emb_dim};
    Ort::Value fifo_val = Ort::Value::CreateTensor<float>(
        mem, fifo_ptr,
        static_cast<size_t>(fifo_len_curr_ * emb_dim),
        fifo_shape.data(), 3);

    // 6. fifo_lengths (1,)
    int64_t fifo_len_i64 = fifo_len_curr_;
    Ort::Value fifo_len_val = Ort::Value::CreateTensor<int64_t>(
        mem, &fifo_len_i64, 1, len_shape.data(), 1);

    const char* input_names[] = {
      "chunk", "chunk_lengths", "spkcache", "spkcache_lengths", "fifo", "fifo_lengths"
    };
    Ort::Value input_values[] = {
      std::move(chunk_val),
      std::move(chunk_len_val),
      std::move(spkcache_val),
      std::move(spkcache_len_val),
      std::move(fifo_val),
      std::move(fifo_len_val)
    };

    const char* output_names[] = {
      "spkcache_fifo_chunk_preds", "chunk_pre_encode_embs"
    };

    auto outputs = impl_->session->Run(
        Ort::RunOptions{nullptr}, input_names, input_values, 6, output_names, 2);

    float* preds_data = outputs[0].GetTensorMutableData<float>();
    float* embs_data = outputs[1].GetTensorMutableData<float>();

    // Calculate valid frames
    const int32_t valid_frames = (current_len + subsampling - 1) / subsampling;
    const int32_t keep = std::min(info_.chunk_len, valid_frames);

    const int32_t old_spkcache_len = spkcache_len_curr_;
    const int32_t old_fifo_len = fifo_len_curr_;

    // Extract chunk predictions: frames [old_spkcache_len + old_fifo_len .. + keep]
    const float* chunk_preds_src =
        preds_data + static_cast<size_t>((old_spkcache_len + old_fifo_len) * num_spk);
    out_chunk_preds.assign(chunk_preds_src,
                           chunk_preds_src + static_cast<size_t>(keep * num_spk));
    out_chunk_len = keep;

    // Extract chunk embeddings: frames [0 .. keep]
    std::vector<float> chunk_embs(embs_data,
                                  embs_data + static_cast<size_t>(keep * emb_dim));

    // Append chunk embeddings to FIFO
    fifo_.insert(fifo_.end(), chunk_embs.begin(), chunk_embs.end());
    fifo_len_curr_ += keep;

    // Update FIFO predictions
    if (old_fifo_len > 0) {
      const float* updated_fifo_preds_src =
          preds_data + static_cast<size_t>(old_spkcache_len * num_spk);
      fifo_preds_.assign(updated_fifo_preds_src,
                         updated_fifo_preds_src + static_cast<size_t>(old_fifo_len * num_spk));
      fifo_preds_.insert(fifo_preds_.end(), out_chunk_preds.begin(),
                         out_chunk_preds.end());
    } else {
      fifo_preds_ = out_chunk_preds;
    }

    // Check FIFO overflow
    if (fifo_len_curr_ > info_.fifo_len) {
      int32_t pop_out_len = info_.chunk_len;
      pop_out_len = std::max(pop_out_len,
                             std::max(0, valid_frames - info_.fifo_len) + old_fifo_len);
      pop_out_len = std::min(pop_out_len, fifo_len_curr_);

      // Extract popped embeddings and predictions
      std::vector<float> pop_embs(
          fifo_.begin(), fifo_.begin() + static_cast<size_t>(pop_out_len * emb_dim));
      std::vector<float> pop_preds(
          fifo_preds_.begin(),
          fifo_preds_.begin() + static_cast<size_t>(pop_out_len * num_spk));

      // Update silence profile
      UpdateSilenceProfile(pop_embs.data(), pop_preds.data(), pop_out_len);

      // Remove popped frames from FIFO
      fifo_.erase(fifo_.begin(),
                  fifo_.begin() + static_cast<size_t>(pop_out_len * emb_dim));
      fifo_preds_.erase(
          fifo_preds_.begin(),
          fifo_preds_.begin() + static_cast<size_t>(pop_out_len * num_spk));
      fifo_len_curr_ -= pop_out_len;

      // Append popped frames to spkcache
      spkcache_.insert(spkcache_.end(), pop_embs.begin(), pop_embs.end());
      spkcache_preds_.insert(spkcache_preds_.end(), pop_preds.begin(),
                             pop_preds.end());
      spkcache_len_curr_ += pop_out_len;

      // Check spkcache overflow
      if (spkcache_len_curr_ > info_.spkcache_len) {
        CompressSpkCache();
      }
    }

    return Status::Ok();
  } catch (const std::exception& e) {
    return Status::Fail(kErrInference,
                        std::string("Sortformer inference error: ") + e.what());
  }
}

Status SortformerStreamingModel::ProcessWindow(
    const float* window, size_t num_samples, int64_t sample_offset,
    std::vector<DiarizationSegment>& out_segments) {
  if (!IsInitialized()) {
    return Status::Fail(kErrNotInitialized, "Model is not initialized");
  }

  const int32_t feed_size =
      (info_.chunk_len + info_.right_context) * info_.subsampling; // 1000 mel frames

  std::vector<float> mel_feat;
  int32_t total_mel_frames = 0;
  fbank_->ComputeMel(window, num_samples, mel_feat, total_mel_frames);

  if (total_mel_frames < feed_size) {
    return Status::Fail(kErrInvalidArgument,
                        "Input window yielded fewer mel frames than feed_size");
  }

  // Sliced to feed_size
  const float* chunk_feat = mel_feat.data();
  const int32_t current_len = feed_size;

  std::vector<float> chunk_preds;
  int32_t chunk_len = 0;
  Status st = StreamingUpdate(chunk_feat, current_len, chunk_preds, chunk_len);
  if (!st.ok) {
    return st;
  }

  // Post process (median filter + binarize)
  const int64_t max_sample_bound = sample_offset + info_.StrideSamples();
  post_processor_->Process(chunk_preds.data(), chunk_len, info_.max_speakers,
                           sample_offset, max_sample_bound, out_segments);

  return Status::Ok();
}

Status SortformerStreamingModel::Flush(
    const float* remaining, size_t num_samples, int64_t sample_offset,
    std::vector<DiarizationSegment>& out_segments) {
  if (!IsInitialized()) {
    return Status::Fail(kErrNotInitialized, "Model is not initialized");
  }

  if (num_samples == 0 || remaining == nullptr) {
    return Status::Ok();
  }

  const size_t feed_samples = static_cast<size_t>(info_.FeedSamples());
  std::vector<float> padded_audio(feed_samples, 0.0f);
  size_t copy_samples = std::min(num_samples, feed_samples);
  std::copy(remaining, remaining + copy_samples, padded_audio.begin());

  const int32_t feed_size =
      (info_.chunk_len + info_.right_context) * info_.subsampling;

  std::vector<float> mel_feat;
  int32_t total_mel_frames = 0;
  fbank_->ComputeMel(padded_audio.data(), feed_samples, mel_feat, total_mel_frames);

  const float* chunk_feat = mel_feat.data();
  const int32_t current_len = feed_size;

  std::vector<float> chunk_preds;
  int32_t chunk_len = 0;
  Status st = StreamingUpdate(chunk_feat, current_len, chunk_preds, chunk_len);
  if (!st.ok) {
    return st;
  }

  const int64_t max_sample_bound = sample_offset + static_cast<int64_t>(num_samples);
  post_processor_->Process(chunk_preds.data(), chunk_len, info_.max_speakers,
                           sample_offset, max_sample_bound, out_segments);

  return Status::Ok();
}

} // namespace sherpaonnx::diarization
