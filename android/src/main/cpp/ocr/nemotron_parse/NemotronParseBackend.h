#pragma once

#include "../OcrBackend.h"
#include "NemotronParseManifest.h"
#include "NemotronParseTokenizer.h"

#include <memory>
#include <string>
#include <vector>

namespace Ort {
class Session;
class SessionOptions;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

class NemotronParseBackend final : public OcrBackend {
 public:
  NemotronParseBackend();
  ~NemotronParseBackend() override;

  void Load(const std::string& model_dir, const OcrLoadOptions& options) override;
  OcrResult Recognize(const OcrFrameView& frame,
                      const OcrRecognizeContext& ctx = {}) override;
  void Release() override;
  const char* Family() const override { return "nemotron_parse"; }

 private:
  OcrLoadOptions options_{};
  NemotronParseManifest manifest_{};
  NemotronParseTokenizer tokenizer_{};
  std::vector<float> pos_embed_;
  bool loaded_ = false;

  std::unique_ptr<Ort::SessionOptions> session_options_;
  std::unique_ptr<Ort::Session> patch_session_;
  std::unique_ptr<Ort::Session> vision_session_;
  std::unique_ptr<Ort::Session> embed_session_;
  std::unique_ptr<Ort::Session> decoder_session_;
  std::vector<std::string> decoder_input_names_;
  std::vector<std::string> decoder_output_names_;
};

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
