#pragma once

#include "OcrBackend.h"
#include "OcrTypes.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

/**
 * Lifecycle + multi-frame orchestration over an OcrBackend.
 * Image pixels come from ImageRegistry (zero-copy GetFrameRgbPtr).
 */
class OcrEngine {
 public:
  using ProgressFn =
      std::function<void(int done, int total, const std::string& phase)>;
  using CancelFn = std::function<bool()>;

  struct RecognizeOptions {
    /** Empty → all frames in the image buffer. */
    std::vector<int> frame_indices;
    OcrGranularity granularity = OcrGranularity::kLine;
    ProgressFn progress;
    CancelFn cancel;
  };

  struct RecognizeOutcome {
    bool ok = false;
    bool cancelled = false;
    OcrResult result;
    std::string errorCode;
    std::string errorMessage;
    std::string family;
  };

  void Load(const std::string& model_type, const std::string& model_dir,
            const OcrLoadOptions& options);
  RecognizeOutcome RecognizeMulti(const std::string& image_buffer_id,
                                  const RecognizeOptions& options);
  void Release();
  bool IsLoaded() const { return backend_ != nullptr; }
  const char* Family() const;

 private:
  std::unique_ptr<OcrBackend> backend_;
  OcrLoadOptions options_{};
  mutable std::mutex mutex_;
};

/** Process-wide engine instances keyed by JS/native instanceId. */
class OcrEngineRegistry {
 public:
  static OcrEngineRegistry& Instance();

  OcrEngine& Create(const std::string& instance_id);
  OcrEngine* Get(const std::string& instance_id);
  bool Destroy(const std::string& instance_id);

 private:
  std::mutex mutex_;
  std::unordered_map<std::string, std::unique_ptr<OcrEngine>> engines_;
};

/** Cancel flags for in-flight recognize operations (operationId). */
class OcrCancelRegistry {
 public:
  static OcrCancelRegistry& Instance();

  void Begin(const std::string& operation_id);
  void RequestCancel(const std::string& operation_id);
  bool IsCancelled(const std::string& operation_id) const;
  void End(const std::string& operation_id);

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> flags_;
};

}  // namespace ocr
}  // namespace sherpa_onnx
