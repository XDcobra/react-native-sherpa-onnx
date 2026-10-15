#include "DoctrManifest.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {
namespace doctr {
namespace {

// Minimal hand-rolled JSON helpers (no external library).
// The manifest is small and well-structured; this is intentionally simple.

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("DoctrManifest: cannot open " + path);
  }
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

// Skip whitespace; return new position.
size_t SkipWs(const std::string& s, size_t pos) {
  while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' ||
                            s[pos] == '\n' || s[pos] == '\r')) {
    ++pos;
  }
  return pos;
}

// Parse a JSON string value (assumes pos points at opening '"').
std::string ParseString(const std::string& s, size_t& pos) {
  if (pos >= s.size() || s[pos] != '"') {
    throw std::runtime_error("DoctrManifest: expected '\"'");
  }
  ++pos;
  std::string out;
  while (pos < s.size() && s[pos] != '"') {
    if (s[pos] == '\\' && pos + 1 < s.size()) {
      ++pos;
      switch (s[pos]) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        default: out.push_back(s[pos]); break;
      }
    } else {
      out.push_back(s[pos]);
    }
    ++pos;
  }
  if (pos < s.size()) ++pos;  // skip closing '"'
  return out;
}

// Parse a JSON number (int or float).
double ParseNumber(const std::string& s, size_t& pos) {
  size_t start = pos;
  if (pos < s.size() && s[pos] == '-') ++pos;
  while (pos < s.size() && ((s[pos] >= '0' && s[pos] <= '9') || s[pos] == '.')) {
    ++pos;
  }
  // Handle e/E notation
  if (pos < s.size() && (s[pos] == 'e' || s[pos] == 'E')) {
    ++pos;
    if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) ++pos;
    while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') ++pos;
  }
  return std::stod(s.substr(start, pos - start));
}

// Parse a JSON array of numbers into a vector<double>.
std::vector<double> ParseNumberArray(const std::string& s, size_t& pos) {
  std::vector<double> out;
  pos = SkipWs(s, pos);
  if (pos >= s.size() || s[pos] != '[') {
    throw std::runtime_error("DoctrManifest: expected '['");
  }
  ++pos;
  while (true) {
    pos = SkipWs(s, pos);
    if (pos < s.size() && s[pos] == ']') { ++pos; break; }
    out.push_back(ParseNumber(s, pos));
    pos = SkipWs(s, pos);
    if (pos < s.size() && s[pos] == ',') ++pos;
  }
  return out;
}

// Skip a JSON value (string, number, array, object, true/false/null).
void SkipValue(const std::string& s, size_t& pos) {
  pos = SkipWs(s, pos);
  if (pos >= s.size()) return;
  if (s[pos] == '"') {
    ParseString(s, pos);
  } else if (s[pos] == '[') {
    ++pos;
    int depth = 1;
    while (pos < s.size() && depth > 0) {
      if (s[pos] == '[') ++depth;
      else if (s[pos] == ']') --depth;
      else if (s[pos] == '"') ParseString(s, pos);
      if (depth > 0) ++pos;
    }
    if (pos < s.size()) ++pos;
  } else if (s[pos] == '{') {
    ++pos;
    int depth = 1;
    while (pos < s.size() && depth > 0) {
      if (s[pos] == '{') ++depth;
      else if (s[pos] == '}') --depth;
      else if (s[pos] == '"') ParseString(s, pos);
      if (depth > 0) ++pos;
    }
    if (pos < s.size()) ++pos;
  } else {
    // number, true, false, null
    while (pos < s.size() && s[pos] != ',' && s[pos] != '}' && s[pos] != ']' &&
           s[pos] != ' ' && s[pos] != '\n' && s[pos] != '\r' && s[pos] != '\t') {
      ++pos;
    }
  }
}

