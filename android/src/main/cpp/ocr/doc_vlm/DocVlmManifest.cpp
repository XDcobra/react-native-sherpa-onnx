#include "DocVlmManifest.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("DocVlmManifest: cannot open " + path);
  }
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

size_t SkipWs(const std::string& s, size_t pos) {
  while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' ||
                            s[pos] == '\r')) {
    ++pos;
  }
  return pos;
}

std::string ParseString(const std::string& s, size_t& pos) {
  if (pos >= s.size() || s[pos] != '"') {
    throw std::runtime_error("DocVlmManifest: expected '\"'");
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
        case 'u': {
          if (pos + 4 >= s.size()) {
            throw std::runtime_error("DocVlmManifest: short \\u escape");
          }
          unsigned cp = 0;
          for (int k = 1; k <= 4; ++k) {
            const char h = s[pos + k];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp += static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') cp += static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp += static_cast<unsigned>(h - 'A' + 10);
            else throw std::runtime_error("DocVlmManifest: bad \\u escape");
          }
          pos += 4;
          if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
          } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          }
          break;
        }
        default: out.push_back(s[pos]); break;
      }
    } else {
      out.push_back(s[pos]);
    }
    ++pos;
  }
  if (pos < s.size()) ++pos;
  return out;
}

double ParseNumber(const std::string& s, size_t& pos) {
  const size_t start = pos;
  if (pos < s.size() && s[pos] == '-') ++pos;
  while (pos < s.size() && ((s[pos] >= '0' && s[pos] <= '9') || s[pos] == '.')) {
    ++pos;
  }
  if (pos < s.size() && (s[pos] == 'e' || s[pos] == 'E')) {
    ++pos;
    if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) ++pos;
    while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') ++pos;
  }
  if (start == pos) {
    throw std::runtime_error("DocVlmManifest: expected number");
  }
  return std::stod(s.substr(start, pos - start));
}

bool ParseBool(const std::string& s, size_t& pos) {
  if (s.compare(pos, 4, "true") == 0) {
    pos += 4;
    return true;
  }
  if (s.compare(pos, 5, "false") == 0) {
    pos += 5;
    return false;
  }
  throw std::runtime_error("DocVlmManifest: expected bool");
}

std::vector<double> ParseNumberArray(const std::string& s, size_t& pos) {
  std::vector<double> out;
  pos = SkipWs(s, pos);
  if (pos >= s.size() || s[pos] != '[') {
    throw std::runtime_error("DocVlmManifest: expected '['");
  }
  ++pos;
  while (true) {
    pos = SkipWs(s, pos);
    if (pos < s.size() && s[pos] == ']') {
      ++pos;
      break;
    }
    out.push_back(ParseNumber(s, pos));
    pos = SkipWs(s, pos);
    if (pos < s.size() && s[pos] == ',') ++pos;
  }
  return out;
}

void SkipValue(const std::string& s, size_t& pos) {
  pos = SkipWs(s, pos);
  if (pos >= s.size()) return;
  if (s[pos] == '"') {
    ParseString(s, pos);
    return;
  }
  if (s[pos] == '{' || s[pos] == '[') {
    ++pos;
    int depth = 1;
    while (pos < s.size() && depth > 0) {
      if (s[pos] == '"') {
        ParseString(s, pos);
        continue;
      }
      if (s[pos] == '{' || s[pos] == '[') ++depth;
      else if (s[pos] == '}' || s[pos] == ']') --depth;
      ++pos;
    }
    return;
  }
  while (pos < s.size() && s[pos] != ',' && s[pos] != '}' && s[pos] != ']' &&
         s[pos] != ' ' && s[pos] != '\n' && s[pos] != '\r' && s[pos] != '\t') {
    ++pos;
  }
}

void RequireEq(const std::string& field, const std::string& got, const char* expect) {
  if (got != expect) {
    throw std::runtime_error("DocVlmManifest: " + field + " must be " + expect +
                             ", got " + got);
  }
}

void RequireEqInt(const std::string& field, int got, int expect) {
  if (got != expect) {
    throw std::runtime_error("DocVlmManifest: " + field + " must be " +
                             std::to_string(expect) + ", got " + std::to_string(got));
  }
}

}  // namespace

