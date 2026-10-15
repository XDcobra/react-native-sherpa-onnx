/**
 * OcrBackend implementation for doctr/OnnxTR det+rec model packs.
 *
 * Key differences from PpocrBackend:
 *   - RGB channel order (no BGR swap)
 *   - CTC blank = C-1 (last), not 0
 *   - Det: stretch to fixed size from manifest (e.g. 1024×1024); sigmoid on logits
 *   - Rec: fixed H×W from manifest (e.g. 32×128); mean/std from manifest
 *   - Vocab from manifest.rec.vocab string (split into per-codepoint entries)
 *   - No orientation cls session
 */
#pragma once

#include "../OcrBackend.h"
#include "DoctrManifest.h"

#include <memory>
#include <string>

namespace Ort {
class Env;
class Session;
class SessionOptions;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

class DoctrBackend final : public OcrBackend {
 public:
  DoctrBackend();
  ~DoctrBackend() override;

  void Load(const std::string& model_dir, const OcrLoadOptions& options) override;
  OcrResult Recognize(const OcrFrameView& frame) override;
  void Release() override;
  const char* Family() const override { return "doctr"; }

 private:
  OcrLoadOptions options_{};
  DoctrManifest manifest_{};
  bool loaded_ = false;

  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::SessionOptions> session_options_;
  std::unique_ptr<Ort::Session> det_session_;
  std::unique_ptr<Ort::Session> rec_session_;

  std::string det_input_name_;
  std::string det_output_name_;
  std::string rec_input_name_;
  std::string rec_output_name_;
};

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
