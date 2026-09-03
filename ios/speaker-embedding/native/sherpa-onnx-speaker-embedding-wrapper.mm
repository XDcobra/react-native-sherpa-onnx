#include "sherpa-onnx-speaker-embedding-wrapper.h"

#include "sherpa-onnx-validate-speaker-embedding.h"

#include <stdexcept>

#include "sherpa-onnx/c-api/cxx-api.h"

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
    const std::string &modelType) {
  if (modelType == "wespeaker") return SpeakerEmbeddingModelKind::kWespeaker;
  if (modelType == "3d-speaker") return SpeakerEmbeddingModelKind::k3dSpeaker;
  if (modelType == "nemo") return SpeakerEmbeddingModelKind::kNemo;
  return SpeakerEmbeddingModelKind::kUnknown;
}

sherpa_onnx::cxx::SpeakerEmbeddingExtractorConfig BuildExtractorConfig(
    const std::string &modelPath,
    int32_t numThreads,
    const std::optional<std::string> &provider,
    bool debug) {
  sherpa_onnx::cxx::SpeakerEmbeddingExtractorConfig config;
  config.model = modelPath;
  config.num_threads = numThreads;
  config.debug = debug;
  if (provider.has_value() && !provider->empty()) {
    config.provider = *provider;
  }
  return config;
}

}  // namespace

class SpeakerEmbeddingExtractorWrapper::Impl {
 public:
  bool initialized = false;
  int32_t dim = 0;
  std::optional<sherpa_onnx::cxx::SpeakerEmbeddingExtractor> extractor;
};

SpeakerEmbeddingExtractorWrapper::SpeakerEmbeddingExtractorWrapper()
    : pImpl(std::make_unique<Impl>()) {}

SpeakerEmbeddingExtractorWrapper::~SpeakerEmbeddingExtractorWrapper() {
  release();
}

SpeakerEmbeddingInitializeResult SpeakerEmbeddingExtractorWrapper::initialize(
    const std::string &modelDir,
    const std::string &modelType,
    int32_t numThreads,
    const std::optional<std::string> &provider,
    bool debug) {
  SpeakerEmbeddingInitializeResult result;
  if (pImpl->initialized) {
    release();
  }
  if (modelDir.empty()) {
    result.error = "Speaker embedding model directory is empty";
    return result;
  }

  auto detect = DetectSpeakerEmbeddingModel(
      std::optional<std::string>(modelDir),
      std::nullopt,
      modelType);
  result.detectedModels = detect.detectedModels;
  result.modelType = SpeakerEmbeddingKindToString(detect.selectedKind);
  if (!detect.ok) {
    result.error = detect.error;
    return result;
  }
  if (detect.paths.model.empty()) {
    result.error = "Speaker embedding detect did not return paths.model";
    return result;
  }

  auto config =
      BuildExtractorConfig(detect.paths.model, numThreads, provider, debug);
  pImpl->extractor =
      sherpa_onnx::cxx::SpeakerEmbeddingExtractor::Create(config);
  pImpl->dim = pImpl->extractor->Dim();
  if (pImpl->dim <= 0) {
    pImpl->extractor.reset();
    result.error = "Speaker embedding extractor returned invalid dim";
    return result;
  }
  pImpl->initialized = true;
  result.success = true;
  result.dim = pImpl->dim;
  return result;
}

SpeakerEmbeddingInitializeResult
SpeakerEmbeddingExtractorWrapper::initializeCustom(
    const std::string &modelType,
    const SpeakerEmbeddingModelPaths &paths,
    int32_t numThreads,
    const std::optional<std::string> &provider,
    bool debug) {
  SpeakerEmbeddingInitializeResult result;
  if (pImpl->initialized) {
    release();
  }

  const SpeakerEmbeddingModelKind selectedKind =
      ParseSpeakerEmbeddingModelTypeFromString(modelType);
  if (selectedKind == SpeakerEmbeddingModelKind::kUnknown) {
    result.error = "Unsupported custom speaker embedding model type";
    return result;
  }

  auto validation = ValidateSpeakerEmbeddingPaths(selectedKind, paths, "custom");
  if (!validation.ok) {
    result.error = validation.error;
    return result;
  }

  result.modelType = SpeakerEmbeddingKindToString(selectedKind);
  result.detectedModels.push_back({result.modelType, "custom"});

  auto config = BuildExtractorConfig(paths.model, numThreads, provider, debug);
  pImpl->extractor =
      sherpa_onnx::cxx::SpeakerEmbeddingExtractor::Create(config);
  pImpl->dim = pImpl->extractor->Dim();
  if (pImpl->dim <= 0) {
    pImpl->extractor.reset();
    result.error = "Speaker embedding extractor returned invalid dim";
    return result;
  }
  pImpl->initialized = true;
  result.success = true;
  result.dim = pImpl->dim;
  return result;
}

