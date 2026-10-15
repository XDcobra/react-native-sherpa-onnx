/**
 * Parse ocr_manifest.json for OnnxTR / doctr model packs.
 * Hand-rolled JSON (no external dependency) — parses family, det/rec shapes,
 * mean/std, and the rec vocab UTF-8 string into per-codepoint entries.
 */
#pragma once

#include <array>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doctr {

struct DoctrManifest {
  std::string family;

  // Det config
  std::string det_arch;
  int det_c = 3;
  int det_h = 1024;
  int det_w = 1024;
  std::array<float, 3> det_mean = {0.f, 0.f, 0.f};
  std::array<float, 3> det_std = {1.f, 1.f, 1.f};

  // Rec config
  std::string rec_arch;
  int rec_c = 3;
  int rec_h = 32;
  int rec_w = 128;
  std::array<float, 3> rec_mean = {0.f, 0.f, 0.f};
  std::array<float, 3> rec_std = {1.f, 1.f, 1.f};

  /** Per-codepoint vocab. Each entry is one UTF-8 encoded codepoint. */
  std::vector<std::string> rec_vocab;

  /** True if rec_arch looks like "parseq*" or "vitstr*". */
  bool IsParseq() const;
  /** True if rec_arch looks like "crnn*". */
  bool IsCrnn() const;
};

/**
 * Parse ocr_manifest.json from a model directory.
 * Throws std::runtime_error on missing/malformed file.
 */
DoctrManifest ParseDoctrManifest(const std::string& model_dir);

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
