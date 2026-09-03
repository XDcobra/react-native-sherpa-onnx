#include "speaker-embedding-runner.h"

#include "sherpa-onnx/c-api/c-api.h"

#include <cmath>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <utility>

namespace sherpaonnx::diarization {
namespace {

struct RegistryKey {
  std::string model_path;
  std::string provider;
  int32_t num_threads = 1;

  bool operator==(const RegistryKey& o) const {
    return num_threads == o.num_threads && model_path == o.model_path &&
           provider == o.provider;
  }
};

struct RegistryKeyHash {
  size_t operator()(const RegistryKey& k) const {
    size_t h = std::hash<std::string>{}(k.model_path);
    h ^= std::hash<std::string>{}(k.provider) + 0x9e3779b9 + (h << 6) +
         (h >> 2);
    h ^= std::hash<int32_t>{}(k.num_threads) + 0x9e3779b9 + (h << 6) +
         (h >> 2);
    return h;
  }
};

struct SharedExtractor {
  RegistryKey key;
  const SherpaOnnxSpeakerEmbeddingExtractor* extractor = nullptr;
  int32_t dim = 0;

  ~SharedExtractor() {
    if (extractor != nullptr) {
      SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor);
      extractor = nullptr;
    }
  }
};

std::mutex g_registry_mutex;
std::unordered_map<RegistryKey, std::weak_ptr<SharedExtractor>, RegistryKeyHash>
    g_registry;

bool EmbeddingHasNaN(const std::vector<float>& v) {
  for (float f : v) {
    if (std::isnan(f)) {
      return true;
    }
  }
  return false;
}

}  // namespace

class SpeakerEmbeddingRunner::Impl {
 public:
  std::shared_ptr<SharedExtractor> shared;
};

SpeakerEmbeddingRunner::SpeakerEmbeddingRunner()
    : impl_(std::make_unique<Impl>()) {}

SpeakerEmbeddingRunner::~SpeakerEmbeddingRunner() { Release(); }

void SpeakerEmbeddingRunner::Release() {
  if (impl_) {
    impl_->shared.reset();
  }
}

bool SpeakerEmbeddingRunner::isReady() const {
  return impl_ && impl_->shared && impl_->shared->extractor != nullptr;
}

int32_t SpeakerEmbeddingRunner::dim() const {
  return isReady() ? impl_->shared->dim : 0;
}

Status SpeakerEmbeddingRunner::Acquire(const EmbeddingRunnerOptions& options) {
  Release();
  if (options.model_path.empty()) {
    return Status::Fail(kErrInvalidArgument, "embedding model path is empty");
  }

  RegistryKey key;
  key.model_path = options.model_path;
  key.provider = options.provider.empty() ? "cpu" : options.provider;
  key.num_threads = std::max(1, options.num_threads);

  std::lock_guard<std::mutex> lock(g_registry_mutex);
  auto it = g_registry.find(key);
  if (it != g_registry.end()) {
    if (auto existing = it->second.lock()) {
      impl_->shared = std::move(existing);
      return Status::Ok();
    }
    g_registry.erase(it);
  }

  SherpaOnnxSpeakerEmbeddingExtractorConfig config;
  std::memset(&config, 0, sizeof(config));
  config.model = key.model_path.c_str();
  config.num_threads = key.num_threads;
  config.debug = options.debug ? 1 : 0;
  config.provider = key.provider.c_str();

  const SherpaOnnxSpeakerEmbeddingExtractor* extractor =
      SherpaOnnxCreateSpeakerEmbeddingExtractor(&config);
  if (extractor == nullptr) {
    return Status::Fail(kErrEmbedding,
                        "SherpaOnnxCreateSpeakerEmbeddingExtractor failed");
  }

  auto created = std::make_shared<SharedExtractor>();
  created->key = key;
  created->extractor = extractor;
  created->dim = SherpaOnnxSpeakerEmbeddingExtractorDim(extractor);
  if (created->dim <= 0) {
    return Status::Fail(kErrEmbedding, "embedding dim is invalid");
  }

  g_registry[key] = created;
  impl_->shared = std::move(created);
  return Status::Ok();
}

Status SpeakerEmbeddingRunner::Compute(
    const float* audio, int32_t num_samples, int32_t sample_rate,
    const std::vector<SampleRange>& ranges,
    std::vector<float>* out_embedding) const {
  if (!isReady()) {
    return Status::Fail(kErrNotInitialized, "embedding runner not acquired");
  }
  if (audio == nullptr || out_embedding == nullptr || sample_rate <= 0) {
    return Status::Fail(kErrInvalidArgument, "invalid embedding compute args");
  }

  const auto* extractor = impl_->shared->extractor;
  const int32_t dim = impl_->shared->dim;

  const SherpaOnnxOnlineStream* stream =
      SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor);
  if (stream == nullptr) {
    return Status::Fail(kErrEmbedding, "failed to create embedding stream");
  }

  for (const auto& range : ranges) {
    int32_t end = range.end <= num_samples ? range.end : num_samples;
    int32_t start = range.start;
    if (start < 0) {
      start = 0;
    }
    const int32_t n = end - start;
    if (n > 0) {
      SherpaOnnxOnlineStreamAcceptWaveform(stream, sample_rate, audio + start,
                                           n);
    }
  }
  SherpaOnnxOnlineStreamInputFinished(stream);

  if (!SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream)) {
    SherpaOnnxDestroyOnlineStream(stream);
    return Status::Fail(kErrEmbedding, "embedding segment too short");
  }

  const float* emb =
      SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream);
  if (emb == nullptr) {
    SherpaOnnxDestroyOnlineStream(stream);
    return Status::Fail(kErrEmbedding, "ComputeEmbedding returned null");
  }

  out_embedding->assign(emb, emb + dim);
  SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(emb);
  SherpaOnnxDestroyOnlineStream(stream);

  if (EmbeddingHasNaN(*out_embedding)) {
    out_embedding->clear();
    return Status::Fail(kErrEmbedding, "embedding contains NaN");
  }
  return Status::Ok();
}

}  // namespace sherpaonnx::diarization
