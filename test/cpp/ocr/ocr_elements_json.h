#pragma once

#include "markup/OcrElementKind.h"
#include "OcrTypes.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace ocr_test {

inline std::string FixturePath(const char* relative_from_test_fixtures) {
  const char* env = std::getenv("TEST_FIXTURES_DIR");
  if (env && env[0] != '\0') {
    std::string base = env;
    if (base.back() != '/') base += '/';
    return base + relative_from_test_fixtures;
  }
  return std::string("test/fixtures/") + relative_from_test_fixtures;
}

inline std::string ReadWholeFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open: " + path);
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

inline std::string TrimTrailingNl(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
  return s;
}

inline std::string ReadElementsGolden(const char* name) {
  const std::string rel = std::string("ocr/expected/elements/") + name;
  return TrimTrailingNl(ReadWholeFile(FixturePath(rel.c_str())));
}

inline std::string ElementsToJson(
    const std::vector<sherpa_onnx::ocr::OcrLayoutElement>& elements) {
  std::string out = "[";
  for (size_t i = 0; i < elements.size(); ++i) {
    if (i) out += ',';
    const auto& e = elements[i];
    out += "{\"kind\":\"";
    out += sherpa_onnx::ocr::OcrElementKindName(e.kind);
    out += "\",\"frameIndex\":";
    out += std::to_string(e.frame_index);
    out += ",\"quad\":";
    if (e.has_quad) {
      out += '[';
      for (int k = 0; k < 8; ++k) {
        if (k) out += ',';
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.2f", static_cast<double>(e.quad.xy[k]));
        out += buf;
      }
      out += ']';
    } else {
      out += "null";
    }
    out += ",\"utf16Start\":";
    if (e.has_utf16) {
      out += std::to_string(e.utf16_start);
      out += ",\"utf16End\":";
      out += std::to_string(e.utf16_end);
    } else {
      out += "null,\"utf16End\":null";
    }
    out += ",\"headingLevel\":";
    if (e.heading_level) {
      out += std::to_string(*e.heading_level);
    } else {
      out += "null";
    }
    out += ",\"checked\":";
    if (e.checked) {
      out += *e.checked ? "true" : "false";
    } else {
      out += "null";
    }
    out += '}';
  }
  out += ']';
  return out;
}

}  // namespace ocr_test
