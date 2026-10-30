/**
 * Shared table model + GFM / plain rendering. Used by DocTags OTSL, Paddle
 * table/chart, and Nemotron LaTeX tabular.
 */
#pragma once

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

struct OcrTableCell {
  std::string text;
  int rowspan = 1;
  int colspan = 1;
};

struct OcrTable {
  std::vector<std::vector<OcrTableCell>> rows;

  std::string RenderGfm() const;
  std::string RenderPlain() const;
};

/** Parse GFM pipe tables, including headerless `A | B\\nC | D` chart output. */
OcrTable ParseGfmPipes(const std::string& text);

}  // namespace ocr
}  // namespace sherpa_onnx
