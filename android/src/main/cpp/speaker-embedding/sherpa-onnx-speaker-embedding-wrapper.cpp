#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include "sherpa-onnx-validate-speaker-embedding.h"

#include <mutex>
#include <utility>

namespace sherpaonnx {
namespace {

std::string SpeakerEmbeddingKindToString(SpeakerEmbeddingModelKind kind) {
  switch (kind) {
    case SpeakerEmbeddingModelKind::kWespeaker:
      return "wespeaker";
    case SpeakerEmbeddingModelKind::k3dSpeaker:
      return "3d-speaker";
    case SpeakerEmbeddingModelKind::kNemo:
      return "nemo";
    default:
      return "unknown";
  }
}

SpeakerEmbeddingModelKind ParseSpeakerEmbeddingModelTypeFromString(
    const std::string& modelType) {
  if (modelType == "wespeaker") return SpeakerEmbeddingModelKind::kWespeaker;
  if (modelType == "3d-speaker") return SpeakerEmbeddingModelKind::k3dSpeaker;
  if (modelType == "nemo") return SpeakerEmbeddingModelKind::kNemo;
  return SpeakerEmbeddingModelKind::kUnknown;
}

}  // namespace

class SpeakerEmbeddingExtractorWrapper::Impl {
 public:
  speaker_embedding::SpeakerEmbeddingRunner runner;
  bool initialized = false;
  int32_t dim = 0;
  std::string last_error;
  std::string last_error_code;

  void ClearError() {
    last_error.clear();
    last_error_code.clear();
  }

