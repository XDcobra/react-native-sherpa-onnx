#pragma once

#ifdef __ANDROID__

#include "encode/ImageEncodeBackend.h"

namespace sherpa_onnx {
namespace image {

bool AndroidBitmapCompressAvailable();

class AndroidBitmapEncodeBackend : public ImageEncodeBackend {
 public:
  bool Supports(ExportFormat format) const override;
  ExportResult Encode(const uint8_t* rgb, int width, int height,
                      const std::string& path, int quality,
                      ExportFormat format) override;
  const char* ProviderName() const override { return "AndroidBitmap"; }
};

}  // namespace image
}  // namespace sherpa_onnx

#endif
