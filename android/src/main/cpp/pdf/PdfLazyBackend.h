#pragma once

#include "ImageTypes.h"

#include <string>

namespace sherpa_onnx {
namespace pdf {

/**
 * Retained PDF (or test fake) backend for lazy-lru OfflineImageBuffer slots.
 * ImageRegistry owns one backend per lazy buffer.
 */
class PdfLazyBackend {
 public:
  virtual ~PdfLazyBackend() = default;

  virtual int page_count() const = 0;
  virtual int dpi() const = 0;
  virtual int max_side() const = 0;

  /**
   * Rasterize one 1-based page into packed RGB8.
   * Sets pageNumber / dpi on the frame on success.
   */
  virtual bool RasterizePage(
      int page_1based,
      image::RgbFrame* out,
      std::string* err_code,
      std::string* err_message) = 0;
};

}  // namespace pdf
}  // namespace sherpa_onnx
