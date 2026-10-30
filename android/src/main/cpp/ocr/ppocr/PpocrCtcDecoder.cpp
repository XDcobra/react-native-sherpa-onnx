#include "PpocrCtcDecoder.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {

std::vector<std::string> LoadCharacterDictFromYml(const std::string& yml_path) {
  std::ifstream in(yml_path);
  if (!in) {
    throw std::runtime_error("Cannot open rec_inference.yml: " + yml_path);
  }
  std::vector<std::string> dict;
  dict.emplace_back("blank");  // index 0
  bool in_dict = false;
  std::string line;
  while (std::getline(in, line)) {
    if (!in_dict) {
      if (line.find("character_dict:") != std::string::npos) {
        in_dict = true;
      }
      continue;
    }
    // End of list when indentation drops to a non-list key at PostProcess level
    // or a top-level key. Dict entries look like: "  - x" or "  - ' '"
    const auto dash = line.find("- ");
    if (dash != std::string::npos) {
      // Require leading spaces before '-'
      bool only_spaces_before = true;
      for (size_t i = 0; i < dash; ++i) {
        if (line[i] != ' ') {
          only_spaces_before = false;
          break;
        }
      }
      if (!only_spaces_before || dash < 2) {
        // likely left the list
        if (!dict.empty() && dict.size() > 1) {
          break;
        }
        continue;
      }
      std::string token = line.substr(dash + 2);
      // strip trailing CR and surrounding quotes
      while (!token.empty() && (token.back() == '\r' || token.back() == ' ')) {
        token.pop_back();
      }
      if (token.size() >= 2 &&
          ((token.front() == '\'' && token.back() == '\'') ||
           (token.front() == '"' && token.back() == '"'))) {
        token = token.substr(1, token.size() - 2);
      }
      dict.push_back(token);
      continue;
    }
    if (!line.empty() && line[0] != ' ' && line[0] != '\t' && line[0] != '#') {
      break;
    }
    if (in_dict && !line.empty() && line.find(':') != std::string::npos &&
        line.find('-') == std::string::npos && dict.size() > 10) {
      break;
    }
  }
  if (dict.size() < 2) {
    throw std::runtime_error("character_dict empty or missing in " + yml_path);
  }
  return dict;
}

std::pair<std::string, float> CtcGreedyDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& dict) {
  std::string text;
  float conf_sum = 0.f;
  int conf_n = 0;
  int prev = -1;
  for (int t = 0; t < time_steps; ++t) {
    const float* row = logits + static_cast<size_t>(t) * num_classes;
    int best = 0;
    float best_v = row[0];
    for (int c = 1; c < num_classes; ++c) {
      if (row[c] > best_v) {
        best_v = row[c];
        best = c;
      }
    }
    if (best == 0 || best == prev) {
      prev = best;
      continue;
    }
    prev = best;
    // PP-OCR ONNX rec often exports already-softmaxed probs; detect via row sum.
    float row_sum = 0.f;
    for (int c = 0; c < num_classes; ++c) {
      row_sum += row[c];
    }
    float p = best_v;
    if (row_sum < 0.5f || row_sum > 1.5f) {
      float max_l = best_v;
      float sum = 0.f;
      for (int c = 0; c < num_classes; ++c) {
        sum += std::exp(row[c] - max_l);
      }
      p = std::exp(best_v - max_l) / std::max(sum, 1e-12f);
    }
    conf_sum += p;
    conf_n += 1;
    if (best >= 0 && static_cast<size_t>(best) < dict.size()) {
      text += dict[static_cast<size_t>(best)];
    }
  }
  const float conf = conf_n > 0 ? conf_sum / static_cast<float>(conf_n) : 0.f;
  return {text, conf};
}

int Utf8ToUtf16Length(const std::string& utf8) {
  int units = 0;
  for (size_t i = 0; i < utf8.size();) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    size_t len = 1;
    uint32_t cp = c;
    if (c >= 0xF0) {
      len = 4;
      cp = (c & 0x07) << 18;
      if (i + 3 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 12;
        cp |= (static_cast<unsigned char>(utf8[i + 2]) & 0x3F) << 6;
        cp |= (static_cast<unsigned char>(utf8[i + 3]) & 0x3F);
      }
    } else if (c >= 0xE0) {
      len = 3;
      cp = (c & 0x0F) << 12;
      if (i + 2 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 6;
        cp |= (static_cast<unsigned char>(utf8[i + 2]) & 0x3F);
      }
    } else if (c >= 0xC0) {
      len = 2;
      cp = (c & 0x1F) << 6;
      if (i + 1 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F);
      }
    }
    units += (cp > 0xFFFF) ? 2 : 1;
    i += len;
  }
  return units;
}

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
