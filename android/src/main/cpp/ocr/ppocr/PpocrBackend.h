#pragma once

#include "../OcrBackend.h"

#include <memory>
#include <string>
#include <vector>

namespace Ort {
class Session;
class SessionOptions;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {

class PpocrBackend final : public OcrBackend {
 public:
  PpocrBackend();
  ~PpocrBackend() override;

  void Load(const std::string& model_dir, const OcrLoadOptions& options) override;
  OcrResult Recognize(const OcrFrameView& frame,
                      const OcrRecognizeContext& ctx = {}) override;
  void Release() override;
  const char* Family() const override { return "ppocr"; }

 private:
  OcrLoadOptions options_{};
  std::vector<std::string> dict_;
  bool loaded_ = false;
  bool has_cls_ = false;

  std::unique_ptr<Ort::SessionOptions> session_options_;
  std::unique_ptr<Ort::Session> det_session_;
  std::unique_ptr<Ort::Session> rec_session_;
  std::unique_ptr<Ort::Session> cls_session_;

  std::string det_input_name_;
  std::string det_output_name_;
  std::string rec_input_name_;
  std::string rec_output_name_;
  std::string cls_input_name_;
  std::string cls_output_name_;
};

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
