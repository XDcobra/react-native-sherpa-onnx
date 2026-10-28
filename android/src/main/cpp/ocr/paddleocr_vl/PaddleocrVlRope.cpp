#include "PaddleocrVlRope.h"

#include <algorithm>
#include <stdexcept>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

RopeIndex ComputeRopeIndex(const std::vector<int64_t>& input_ids, int grid_t, int grid_h,
                           int grid_w, int image_token_id, int spatial_merge) {
  if (input_ids.empty()) {
    throw std::invalid_argument("PaddleocrVlRope: empty input_ids");
  }
  if (grid_t <= 0 || grid_h <= 0 || grid_w <= 0 || spatial_merge <= 0) {
    throw std::invalid_argument("PaddleocrVlRope: invalid grid");
  }
  const int seq = static_cast<int>(input_ids.size());
  const int llm_grid_t = grid_t;
  const int llm_grid_h = grid_h / spatial_merge;
  const int llm_grid_w = grid_w / spatial_merge;
  const int vision_tokens = llm_grid_t * llm_grid_h * llm_grid_w;

  std::vector<int64_t> tokens = input_ids;
  std::vector<std::vector<int64_t>> llm_pos_t;
  std::vector<std::vector<int64_t>> llm_pos_h;
  std::vector<std::vector<int64_t>> llm_pos_w;

  int st = 0;
  auto append_text = [&](int text_len, int64_t st_idx) {
    std::vector<int64_t> t(static_cast<size_t>(text_len));
    std::vector<int64_t> h(static_cast<size_t>(text_len));
    std::vector<int64_t> w(static_cast<size_t>(text_len));
    for (int i = 0; i < text_len; ++i) {
      t[static_cast<size_t>(i)] = st_idx + i;
      h[static_cast<size_t>(i)] = st_idx + i;
      w[static_cast<size_t>(i)] = st_idx + i;
    }
    llm_pos_t.push_back(std::move(t));
    llm_pos_h.push_back(std::move(h));
    llm_pos_w.push_back(std::move(w));
  };

  auto last_max = [&]() -> int64_t {
    if (llm_pos_t.empty() || llm_pos_t.back().empty()) return -1;
    int64_t m = llm_pos_t.back()[0];
    for (int64_t v : llm_pos_t.back()) m = std::max(m, v);
    for (int64_t v : llm_pos_h.back()) m = std::max(m, v);
    for (int64_t v : llm_pos_w.back()) m = std::max(m, v);
    return m;
  };

  int ed = -1;
  for (int i = st; i < seq; ++i) {
    if (tokens[static_cast<size_t>(i)] == image_token_id) {
      ed = i;
      break;
    }
  }
  if (ed >= 0) {
    const int text_len = ed - st;
    const int64_t st_idx = last_max() + 1;
    if (text_len > 0) append_text(text_len, st_idx);
    const int64_t vis_base = (text_len > 0 ? st_idx : last_max() + 1) + text_len;
    std::vector<int64_t> t_index(static_cast<size_t>(vision_tokens), 0);
    std::vector<int64_t> h_index(static_cast<size_t>(vision_tokens), 0);
    std::vector<int64_t> w_index(static_cast<size_t>(vision_tokens), 0);
    int idx = 0;
    for (int tt = 0; tt < llm_grid_t; ++tt) {
      for (int hh = 0; hh < llm_grid_h; ++hh) {
        for (int ww = 0; ww < llm_grid_w; ++ww) {
          t_index[static_cast<size_t>(idx)] = vis_base;
          h_index[static_cast<size_t>(idx)] = vis_base + hh;
          w_index[static_cast<size_t>(idx)] = vis_base + ww;
          ++idx;
        }
      }
    }
    llm_pos_t.push_back(std::move(t_index));
    llm_pos_h.push_back(std::move(h_index));
    llm_pos_w.push_back(std::move(w_index));
    st = ed + vision_tokens;
  }
  if (st < seq) {
    const int text_len = seq - st;
    append_text(text_len, last_max() + 1);
  }
  if (llm_pos_t.empty()) {
    append_text(seq, 0);
  }

  RopeIndex out;
  out.seq = seq;
  out.position_ids.assign(static_cast<size_t>(3) * seq, 0);
  int cursor = 0;
  int64_t max_pos = 0;
  auto dump_axis = [&](const std::vector<std::vector<int64_t>>& axis, int plane) {
    int col = 0;
    for (const auto& block : axis) {
      for (int64_t v : block) {
        if (col >= seq) break;
        out.position_ids[static_cast<size_t>(plane) * seq + col] = v;
        max_pos = std::max(max_pos, v);
        ++col;
      }
    }
    cursor = col;
  };
  dump_axis(llm_pos_t, 0);
  dump_axis(llm_pos_h, 1);
  dump_axis(llm_pos_w, 2);
  if (cursor != seq) {
    // Mismatched vision token count vs grid — fill remaining 1D.
    for (int i = cursor; i < seq; ++i) {
      const int64_t v = i;
      out.position_ids[static_cast<size_t>(i)] = v;
      out.position_ids[static_cast<size_t>(seq + i)] = v;
      out.position_ids[static_cast<size_t>(2 * seq + i)] = v;
      max_pos = std::max(max_pos, v);
    }
  }
  out.rope_delta = max_pos + 1 - seq;
  return out;
}

std::vector<int64_t> DecodePositionIds(int past_len, int rope_delta, int seq) {
  if (seq <= 0) throw std::invalid_argument("PaddleocrVlRope: seq must be positive");
  std::vector<int64_t> out(static_cast<size_t>(3) * seq);
  for (int i = 0; i < seq; ++i) {
    const int64_t pos = static_cast<int64_t>(i) + past_len + rope_delta;
    out[static_cast<size_t>(i)] = pos;
    out[static_cast<size_t>(seq + i)] = pos;
    out[static_cast<size_t>(2 * seq + i)] = pos;
  }
  return out;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