std::vector<float> SpeakerEmbeddingExtractorWrapper::computeFromSamples(
    const std::vector<float> &samples,
    int32_t sampleRate) {
  if (!pImpl->initialized || !pImpl->extractor.has_value()) {
    throw std::runtime_error("Speaker embedding extractor is not initialized");
  }
  if (samples.empty() || sampleRate <= 0) {
    throw std::runtime_error("Speaker embedding input samples are empty");
  }

  auto stream = pImpl->extractor->CreateStream();
  stream.AcceptWaveform(sampleRate, samples.data(),
                        static_cast<int32_t>(samples.size()));
  stream.InputFinished();
  if (!pImpl->extractor->IsReady(&stream)) {
    throw std::runtime_error("Speaker embedding extractor is not ready");
  }
  return pImpl->extractor->ComputeEmbedding(&stream);
}

int32_t SpeakerEmbeddingExtractorWrapper::dim() const { return pImpl->dim; }

bool SpeakerEmbeddingExtractorWrapper::isInitialized() const {
  return pImpl->initialized;
}

void SpeakerEmbeddingExtractorWrapper::release() {
  pImpl->extractor.reset();
  pImpl->dim = 0;
  pImpl->initialized = false;
}

class SpeakerEmbeddingManagerWrapper::Impl {
 public:
  bool initialized = false;
  int32_t dim = 0;
  std::optional<sherpa_onnx::cxx::SpeakerEmbeddingManager> manager;
};

SpeakerEmbeddingManagerWrapper::SpeakerEmbeddingManagerWrapper()
    : pImpl(std::make_unique<Impl>()) {}

SpeakerEmbeddingManagerWrapper::~SpeakerEmbeddingManagerWrapper() { release(); }

bool SpeakerEmbeddingManagerWrapper::create(int32_t dim) {
  if (dim <= 0) return false;
  release();
  pImpl->manager = sherpa_onnx::cxx::SpeakerEmbeddingManager::Create(dim);
  pImpl->dim = dim;
  pImpl->initialized = true;
  return true;
}

bool SpeakerEmbeddingManagerWrapper::add(
    const std::string &name,
    const std::vector<float> &flattened,
    int32_t count) {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return false;
  if (count <= 0 || name.empty()) return false;
  const size_t expected =
      static_cast<size_t>(count) * static_cast<size_t>(pImpl->dim);
  if (flattened.size() != expected) return false;
  if (count == 1) {
    return pImpl->manager->Add(name, flattened.data());
  }
  return pImpl->manager->AddListFlattened(name, flattened.data(), count);
}

bool SpeakerEmbeddingManagerWrapper::remove(const std::string &name) {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return false;
  return pImpl->manager->Remove(name);
}

std::string SpeakerEmbeddingManagerWrapper::search(
    const std::vector<float> &embedding,
    float threshold) {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return "";
  if (static_cast<int32_t>(embedding.size()) != pImpl->dim) return "";
  return pImpl->manager->Search(embedding.data(), threshold);
}

bool SpeakerEmbeddingManagerWrapper::verify(
    const std::string &name,
    const std::vector<float> &embedding,
    float threshold) {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return false;
  if (static_cast<int32_t>(embedding.size()) != pImpl->dim) return false;
  return pImpl->manager->Verify(name, embedding.data(), threshold);
}

bool SpeakerEmbeddingManagerWrapper::contains(const std::string &name) {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return false;
  return pImpl->manager->Contains(name);
}

int32_t SpeakerEmbeddingManagerWrapper::numSpeakers() const {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return 0;
  return pImpl->manager->NumSpeakers();
}

std::vector<std::string> SpeakerEmbeddingManagerWrapper::allSpeakers() const {
  if (!pImpl->initialized || !pImpl->manager.has_value()) return {};
  return pImpl->manager->GetAllSpeakers();
}

int32_t SpeakerEmbeddingManagerWrapper::dim() const { return pImpl->dim; }

bool SpeakerEmbeddingManagerWrapper::isInitialized() const {
  return pImpl->initialized;
}

void SpeakerEmbeddingManagerWrapper::release() {
  pImpl->manager.reset();
  pImpl->dim = 0;
  pImpl->initialized = false;
}

}  // namespace sherpaonnx
