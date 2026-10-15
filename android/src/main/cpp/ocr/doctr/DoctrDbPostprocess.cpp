#include "DoctrDbPostprocess.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <queue>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {
namespace {

inline float Sigmoid(float x) {
  return 1.f / (1.f + std::exp(-x));
}

struct Comp {
  int min_x = 0, min_y = 0, max_x = 0, max_y = 0;
  int count = 0;
  double score_sum = 0.0;
};

void Dilate2x2(std::vector<uint8_t>& bin, int h, int w) {
  std::vector<uint8_t> out(bin.size(), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      uint8_t v = 0;
      for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
          const int yy = std::min(y + dy, h - 1);
          const int xx = std::min(x + dx, w - 1);
          v = static_cast<uint8_t>(v | bin[static_cast<size_t>(yy) * w + xx]);
        }
      }
      out[static_cast<size_t>(y) * w + x] = v;
    }
  }
  bin.swap(out);
}

std::vector<Comp> ConnectedComponents(
    const std::vector<uint8_t>& bin,
    const std::vector<float>& prob,
    int h,
    int w) {
  std::vector<int> labels(static_cast<size_t>(h) * w, -1);
  std::vector<Comp> comps;
  const int dx[4] = {1, -1, 0, 0};
  const int dy[4] = {0, 0, 1, -1};
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t i = static_cast<size_t>(y) * w + x;
      if (bin[i] == 0 || labels[i] >= 0) continue;
      Comp c;
      c.min_x = c.max_x = x;
      c.min_y = c.max_y = y;
      std::queue<std::pair<int, int>> q;
      q.push({x, y});
      labels[i] = static_cast<int>(comps.size());
      while (!q.empty()) {
        const auto [cx, cy] = q.front();
        q.pop();
        const size_t ci = static_cast<size_t>(cy) * w + cx;
        c.count += 1;
        c.score_sum += prob[ci];
        c.min_x = std::min(c.min_x, cx);
        c.max_x = std::max(c.max_x, cx);
        c.min_y = std::min(c.min_y, cy);
        c.max_y = std::max(c.max_y, cy);
        for (int k = 0; k < 4; ++k) {
          const int nx = cx + dx[k];
          const int ny = cy + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const size_t ni = static_cast<size_t>(ny) * w + nx;
          if (bin[ni] == 0 || labels[ni] >= 0) continue;
          labels[ni] = labels[i];
          q.push({nx, ny});
        }
      }
      comps.push_back(c);
    }
  }
  return comps;
}

}  // namespace

std::vector<DetBox> DoctrDbPostprocess(
    const float* logits,
    int pred_h,
    int pred_w,
    int src_w,
    int src_h,
    float box_thresh,
    float box_score_thresh,
    float unclip_ratio) {
  const size_t n = static_cast<size_t>(pred_h) * pred_w;

  // Apply sigmoid to logits
  std::vector<float> prob(n);
  std::vector<uint8_t> bin(n, 0);
  for (size_t i = 0; i < n; ++i) {
    prob[i] = Sigmoid(logits[i]);
    bin[i] = prob[i] > box_thresh ? static_cast<uint8_t>(1) : static_cast<uint8_t>(0);
  }

  Dilate2x2(bin, pred_h, pred_w);
  auto comps = ConnectedComponents(bin, prob, pred_h, pred_w);

  // Map from det-input space (pred_h × pred_w) to source image coords
  const float ratio_w = static_cast<float>(src_w) / static_cast<float>(pred_w);
  const float ratio_h = static_cast<float>(src_h) / static_cast<float>(pred_h);

  std::vector<DetBox> boxes;
  boxes.reserve(comps.size());
  const float expand = std::max(1.f, unclip_ratio);

  for (const auto& c : comps) {
    if (c.count < 9) continue;
    const float score = static_cast<float>(c.score_sum / std::max(1, c.count));
    if (score < box_score_thresh) continue;

    float min_x = static_cast<float>(c.min_x);
    float max_x = static_cast<float>(c.max_x);
    float min_y = static_cast<float>(c.min_y);
    float max_y = static_cast<float>(c.max_y);
    const float bw = std::max(1.f, max_x - min_x + 1.f);
    const float bh = std::max(1.f, max_y - min_y + 1.f);
    const float ex = bw * (expand - 1.f) * 0.5f;
    const float ey = bh * (expand - 1.f) * 0.5f;
    min_x = std::max(0.f, min_x - ex);
    min_y = std::max(0.f, min_y - ey);
    max_x = std::min(static_cast<float>(pred_w - 1), max_x + ex);
    max_y = std::min(static_cast<float>(pred_h - 1), max_y + ey);

    // Map to source coords
    const float sx0 = min_x * ratio_w;
    const float sy0 = min_y * ratio_h;
    const float sx1 = max_x * ratio_w;
    const float sy1 = max_y * ratio_h;

    DetBox box;
    box.score = score;
    box.quad[0] = sx0; box.quad[1] = sy0;  // tl
    box.quad[2] = sx1; box.quad[3] = sy0;  // tr
    box.quad[4] = sx1; box.quad[5] = sy1;  // br
    box.quad[6] = sx0; box.quad[7] = sy1;  // bl
    // Clamp
    for (int i = 0; i < 4; ++i) {
      box.quad[i * 2] =
          std::min(std::max(box.quad[i * 2], 0.f), static_cast<float>(src_w - 1));
      box.quad[i * 2 + 1] =
          std::min(std::max(box.quad[i * 2 + 1], 0.f), static_cast<float>(src_h - 1));
    }
    const float long_side = std::max(sx1 - sx0, sy1 - sy0);
    if (long_side < 3.f) continue;
    boxes.push_back(box);
  }

  SortDetBoxesReadingOrder(boxes);
  return boxes;
}

void SortDetBoxesReadingOrder(std::vector<DetBox>& boxes) {
  std::sort(boxes.begin(), boxes.end(), [](const DetBox& a, const DetBox& b) {
    const float ay = (a.quad[1] + a.quad[5]) * 0.5f;
    const float by = (b.quad[1] + b.quad[5]) * 0.5f;
    if (std::fabs(ay - by) > 10.f) return ay < by;
    const float ax = (a.quad[0] + a.quad[2]) * 0.5f;
    const float bx = (b.quad[0] + b.quad[2]) * 0.5f;
    return ax < bx;
  });
}

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
