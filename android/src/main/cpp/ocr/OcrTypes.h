/**
 * Shared OCR result / frame types — family-agnostic public contract for all backends.
 */
#pragma once

#include "markup/OcrElementKind.h"

#include <cstddef>
#include <cstdint>
#include <optional>
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

enum class OcrContentFormat : uint8_t {
  kMarkdown = 0,
  kPlain,
  kLatex,
  kCode,
};

inline const char* OcrContentFormatName(OcrContentFormat format) {
  switch (format) {
    case OcrContentFormat::kMarkdown:
      return "markdown";
    case OcrContentFormat::kPlain:
      return "plain";
    case OcrContentFormat::kLatex:
      return "latex";
    case OcrContentFormat::kCode:
      return "code";
  }
  return "markdown";
}

struct OcrContent {
  OcrContentFormat format = OcrContentFormat::kMarkdown;
  std::string value;
  std::string language;
};

struct OcrLayoutElement {
  OcrElementKind kind = OcrElementKind::kText;
  int frame_index = 0;
  bool has_quad = false;
  OcrQuad quad{};
  bool has_utf16 = false;
  int utf16_start = 0;
  int utf16_end = 0;
  std::optional<int> heading_level;
  std::optional<bool> checked;
};

struct OcrResult {
  std::string text_utf8;
  std::vector<OcrSpan> spans;
  /**
   * Family markup stream (always the decoder output). doc_vlm: DocTags.
   * nemotron_parse: xy/class tags. paddleocr_vl: decoded tokens.
   * Empty for ppocr/doctr. Kept when a parser rejects the stream.
   */
  std::string raw_utf8;
  bool has_content = false;
  OcrContent content;
  std::vector<OcrLayoutElement> elements;
  /**
   * VLM stop: doctag_end | eos | max_new_tokens | invalid_sequence.
   * invalid_sequence: Granite prefix/prompt-only reject. raw=accepted
   * (default) stops decode; raw=full continues so raw_utf8 is complete.
   * Empty for ppocr/doctr.
   */
  std::string stop_reason;
  /** VLM: true after a natural stop (</doctag> or EOS). ppocr/doctr stay true. */
  bool complete = true;
  /** Serialized recognize spec echoed to JS (`v1;family=…`). */
  std::string instruction_spec;
};

inline void SetOcrContent(OcrResult& result, OcrContentFormat format,
                          std::string value, std::string language = {}) {
  result.has_content = true;
  result.content.format = format;
  result.content.value = std::move(value);
  result.content.language = std::move(language);
}

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

/** Negative = omit; `Load` applies the family default. Never remap an explicit value. */
inline constexpr float kOcrDetThreshUnspecified = -1.f;
inline constexpr float kPpocrDetBoxThresh = 0.3f;
inline constexpr float kPpocrDetBoxScoreThresh = 0.5f;
inline constexpr float kDoctrDetBoxThresh = 0.15f;
inline constexpr float kDoctrDetBoxScoreThresh = 0.15f;

inline float ResolveOcrDetThresh(float value, float family_default) {
  return value < 0.f ? family_default : value;
}

struct OcrLoadOptions {
  int num_threads = 4;
  /** Longest side for det resize (PP-OCR style). */
  int max_side_len = 960;
  bool use_orientation_cls = true;
  float det_box_thresh = kOcrDetThreshUnspecified;
  float det_box_score_thresh = kOcrDetThreshUnspecified;
  float det_unclip_ratio = 1.5f;
  std::string provider;
  /**
   * VLM generation cap (`doc_vlm` / `nemotron_parse` / `paddleocr_vl`). 0 → 8192.
   * Ignored by ppocr/doctr.
   */
  int max_new_tokens = 0;
  /**
   * paddleocr_vl smart_resize area cap. 0 → 1003520. Ignored by other families.
   */
  int max_pixels = 0;
  std::string quantization;

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
  std::string path_embedding;
  std::string path_embedding_data;
  std::string path_decoder;
  std::string path_decoder_data;
  std::string path_tokenizer;
  std::string path_patch_embed;
  std::string path_patch_embed_data;
  std::string path_pos_embed;
};

enum class OcrGranularity : uint8_t {
  kLine = 0,
  kWord = 1,
  kBlock = 2,
};

inline bool IsOcrVlmFamily(const std::string& family) {
  return family == "doc_vlm" || family == "nemotron_parse" ||
         family == "paddleocr_vl";
}

}  // namespace ocr
}  // namespace sherpa_onnx
