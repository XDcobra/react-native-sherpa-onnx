#pragma once

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

struct PaddleocrVlManifest {
  std::string family;
  std::string id;
  std::string onnx_dtype;
  std::string vision_encoder;
  std::string embedding;
  std::string decoder;
  std::string tokenizer;
};

PaddleocrVlManifest ParsePaddleocrVlManifestFile(const std::string& path);

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
