#include "PaddleocrVlManifest.h"

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {
namespace {

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("PaddleocrVlManifest: cannot open " + path);
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

std::string JsonStringField(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\"";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) return {};
  pos = json.find(':', pos + needle.size());
  if (pos == std::string::npos) return {};
  ++pos;
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\n' || json[pos] == '\t')) {
    ++pos;
  }
  if (pos >= json.size() || json[pos] != '"') return {};
  ++pos;
  std::string out;
  while (pos < json.size() && json[pos] != '"') {
    if (json[pos] == '\\' && pos + 1 < json.size()) {
      ++pos;
    }
    out.push_back(json[pos]);
    ++pos;
  }
  return out;
}

}  // namespace

PaddleocrVlManifest ParsePaddleocrVlManifestFile(const std::string& path) {
  const std::string json = ReadFile(path);
  PaddleocrVlManifest m;
  m.family = JsonStringField(json, "family");
  m.id = JsonStringField(json, "id");
  m.onnx_dtype = JsonStringField(json, "onnx_dtype");
  if (m.family != "paddleocr_vl") {
    throw std::runtime_error("PaddleocrVlManifest: family must be paddleocr_vl, got '" +
                             m.family + "'");
  }
  // Optional files map (best-effort; Load still uses canonical names).
  const size_t files = json.find("\"files\"");
  if (files != std::string::npos) {
    const std::string slice = json.substr(files, 512);
    m.vision_encoder = JsonStringField(slice, "vision_encoder");
    m.embedding = JsonStringField(slice, "embedding");
    m.decoder = JsonStringField(slice, "decoder");
    m.tokenizer = JsonStringField(slice, "tokenizer");
  }
  return m;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
