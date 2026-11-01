#pragma once

#include "ImageFrameEncoder.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace image {

class ImageEncodeBackend {
 public:
  virtual ~ImageEncodeBackend() = default;
  virtual bool Supports(ExportFormat format) const = 0;
  virtual ExportResult Encode(const uint8_t* rgb, int width, int height,
                              const std::string& path, int quality,
                              ExportFormat format) = 0;
  virtual const char* ProviderName() const = 0;
};

class StbImageEncodeBackend : public ImageEncodeBackend {
 public:
  bool Supports(ExportFormat format) const override {
    return format == ExportFormat::Jpeg || format == ExportFormat::Png;
  }
  ExportResult Encode(const uint8_t* rgb, int width, int height,
                      const std::string& path, int quality,
                      ExportFormat format) override;
  const char* ProviderName() const override { return "stb"; }
};

class LibwebpImageEncodeBackend : public ImageEncodeBackend {
 public:
  bool Supports(ExportFormat format) const override {
    return format == ExportFormat::Webp;
  }
  ExportResult Encode(const uint8_t* rgb, int width, int height,
                      const std::string& path, int quality,
                      ExportFormat format) override;
  const char* ProviderName() const override { return "libwebp"; }
};

ExportResult EncodeRgbBytesWithPolicy(const uint8_t* rgb, int width, int height,
                                      const std::string& outPath,
                                      const ExportOptions& opts);

void RegisterPlatformImageEncodeProviders();

inline void RegisterPortableImageEncodeProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Reason;
  using sherpa_onnx::codec::Tier;
  for (const char* codec : {"jpeg", "png"}) {
    Provider p;
    p.media = Media::Image;
    p.dir = Direction::Encode;
    p.codec = codec;
    p.tier = Tier::Software;
    p.origin = Origin::Bundled;
    p.name = "stb";
    CodecCatalog::Instance().Register(p);
  }
  Provider webp;
  webp.media = Media::Image;
  webp.dir = Direction::Encode;
  webp.codec = "webp";
  webp.tier = Tier::Software;
  webp.origin = Origin::Bundled;
  webp.name = "libwebp";
#if defined(HAVE_LIBWEBP)
  webp.available = true;
#else
  webp.available = false;
  webp.unavailableReason = Reason::Disabled;
#endif
  CodecCatalog::Instance().Register(std::move(webp));
}

}  // namespace image
}  // namespace sherpa_onnx
