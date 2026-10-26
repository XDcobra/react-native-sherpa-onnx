#include "NemotronParseManifest.h"

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("NemotronParseManifest: cannot open " + path);
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

NemotronParseManifest ParseNemotronParseManifestFile(const std::string& path) {
  const std::string json = ReadFile(path);
  NemotronParseManifest m;
  m.family = JsonStringField(json, "family");
  m.id = JsonStringField(json, "id");
  m.onnx_dtype = JsonStringField(json, "onnx_dtype");
  if (m.family != "nemotron_parse") {
    throw std::runtime_error("NemotronParseManifest: family must be nemotron_parse, got '" +
                             m.family + "'");
  }
  return m;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
