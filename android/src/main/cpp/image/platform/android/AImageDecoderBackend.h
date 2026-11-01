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
};

}  // namespace image
}  // namespace sherpa_onnx

#endif
