#include "speaker-embedding-manager.h"

#include "sherpa-onnx/c-api/c-api.h"

namespace sherpaonnx::speaker_embedding {

class SpeakerEmbeddingManagerCore::Impl {
 public:
  const SherpaOnnxSpeakerEmbeddingManager* manager = nullptr;
  int32_t dim = 0;

  ~Impl() { Destroy(); }

  void Destroy() {
    if (manager != nullptr) {
      SherpaOnnxDestroySpeakerEmbeddingManager(manager);
      manager = nullptr;
    }
    dim = 0;
  }
};

SpeakerEmbeddingManagerCore::SpeakerEmbeddingManagerCore()
    : impl_(std::make_unique<Impl>()) {}

SpeakerEmbeddingManagerCore::~SpeakerEmbeddingManagerCore() { Release(); }

void SpeakerEmbeddingManagerCore::Release() {
  if (impl_) {
    impl_->Destroy();
  }
}

bool SpeakerEmbeddingManagerCore::isReady() const {
  return impl_ && impl_->manager != nullptr;
}

int32_t SpeakerEmbeddingManagerCore::dim() const {
  return isReady() ? impl_->dim : 0;
}

Status SpeakerEmbeddingManagerCore::Create(int32_t dim) {
  Release();
  if (dim <= 0) {
    return Status::Fail(kErrInvalidArgument, "manager dim must be > 0");
  }
  const SherpaOnnxSpeakerEmbeddingManager* manager =
      SherpaOnnxCreateSpeakerEmbeddingManager(dim);
  if (manager == nullptr) {
    return Status::Fail(kErrManager,
                        "SherpaOnnxCreateSpeakerEmbeddingManager failed");
  }
  impl_->manager = manager;
  impl_->dim = dim;
  return Status::Ok();
}

Status SpeakerEmbeddingManagerCore::Add(const std::string& name,
                                        const std::vector<float>& flattened,
                                        int32_t count) {
  if (!isReady()) {
    return Status::Fail(kErrNotInitialized, "manager not created");
  }
  if (name.empty() || count <= 0) {
    return Status::Fail(kErrInvalidArgument, "invalid add args");
  }
  const size_t expected =
      static_cast<size_t>(count) * static_cast<size_t>(impl_->dim);
  if (flattened.size() != expected) {
    return Status::Fail(kErrInvalidArgument, "embeddings length mismatch");
  }
  int32_t ok = 0;
  if (count == 1) {
    ok = SherpaOnnxSpeakerEmbeddingManagerAdd(impl_->manager, name.c_str(),
                                              flattened.data());
  } else {
    ok = SherpaOnnxSpeakerEmbeddingManagerAddListFlattened(
        impl_->manager, name.c_str(), flattened.data(), count);
  }
  if (!ok) {
    return Status::Fail(kErrManager, "manager add failed");
  }
  return Status::Ok();
}

Status SpeakerEmbeddingManagerCore::Remove(const std::string& name) {
  if (!isReady()) {
    return Status::Fail(kErrNotInitialized, "manager not created");
  }
  if (name.empty()) {
    return Status::Fail(kErrInvalidArgument, "name is empty");
  }
  if (!SherpaOnnxSpeakerEmbeddingManagerRemove(impl_->manager, name.c_str())) {
    return Status::Fail(kErrManager, "manager remove failed");
  }
  return Status::Ok();
}

std::string SpeakerEmbeddingManagerCore::Search(
    const std::vector<float>& embedding, float threshold) const {
  if (!isReady()) {
    return {};
  }
  if (static_cast<int32_t>(embedding.size()) != impl_->dim) {
    return {};
  }
  const char* name = SherpaOnnxSpeakerEmbeddingManagerSearch(
      impl_->manager, embedding.data(), threshold);
  if (name == nullptr) {
    return {};
  }
  std::string out(name);
  SherpaOnnxSpeakerEmbeddingManagerFreeSearch(name);
  return out;
}

bool SpeakerEmbeddingManagerCore::Verify(const std::string& name,
                                         const std::vector<float>& embedding,
                                         float threshold) const {
  if (!isReady() || name.empty()) {
    return false;
  }
  if (static_cast<int32_t>(embedding.size()) != impl_->dim) {
    return false;
  }
  return SherpaOnnxSpeakerEmbeddingManagerVerify(
             impl_->manager, name.c_str(), embedding.data(), threshold) != 0;
}

bool SpeakerEmbeddingManagerCore::Contains(const std::string& name) const {
  if (!isReady() || name.empty()) {
    return false;
  }
  return SherpaOnnxSpeakerEmbeddingManagerContains(impl_->manager,
                                                   name.c_str()) != 0;
}

int32_t SpeakerEmbeddingManagerCore::NumSpeakers() const {
  if (!isReady()) {
    return 0;
  }
  return SherpaOnnxSpeakerEmbeddingManagerNumSpeakers(impl_->manager);
}

std::vector<std::string> SpeakerEmbeddingManagerCore::AllSpeakers() const {
  std::vector<std::string> out;
  if (!isReady()) {
    return out;
  }
  const char* const* names =
      SherpaOnnxSpeakerEmbeddingManagerGetAllSpeakers(impl_->manager);
  if (names == nullptr) {
    return out;
  }
  for (int32_t i = 0; names[i] != nullptr; ++i) {
    out.emplace_back(names[i]);
  }
  SherpaOnnxSpeakerEmbeddingManagerFreeAllSpeakers(names);
  return out;
}

}  // namespace sherpaonnx::speaker_embedding
