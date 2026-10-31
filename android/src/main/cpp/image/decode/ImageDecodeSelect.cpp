#include "decode/ImageDecodeBackend.h"

#include "codec/CodecArbiter.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecSelector.h"

#ifdef __ANDROID__
#include "platform/android/AImageDecoderBackend.h"
#endif
#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#include "imagebuffer/ImageIODecodeBackend.h"
#endif
#endif

#include <memory>

namespace sherpa_onnx {
namespace image {

namespace {

std::unique_ptr<ImageDecodeBackend> OpenImageProvider(
    const sherpa_onnx::codec::Provider& p) {
  if (p.name == "stb" || p.origin == sherpa_onnx::codec::Origin::Bundled) {
    return std::make_unique<StbImageDecodeBackend>();
  }
#if defined(__APPLE__) && TARGET_OS_IPHONE
  if (p.name == "ImageIO") {
    return std::make_unique<ImageIODecodeBackend>();
  }
#endif
#ifdef __ANDROID__
  if (p.name == "AImageDecoder") {
    return std::make_unique<AImageDecoderBackend>();
  }
  if (p.name == "ImageDecoder.java") {
    class HeicHookBackend : public ImageDecodeBackend {
     public:
      bool Supports(DecodeFormat format) const override {
        return format == DecodeFormat::Heic;
      }
      DecodeResult Decode(const uint8_t* data, size_t size,
                          const DecodeOptions& opts) override {
        return ImageDecoder::DecodeHeicBytes(data, size, opts);
      }
      const char* ProviderName() const override { return "ImageDecoder.java"; }
    };
    return std::make_unique<HeicHookBackend>();
  }
#endif
  return nullptr;
}

}  // namespace

void RegisterPlatformImageProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Reason;
  using sherpa_onnx::codec::Tier;
  auto add = [](const char* name, const char* codec, bool avail, Reason reason) {
    Provider p;
    p.media = Media::Image;
    p.dir = Direction::Decode;
    p.codec = codec;
    p.tier = Tier::Hardware;
    p.origin = Origin::Platform;
    p.name = name;
    p.available = avail;
    p.unavailableReason = reason;
    p.rank = 0;
    CodecCatalog::Instance().Register(std::move(p));
  };
#ifdef __ANDROID__
  bool aid = false;
  bool api28 = false;
  if (__builtin_available(android 30, *)) {
    aid = true;
    api28 = true;
  } else if (__builtin_available(android 28, *)) {
    api28 = true;
  }
  for (const char* codec : {"jpeg", "png", "webp", "gif", "bmp", "heic"}) {
    add("AImageDecoder", codec, aid,
        aid ? Reason::None : Reason::OsTooOld);
  }
  add("ImageDecoder.java", "heic", api28 && !aid,
      api28 ? Reason::None : Reason::OsTooOld);
#endif
  CodecCatalog::Instance().SetRank("stb", 1);
}

DecodeResult DecodeWithPolicy(const uint8_t* data, size_t size,
                              const DecodeOptions& opts,
                              const std::string& ownerKey) {
  RegisterPortableImageProviders();
  const DecodeFormat format = ImageDecoder::DetectFormat(data, size);
  if (format == DecodeFormat::Unknown) {
    DecodeResult r;
    r.errorCode = "ERR_IMAGE_DECODE_FAILED";
    r.errorMessage = "unknown format";
    return r;
  }

  sherpa_onnx::codec::Request req;
  req.media = sherpa_onnx::codec::Media::Image;
  req.dir = sherpa_onnx::codec::Direction::Decode;
  req.use = sherpa_onnx::codec::Use::Cpu;
  req.stream.codec = DecodeFormatName(format);
  req.policy = sherpa_onnx::codec::CodecRuntime::Instance().ResolveImage(
      sherpa_onnx::codec::ParsePolicy(opts.decodePolicy), std::nullopt);
  req.ownerKey = ownerKey.empty() ? "image" : ownerKey;

  const auto found = sherpa_onnx::codec::CodecCatalog::Instance().Find(
      sherpa_onnx::codec::Media::Image, sherpa_onnx::codec::Direction::Decode,
      req.stream.codec);
  if (found.empty()) {
    if (format == DecodeFormat::Heic) {
      return ImageDecoder::DecodeHeicBytes(data, size, opts);
    }
    return ImageDecoder::DecodeBytes(data, size, opts);
  }

  auto selected = sherpa_onnx::codec::Select<ImageDecodeBackend>(
      req, sherpa_onnx::codec::CodecArbiter::Instance(),
      [&](const sherpa_onnx::codec::Provider& p) {
        sherpa_onnx::codec::Result<std::unique_ptr<ImageDecodeBackend>> opened;
        auto backend = OpenImageProvider(p);
        if (!backend || !backend->Supports(format)) {
          opened.status = sherpa_onnx::codec::Status::Fail(
              p.tier == sherpa_onnx::codec::Tier::Software
                  ? sherpa_onnx::codec::kErrImageSwDecoderUnavailable
                  : sherpa_onnx::codec::kErrImageHwDecoderUnavailable,
              "open image");
          return opened;
        }
        opened.value = std::move(backend);
        return opened;
      });
  if (!selected.ok() || !selected.backend) {
    if (format == DecodeFormat::Heic) {
      auto heic = ImageDecoder::DecodeHeicBytes(data, size, opts);
      if (heic.ok) return heic;
    }
    DecodeResult r;
    r.errorCode = selected.status.errorCode.empty()
                      ? "ERR_IMAGE_DECODE_FAILED"
                      : selected.status.errorCode;
    r.errorMessage = selected.status.errorMessage;
    return r;
  }
  DecodeResult decoded = selected.backend->Decode(data, size, opts);
  decoded.codecProvider = selected.decision.provider;
  decoded.codecTier = sherpa_onnx::codec::TierName(selected.decision.tier);
  decoded.codecOrigin = sherpa_onnx::codec::OriginName(selected.decision.origin);
  return decoded;
}

}  // namespace image
}  // namespace sherpa_onnx
