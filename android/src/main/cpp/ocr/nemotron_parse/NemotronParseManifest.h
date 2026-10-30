#pragma once

#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {

struct NemotronParseManifest {
  std::string family;
  std::string id;
  std::string onnx_dtype;
  int num_layers = 10;
  int num_kv_heads = 8;
  int head_dim = 64;
};

NemotronParseManifest ParseNemotronParseManifestFile(const std::string& path);

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
