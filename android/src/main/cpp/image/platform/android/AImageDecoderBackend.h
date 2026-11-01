#pragma once

#ifdef __ANDROID__

#include "decode/ImageDecodeBackend.h"

namespace sherpa_onnx {
namespace image {

class AImageDecoderBackend : public ImageDecodeBackend {
 public:
  bool Supports(DecodeFormat format) const override;
  DecodeResult Decode(const uint8_t* data, size_t size,
                      const DecodeOptions& opts) override;
  const char* ProviderName() const override { return "AImageDecoder"; }

  /** Header-only HEIC/HEIF size. No RGB. API 30+. */
  static bool ProbeHeader(const uint8_t* data, size_t size, int* width,
                          int* height);
};

}  // namespace image
}  // namespace sherpa_onnx

#endif
