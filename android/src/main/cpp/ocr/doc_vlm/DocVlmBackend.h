/**
 * OcrBackend for granite-docling ONNX packs (vision encoder + embed + decoder).
 *
 * Recognize is not thread-safe. KV cache lives only inside one Recognize call.
 * CreateOcrBackend does not construct this type; host tests do.
 */
#pragma once

#include "../OcrBackend.h"
#include "DocVlmManifest.h"
#include "DocVlmTokenizer.h"

#include <memory>
#include <string>
#include <vector>

namespace Ort {
class Env;
class Session;
class SessionOptions;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

class DocVlmBackend final : public OcrBackend {
 public:
  DocVlmBackend();
  ~DocVlmBackend() override;

  void Load(const std::string& model_dir, const OcrLoadOptions& options) override;
  OcrResult Recognize(const OcrFrameView& frame) override;
  void Release() override;
  const char* Family() const override { return "doc_vlm"; }

 private:
  OcrLoadOptions options_{};
  DocVlmManifest manifest_{};
  DocVlmTokenizer tokenizer_{};
  bool loaded_ = false;

  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::SessionOptions> session_options_;
  std::unique_ptr<Ort::Session> vision_session_;
  std::unique_ptr<Ort::Session> embed_session_;
  std::unique_ptr<Ort::Session> decoder_session_;

  std::vector<std::string> decoder_input_names_;
  std::vector<std::string> decoder_output_names_;
  int doctag_end_id_ = 0;
};

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
