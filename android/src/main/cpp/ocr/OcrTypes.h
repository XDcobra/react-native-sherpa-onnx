/**
 * Shared OCR result / frame types — family-agnostic public contract for all backends.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

/** Contiguous RGB8 image (row-major, 3 bytes/pixel). Lifetime owned by caller. */
struct OcrFrameView {
  const uint8_t* rgb = nullptr;
  int width = 0;
  int height = 0;
  int frame_index = 0;
};

/** Axis-aligned or rotated quad in source-frame pixel coords: x0,y0,x1,y1,x2,y2,x3,y3. */
struct OcrQuad {
  float xy[8] = {0, 0, 0, 0, 0, 0, 0, 0};
};

enum class OcrSpanLevel : uint8_t {
  kLine = 0,
  kWord = 1,
  kBlock = 2,
};

struct OcrSpan {
  int utf16_start = 0;
  int utf16_end = 0;
  OcrQuad quad{};
  float confidence = 0.f;
  int frame_index = 0;
  OcrSpanLevel level = OcrSpanLevel::kLine;
};

struct OcrResult {
  std::string text_utf8;
  std::vector<OcrSpan> spans;
};

struct OcrLoadOptions {
  int num_threads = 4;
  /** Longest side for det resize (PP-OCR style). */
  int max_side_len = 960;
  bool use_orientation_cls = true;
  float det_box_thresh = 0.3f;
  float det_box_score_thresh = 0.5f;
  float det_unclip_ratio = 1.5f;
  /**
   * ORT execution provider id (e.g. "cpu"). Empty → cpu.
   * Unknown providers fall back to cpu with a warning log.
   */
  std::string provider;
};

enum class OcrGranularity : uint8_t {
  kLine = 0,
  kWord = 1,
  kBlock = 2,
};

}  // namespace ocr
}  // namespace sherpa_onnx