// Split a UTF-8 string into individual codepoints, each as a UTF-8 string.
std::vector<std::string> SplitUtf8Codepoints(const std::string& s) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < s.size()) {
    const auto c = static_cast<unsigned char>(s[i]);
    size_t len = 1;
    if (c >= 0xF0) len = 4;
    else if (c >= 0xE0) len = 3;
    else if (c >= 0xC0) len = 2;
    if (i + len > s.size()) len = s.size() - i;
    out.push_back(s.substr(i, len));
    i += len;
  }
  return out;
}

}  // namespace

bool DoctrManifest::IsParseq() const {
  return rec_arch.find("parseq") != std::string::npos ||
         rec_arch.find("vitstr") != std::string::npos;
}

bool DoctrManifest::IsCrnn() const {
  return rec_arch.find("crnn") != std::string::npos;
}

DoctrManifest ParseDoctrManifest(const std::string& model_dir) {
  const std::string path = (fs::path(model_dir) / "ocr_manifest.json").string();
  const std::string json = ReadFile(path);

  DoctrManifest m;
  size_t pos = SkipWs(json, 0);
  if (pos >= json.size() || json[pos] != '{') {
    throw std::runtime_error("DoctrManifest: expected top-level '{'");
  }
  ++pos;

  while (true) {
    pos = SkipWs(json, pos);
    if (pos >= json.size() || json[pos] == '}') break;
    std::string key = ParseString(json, pos);
    pos = SkipWs(json, pos);
    if (pos < json.size() && json[pos] == ':') ++pos;
    pos = SkipWs(json, pos);

    if (key == "family") {
      m.family = ParseString(json, pos);
    } else if (key == "det" || key == "rec") {
      // Parse nested object
      if (pos >= json.size() || json[pos] != '{') {
        throw std::runtime_error("DoctrManifest: expected '{' for " + key);
      }
      ++pos;
      while (true) {
        pos = SkipWs(json, pos);
        if (pos >= json.size() || json[pos] == '}') break;
        std::string subkey = ParseString(json, pos);
        pos = SkipWs(json, pos);
        if (pos < json.size() && json[pos] == ':') ++pos;
        pos = SkipWs(json, pos);

        if (subkey == "arch") {
          std::string arch = ParseString(json, pos);
          if (key == "det") m.det_arch = arch;
          else m.rec_arch = arch;
        } else if (subkey == "input_shape") {
          auto arr = ParseNumberArray(json, pos);
          if (arr.size() == 3) {
            if (key == "det") {
              m.det_c = static_cast<int>(arr[0]);
              m.det_h = static_cast<int>(arr[1]);
              m.det_w = static_cast<int>(arr[2]);
            } else {
              m.rec_c = static_cast<int>(arr[0]);
              m.rec_h = static_cast<int>(arr[1]);
              m.rec_w = static_cast<int>(arr[2]);
            }
          }
        } else if (subkey == "mean") {
          auto arr = ParseNumberArray(json, pos);
          auto& target = (key == "det") ? m.det_mean : m.rec_mean;
          for (size_t i = 0; i < std::min(arr.size(), size_t(3)); ++i) {
            target[i] = static_cast<float>(arr[i]);
          }
        } else if (subkey == "std") {
          auto arr = ParseNumberArray(json, pos);
          auto& target = (key == "det") ? m.det_std : m.rec_std;
          for (size_t i = 0; i < std::min(arr.size(), size_t(3)); ++i) {
            target[i] = static_cast<float>(arr[i]);
          }
        } else if (subkey == "vocab" && key == "rec") {
          m.rec_vocab = SplitUtf8Codepoints(ParseString(json, pos));
        } else {
          SkipValue(json, pos);
        }

        pos = SkipWs(json, pos);
        if (pos < json.size() && json[pos] == ',') ++pos;
      }
      if (pos < json.size()) ++pos;  // skip '}'
    } else {
      SkipValue(json, pos);
    }

    pos = SkipWs(json, pos);
    if (pos < json.size() && json[pos] == ',') ++pos;
  }

  if (m.family.empty()) m.family = "doctr";
  if (m.rec_vocab.empty()) {
    throw std::runtime_error("DoctrManifest: rec.vocab is empty in " + path);
  }
  return m;
}

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