  void SetError(const std::string& code, const std::string& message) {
    last_error_code = code;
    last_error = message;
  }
};

SpeakerEmbeddingExtractorWrapper::SpeakerEmbeddingExtractorWrapper()
    : pImpl(std::make_unique<Impl>()) {}

SpeakerEmbeddingExtractorWrapper::~SpeakerEmbeddingExtractorWrapper() {
  release();
}

SpeakerEmbeddingInitializeResult SpeakerEmbeddingExtractorWrapper::initialize(
    const std::string& modelDir, const std::string& modelType,
    int32_t numThreads, const std::optional<std::string>& provider,
    bool debug) {
  SpeakerEmbeddingInitializeResult result;
  if (pImpl->initialized) {
    release();
  }
  pImpl->ClearError();
  if (modelDir.empty()) {
    result.error = "Speaker embedding model directory is empty";
    result.errorCode = speaker_embedding::kErrInvalidArgument;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  auto detect = DetectSpeakerEmbeddingModel(
      std::optional<std::string>(modelDir), std::nullopt, modelType);
  result.detectedModels = detect.detectedModels;
  result.modelType = SpeakerEmbeddingKindToString(detect.selectedKind);
  if (!detect.ok) {
    result.error = detect.error;
    result.errorCode = speaker_embedding::kErrInit;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }
  if (detect.paths.model.empty()) {
    result.error = "Speaker embedding detect did not return paths.model";
    result.errorCode = speaker_embedding::kErrInit;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  speaker_embedding::EmbeddingRunnerOptions opts;
  opts.model_path = detect.paths.model;
  opts.num_threads = numThreads > 0 ? numThreads : 1;
  opts.provider =
      provider.has_value() && !provider->empty() ? *provider : "cpu";
  opts.debug = debug;

  auto st = pImpl->runner.Acquire(opts);
  if (!st.ok) {
    result.error = st.message;
    result.errorCode = st.code.empty() ? speaker_embedding::kErrInit : st.code;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  pImpl->dim = pImpl->runner.dim();
  pImpl->initialized = true;
  result.success = true;
  result.dim = pImpl->dim;
  return result;
}

SpeakerEmbeddingInitializeResult
SpeakerEmbeddingExtractorWrapper::initializeCustom(
    const std::string& modelType, const SpeakerEmbeddingModelPaths& paths,
    int32_t numThreads, const std::optional<std::string>& provider,
    bool debug) {
  SpeakerEmbeddingInitializeResult result;
  if (pImpl->initialized) {
    release();
  }
  pImpl->ClearError();

  const SpeakerEmbeddingModelKind selectedKind =
      ParseSpeakerEmbeddingModelTypeFromString(modelType);
  if (selectedKind == SpeakerEmbeddingModelKind::kUnknown) {
    result.error = "Unsupported custom speaker embedding model type";
    result.errorCode = speaker_embedding::kErrInvalidArgument;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  auto validation =
      ValidateSpeakerEmbeddingPaths(selectedKind, paths, "custom");
  if (!validation.ok) {
    result.error = validation.error;
    result.errorCode = speaker_embedding::kErrInit;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  result.modelType = SpeakerEmbeddingKindToString(selectedKind);
  result.detectedModels.push_back({result.modelType, "custom"});

  speaker_embedding::EmbeddingRunnerOptions opts;
  opts.model_path = paths.model;
  opts.num_threads = numThreads > 0 ? numThreads : 1;
  opts.provider =
      provider.has_value() && !provider->empty() ? *provider : "cpu";
  opts.debug = debug;

  auto st = pImpl->runner.Acquire(opts);
  if (!st.ok) {
    result.error = st.message;
    result.errorCode = st.code.empty() ? speaker_embedding::kErrInit : st.code;
    pImpl->SetError(result.errorCode, result.error);
    return result;
  }

  pImpl->dim = pImpl->runner.dim();
  pImpl->initialized = true;
  result.success = true;
  result.dim = pImpl->dim;
  return result;
}

std::vector<float> SpeakerEmbeddingExtractorWrapper::computeFromSamples(
    const std::vector<float>& samples, int32_t sampleRate) {
  pImpl->ClearError();
  if (!pImpl->initialized || !pImpl->runner.isReady()) {
    pImpl->SetError(speaker_embedding::kErrNotInitialized,
                    "Speaker embedding extractor is not initialized");
    return {};
  }
  if (samples.empty() || sampleRate <= 0) {
    pImpl->SetError(speaker_embedding::kErrInvalidArgument,
                    "Speaker embedding input samples are empty");
    return {};
  }

  std::vector<float> embedding;
  auto st = pImpl->runner.ComputeFull(samples.data(),
                                      static_cast<int32_t>(samples.size()),
                                      sampleRate, &embedding);
  if (!st.ok) {
    pImpl->SetError(st.code.empty() ? speaker_embedding::kErrCompute : st.code,
                    st.message);
    return {};
  }
  return embedding;
}

int32_t SpeakerEmbeddingExtractorWrapper::dim() const { return pImpl->dim; }

bool SpeakerEmbeddingExtractorWrapper::isInitialized() const {
  return pImpl->initialized;
}

std::string SpeakerEmbeddingExtractorWrapper::lastError() const {
  return pImpl->last_error;
}

std::string SpeakerEmbeddingExtractorWrapper::lastErrorCode() const {
  return pImpl->last_error_code;
}

void SpeakerEmbeddingExtractorWrapper::release() {
  pImpl->runner.Release();
  pImpl->dim = 0;
  pImpl->initialized = false;
  pImpl->ClearError();
}

class SpeakerEmbeddingManagerWrapper::Impl {
 public:
  mutable std::mutex mu;
  speaker_embedding::SpeakerEmbeddingManagerCore core;
};

SpeakerEmbeddingManagerWrapper::SpeakerEmbeddingManagerWrapper()
    : pImpl(std::make_unique<Impl>()) {}

SpeakerEmbeddingManagerWrapper::~SpeakerEmbeddingManagerWrapper() { release(); }

bool SpeakerEmbeddingManagerWrapper::create(int32_t dim) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Create(dim).ok;
}

bool SpeakerEmbeddingManagerWrapper::add(const std::string& name,
                                         const std::vector<float>& flattened,
                                         int32_t count) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Add(name, flattened, count).ok;
}

bool SpeakerEmbeddingManagerWrapper::remove(const std::string& name) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Remove(name).ok;
}

std::string SpeakerEmbeddingManagerWrapper::search(
    const std::vector<float>& embedding, float threshold) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Search(embedding, threshold);
}

bool SpeakerEmbeddingManagerWrapper::verify(
    const std::string& name, const std::vector<float>& embedding,
    float threshold) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Verify(name, embedding, threshold);
}

bool SpeakerEmbeddingManagerWrapper::contains(const std::string& name) {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.Contains(name);
}

int32_t SpeakerEmbeddingManagerWrapper::numSpeakers() const {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.NumSpeakers();
}

std::vector<std::string> SpeakerEmbeddingManagerWrapper::allSpeakers() const {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.AllSpeakers();
}

int32_t SpeakerEmbeddingManagerWrapper::dim() const {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.dim();
}

bool SpeakerEmbeddingManagerWrapper::isInitialized() const {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  return pImpl->core.isReady();
}

void SpeakerEmbeddingManagerWrapper::release() {
  std::lock_guard<std::mutex> lock(pImpl->mu);
  pImpl->core.Release();
}

}  // namespace sherpaonnx
