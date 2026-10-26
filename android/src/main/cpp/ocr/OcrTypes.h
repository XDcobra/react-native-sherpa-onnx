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
  /** doc_vlm: raw DocTags after ASCII lstrip. Empty for ppocr/doctr. */
  std::string doctags_utf8;
  /** doc_vlm: lossy markdown from DocTags. Empty for ppocr/doctr. */
  std::string markdown_utf8;
  /**
   * doc_vlm stop: doctag_end | eos | max_new_tokens | invalid_sequence.
   * Empty for ppocr/doctr.
   */
  std::string stop_reason;
  /** doc_vlm: true only after </doctag>. ppocr/doctr stay true. */
  bool complete = true;
};

/** Prefer absolute override; otherwise `model_dir/canonical`. */
inline std::string OcrResolvePath(const std::string& override_path,
                                  const std::string& model_dir,
                                  const char* canonical) {
  if (!override_path.empty()) {
    return override_path;
  }
  if (model_dir.empty()) {
    return canonical ? std::string(canonical) : std::string();
  }
  std::string out = model_dir;
  if (!out.empty() && out.back() != '/' && out.back() != '\\') {
    out.push_back('/');
  }
  if (canonical) {
    out += canonical;
  }
  return out;
}

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
  /**
   * doc_vlm generation cap. 0 → 8192. Ignored by ppocr/doctr.
   * Phase 3 maps TS `docVlm.maxNewTokens` here.
   */
  int max_new_tokens = 0;

  /**
   * Absolute path overrides for custom init. Empty string → use
   * `JoinPath(model_dir, canonical_name)` in the backend.
   */
  std::string path_det;
  std::string path_rec;
  std::string path_cls;
  std::string path_rec_dict;
  std::string path_manifest;
  std::string path_vision_encoder;
  std::string path_vision_encoder_data;
  std::string path_embed_tokens;
  std::string path_embed_tokens_data;
  std::string path_decoder;
  std::string path_decoder_data;
  std::string path_tokenizer;
};

enum class OcrGranularity : uint8_t {
  kLine = 0,
  kWord = 1,
  kBlock = 2,
};

}  // namespace ocr
}  // namespace sherpa_onnx
