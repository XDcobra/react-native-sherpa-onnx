#include "DocVlmPrompt.h"

#include "../OcrGeometry.h"
#include "DocVlmTaskProfile.h"

#include <stdexcept>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

constexpr int kImageSeqLen = 64;

void AppendImages(std::string& text) {
  for (int i = 0; i < kImageSeqLen; ++i) text += "<image>";
}

std::string BuildPromptText(int rows, int cols, std::string_view user_text) {
  std::string text = "<|start_of_role|>user<|end_of_role|>";
  if (rows == 0 && cols == 0) {
    text += "<fake_token_around_image><global-img>";
    AppendImages(text);
    text += "<fake_token_around_image>";
  } else {
    for (int r = 1; r <= rows; ++r) {
      for (int c = 1; c <= cols; ++c) {
        text += "<fake_token_around_image><row_";
        text += std::to_string(r);
        text += "_col_";
        text += std::to_string(c);
        text += ">";
        AppendImages(text);
      }
      text += "\n";
    }
    text += "\n<fake_token_around_image><global-img>";
    AppendImages(text);
    text += "<fake_token_around_image>";
  }
  text.append(user_text.data(), user_text.size());
  text += "<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>";
  return text;
}

bool RegionInsideFrame(const OcrPixelRect& region, int frame_w, int frame_h) {
  if (!OcrPixelRectValid(region) || frame_w <= 0 || frame_h <= 0) return false;
  const long right = static_cast<long>(region.x) + region.width;
  const long bottom = static_cast<long>(region.y) + region.height;
  return right <= frame_w && bottom <= frame_h;
}

}  // namespace

std::string FormatGraniteLocs(const OcrPixelRect& region, int frame_w,
                              int frame_h) {
  if (!OcrPixelRectValid(region) || !RegionInsideFrame(region, frame_w, frame_h)) {
    throw OcrCodedError(kOcrErrInvalidRegion, "region lies outside the frame");
  }
  const OcrGridRect grid =
      PixelsToGrid(region, frame_w, frame_h, kOcrGridGranite);
  if (grid.x2 <= grid.x1 || grid.y2 <= grid.y1) {
    throw OcrCodedError(kOcrErrInvalidRegion,
                        "region collapses on the granite 0-500 grid");
  }
  std::string out = "<loc_";
  out += std::to_string(grid.x1);
  out += "><loc_";
  out += std::to_string(grid.y1);
  out += "><loc_";
  out += std::to_string(grid.x2);
  out += "><loc_";
  out += std::to_string(grid.y2);
  out += ">";
  return out;
}

std::string BuildDocVlmUserText(const DocVlmInstruction& inst, int frame_w,
                                int frame_h) {
  const DocVlmTaskProfile& profile = ProfileFor(inst);
  if (!profile.needs_region) return profile.user_text_prefix;
  return std::string(profile.user_text_prefix) +
         FormatGraniteLocs(inst.region, frame_w, frame_h);
}

std::vector<int32_t> BuildPromptIds(const DocVlmTokenizer& tokenizer, int rows,
                                    int cols, std::string_view user_text) {
  const bool single = rows == 0 && cols == 0;
  const bool split = rows >= 1 && cols >= 1;
  if (!single && !split) {
    throw std::invalid_argument("DocVlmPrompt: rows and cols must both be 0 or both be >= 1");
  }
  if (rows > 4 || cols > 4) {
    throw std::invalid_argument("DocVlmPrompt: rows and cols must be <= 4");
  }
  std::string_view text = user_text;
  std::string owned;
  if (text.empty()) {
    owned = ProfileFor(DefaultDocVlmInstruction()).user_text_prefix;
    text = owned;
  }
  // Encode the expanded chat string so adjacent newlines follow BPE
  // (this pack merges "\n\n" to ĊĊ, id 271) instead of two separate newline ids.
  return tokenizer.Encode(BuildPromptText(rows, cols, text));
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
