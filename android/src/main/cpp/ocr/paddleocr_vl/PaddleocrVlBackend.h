#pragma once

#include "../OcrBackend.h"
#include "PaddleocrVlManifest.h"
#include "PaddleocrVlTokenizer.h"

#include <memory>
#include <string>
#include <vector>

namespace Ort {
class Session;
class SessionOptions;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

class PaddleocrVlBackend final : public OcrBackend {
 public:
  PaddleocrVlBackend();
  ~PaddleocrVlBackend() override;

  void Load(const std::string& model_dir, const OcrLoadOptions& options) override;
  OcrResult Recognize(const OcrFrameView& frame,
                      const OcrRecognizeContext& ctx = {}) override;
  void Release() override;
  const char* Family() const override { return "paddleocr_vl"; }

 private:
  OcrLoadOptions options_{};
  PaddleocrVlManifest manifest_{};
  PaddleocrVlTokenizer tokenizer_{};
  bool loaded_ = false;

  std::unique_ptr<Ort::SessionOptions> session_options_;
  std::unique_ptr<Ort::Session> vision_session_;
  std::unique_ptr<Ort::Session> embed_session_;
  std::unique_ptr<Ort::Session> decoder_session_;
  std::vector<std::string> decoder_input_names_;
  std::vector<std::string> decoder_output_names_;
};

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
