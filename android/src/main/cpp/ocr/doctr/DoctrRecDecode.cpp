#include "DoctrRecDecode.h"

#include <cmath>
#include <cstdint>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

std::pair<std::string, float> CtcBlankLastDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& vocab) {
  if (num_classes <= 0 || time_steps <= 0) return {"", 0.f};

  const int blank = num_classes - 1;  // doctr CTC: blank is LAST
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
    if (best == blank || best == prev) {
      prev = best;
      continue;
    }
    prev = best;

    // Compute softmax probability for confidence
    float max_l = best_v;
    float sum = 0.f;
    for (int c = 0; c < num_classes; ++c) {
      sum += std::exp(row[c] - max_l);
    }
    float p = std::exp(best_v - max_l) / std::max(sum, 1e-12f);

    // Detect if already softmaxed (row sums near 1)
    float row_sum = 0.f;
    for (int c = 0; c < num_classes; ++c) {
      row_sum += row[c];
    }
    if (row_sum > 0.5f && row_sum < 1.5f) {
      p = best_v;
    }

    conf_sum += p;
    conf_n += 1;

    if (best >= 0 && static_cast<size_t>(best) < vocab.size()) {
      text += vocab[static_cast<size_t>(best)];
    }
  }

  const float conf = conf_n > 0 ? conf_sum / static_cast<float>(conf_n) : 0.f;
  return {text, conf};
}

std::pair<std::string, float> ParseqDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& vocab) {
  if (num_classes <= 0 || time_steps <= 0) return {"", 0.f};

  const int eos = num_classes - 1;  // EOS is last index
  std::string text;
  float conf_sum = 0.f;
  int conf_n = 0;

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
    if (best == eos) break;  // stop at EOS

    // Softmax confidence
    float max_l = best_v;
    float sum = 0.f;
    for (int c = 0; c < num_classes; ++c) {
      sum += std::exp(row[c] - max_l);
    }
    float p = std::exp(best_v - max_l) / std::max(sum, 1e-12f);

    float row_sum = 0.f;
    for (int c = 0; c < num_classes; ++c) {
      row_sum += row[c];
    }
    if (row_sum > 0.5f && row_sum < 1.5f) {
      p = best_v;
    }

    conf_sum += p;
    conf_n += 1;

    if (best >= 0 && static_cast<size_t>(best) < vocab.size()) {
      text += vocab[static_cast<size_t>(best)];
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

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