DocVlmManifest ParseDocVlmManifestFile(const std::string& manifest_path) {
  const std::string json = ReadFile(manifest_path);

  DocVlmManifest m;
  size_t pos = SkipWs(json, 0);
  if (pos >= json.size() || json[pos] != '{') {
    throw std::runtime_error("DocVlmManifest: expected top-level '{'");
  }
  ++pos;

  while (true) {
    pos = SkipWs(json, pos);
    if (pos >= json.size() || json[pos] == '}') break;
    const std::string key = ParseString(json, pos);
    pos = SkipWs(json, pos);
    if (pos < json.size() && json[pos] == ':') ++pos;
    pos = SkipWs(json, pos);

    if (key == "family") {
      m.family = ParseString(json, pos);
    } else if (key == "arch") {
      m.arch = ParseString(json, pos);
    } else if (key == "onnx_dtype") {
      m.onnx_dtype = ParseString(json, pos);
    } else if (key == "vision" || key == "text" || key == "special_tokens") {
      if (pos >= json.size() || json[pos] != '{') {
        throw std::runtime_error("DocVlmManifest: expected '{' for " + key);
      }
      ++pos;
      while (true) {
        pos = SkipWs(json, pos);
        if (pos >= json.size() || json[pos] == '}') break;
        const std::string sub = ParseString(json, pos);
        pos = SkipWs(json, pos);
        if (pos < json.size() && json[pos] == ':') ++pos;
        pos = SkipWs(json, pos);

        if (key == "vision" && sub == "image_size") {
          m.image_size = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "patch_size") {
          m.patch_size = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "scale_factor") {
          m.scale_factor = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "image_seq_len") {
          m.image_seq_len = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "mean") {
          const auto arr = ParseNumberArray(json, pos);
          for (size_t i = 0; i < std::min(arr.size(), size_t{3}); ++i) {
            m.mean[i] = static_cast<float>(arr[i]);
          }
        } else if (key == "vision" && sub == "std") {
          const auto arr = ParseNumberArray(json, pos);
          for (size_t i = 0; i < std::min(arr.size(), size_t{3}); ++i) {
            m.std[i] = static_cast<float>(arr[i]);
          }
        } else if (key == "vision" && sub == "rescale_factor") {
          m.rescale_factor = static_cast<float>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "size_longest_edge") {
          m.size_longest_edge = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "max_image_size_longest_edge") {
          m.max_image_size_longest_edge = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "vision" && sub == "do_image_splitting") {
          m.do_image_splitting = ParseBool(json, pos);
        } else if (key == "text" && sub == "hidden_size") {
          m.hidden_size = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "text" && sub == "num_hidden_layers") {
          m.num_hidden_layers = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "text" && sub == "num_key_value_heads") {
          m.num_key_value_heads = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "text" && sub == "head_dim") {
          m.head_dim = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "text" && sub == "vocab_size") {
          m.vocab_size = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "text" && sub == "max_position_embeddings") {
          m.max_position_embeddings = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "special_tokens" && sub == "bos_token_id") {
          m.bos_token_id = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "special_tokens" && sub == "eos_token_id") {
          m.eos_token_id = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "special_tokens" && sub == "image_token_id") {
          m.image_token_id = static_cast<int>(ParseNumber(json, pos));
        } else if (key == "special_tokens" && sub == "bos_token") {
          m.bos_token = ParseString(json, pos);
        } else if (key == "special_tokens" && sub == "eos_token") {
          m.eos_token = ParseString(json, pos);
        } else if (key == "special_tokens" && sub == "image_token") {
          m.image_token = ParseString(json, pos);
        } else {
          SkipValue(json, pos);
        }

        pos = SkipWs(json, pos);
        if (pos < json.size() && json[pos] == ',') ++pos;
      }
      if (pos < json.size()) ++pos;
    } else {
      SkipValue(json, pos);
    }

    pos = SkipWs(json, pos);
    if (pos < json.size() && json[pos] == ',') ++pos;
  }

  RequireEq("family", m.family, "doc_vlm");
  RequireEq("arch", m.arch, "idefics3");
  RequireEq("onnx_dtype", m.onnx_dtype, "fp32");
  RequireEqInt("vision.image_size", m.image_size, 512);
  RequireEqInt("vision.image_seq_len", m.image_seq_len, 64);
  RequireEqInt("text.hidden_size", m.hidden_size, 576);
  RequireEqInt("text.num_hidden_layers", m.num_hidden_layers, 30);
  RequireEqInt("text.vocab_size", m.vocab_size, 100352);
  if (!m.do_image_splitting) {
    throw std::runtime_error("DocVlmManifest: vision.do_image_splitting must be true");
  }
  if (m.rescale_factor <= 0.f) {
    throw std::runtime_error("DocVlmManifest: vision.rescale_factor must be positive");
  }
  for (int i = 0; i < 3; ++i) {
    if (m.std[i] == 0.f) {
      throw std::runtime_error("DocVlmManifest: vision.std must be non-zero");
    }
  }
  if (m.size_longest_edge <= 0 || m.max_image_size_longest_edge <= 0 ||
      m.num_key_value_heads <= 0 || m.head_dim <= 0 || m.max_position_embeddings <= 0) {
    throw std::runtime_error("DocVlmManifest: missing vision or text shape fields");
  }
  return m;
}

DocVlmManifest ParseDocVlmManifest(const std::string& model_dir) {
  return ParseDocVlmManifestFile(
      (fs::path(model_dir) / "ocr_manifest.json").string());
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
