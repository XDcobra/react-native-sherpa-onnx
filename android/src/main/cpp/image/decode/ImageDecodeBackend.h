#pragma once

#include "ImageDecoder.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace image {

/**
 * Provider-shaped wrapper around the portable ImageDecoder (stb / libwebp).
 * Platform backends (AImageDecoder, ImageIO) implement the same surface in
 * later phases; this type is the portable / software origin.
 */
class ImageDecodeBackend {
 public:
  virtual ~ImageDecodeBackend() = default;
  virtual bool Supports(DecodeFormat format) const = 0;
  virtual DecodeResult Decode(const uint8_t* data, size_t size,
                              const DecodeOptions& opts) = 0;
  virtual const char* ProviderName() const = 0;
};

class StbImageDecodeBackend : public ImageDecodeBackend {
 public:
  bool Supports(DecodeFormat format) const override {
    return format != DecodeFormat::Heic && format != DecodeFormat::Unknown;
  }
  DecodeResult Decode(const uint8_t* data, size_t size,
                      const DecodeOptions& opts) override {
    return ImageDecoder::DecodeBytes(data, size, opts);
  }
  const char* ProviderName() const override { return "stb"; }
};

DecodeResult DecodeWithPolicy(const uint8_t* data, size_t size,
                              const DecodeOptions& opts,
                              const std::string& ownerKey);

void RegisterPlatformImageProviders();

inline void RegisterPortableImageProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Tier;
  for (const char* codec : {"jpeg", "png", "webp", "gif", "bmp"}) {
    Provider p;
    p.media = Media::Image;
    p.dir = Direction::Decode;
    p.codec = codec;
    p.tier = Tier::Software;
    p.origin = Origin::Bundled;
    p.name = "stb";
    CodecCatalog::Instance().Register(p);
  }
}

}  // namespace image
}  // namespace sherpa_onnx
