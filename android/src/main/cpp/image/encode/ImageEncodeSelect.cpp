#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "decode/vendor/stb_image_write.h"

#include "encode/ImageEncodeBackend.h"

#include "codec/CodecEvents.h"
#include "codec/CodecLog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecRuntime.h"

#ifdef __ANDROID__
#include "platform/android/AndroidBitmapEncodeBackend.h"
#endif
#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#include "imagebuffer/ImageIOEncodeBackend.h"
#endif
#endif

#include <cstdio>
#include <fstream>
#include <memory>

#if defined(HAVE_LIBWEBP)
#include <webp/encode.h>
#endif

namespace sherpa_onnx {
namespace image {
namespace {

ExportResult FailEncode(const char* code, const std::string& message) {
  ExportResult r;
  r.ok = false;
  r.errorCode = code;
  r.errorMessage = message;
  return r;
}

ExportResult OkEncode() {
  ExportResult r;
  r.ok = true;
  return r;
}

int ClampQuality(int q) {
  if (q < 1) return 1;
  if (q > 100) return 100;
  return q;
}

#if defined(HAVE_LIBWEBP)
bool WriteBytesToFile(const std::string& path, const uint8_t* data, size_t size) {
  if (!data || size == 0) return false;
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out.write(reinterpret_cast<const char*>(data),
            static_cast<std::streamsize>(size));
  return static_cast<bool>(out);
}
#endif

struct StbStreamCtx {
  std::ofstream* out = nullptr;
  bool ok = true;
};

void StbStreamCallback(void* context, void* data, int size) {
  auto* ctx = static_cast<StbStreamCtx*>(context);
  if (!ctx || !ctx->out || !ctx->ok || !data || size <= 0) return;
  ctx->out->write(reinterpret_cast<const char*>(data),
                  static_cast<std::streamsize>(size));
  if (!*ctx->out) ctx->ok = false;
}

std::unique_ptr<ImageEncodeBackend> OpenEncodeProvider(
    const sherpa_onnx::codec::Provider& p) {
  if (p.name == "stb") {
    return std::make_unique<StbImageEncodeBackend>();
  }
  if (p.name == "libwebp") {
    return std::make_unique<LibwebpImageEncodeBackend>();
  }
#if defined(__APPLE__) && TARGET_OS_IPHONE
  if (p.name == "ImageIO") {
    return std::make_unique<ImageIOEncodeBackend>();
  }
#endif
#ifdef __ANDROID__
  if (p.name == "AndroidBitmap") {
    return std::make_unique<AndroidBitmapEncodeBackend>();
  }
#endif
  return nullptr;
}

void AttachDecision(ExportResult* r, const sherpa_onnx::codec::Provider& p) {
  if (!r) return;
  r->codecProvider = p.name;
  r->codecTier = sherpa_onnx::codec::TierName(p.tier);
  r->codecOrigin = sherpa_onnx::codec::OriginName(p.origin);
}

sherpa_onnx::codec::Plan FilterWebpPreferLibwebp(
    sherpa_onnx::codec::Plan plan) {
#if defined(HAVE_LIBWEBP)
  sherpa_onnx::codec::Plan filtered;
  filtered.skipped = std::move(plan.skipped);
  for (const auto& step : plan.steps) {
    if (!step.provider) continue;
    if (step.provider->tier == sherpa_onnx::codec::Tier::Software) {
      filtered.steps.push_back(step);
      continue;
    }
    sherpa_onnx::codec::Attempt a;
    a.provider = step.provider->name;
    a.tier = step.provider->tier;
    a.origin = step.provider->origin;
    a.reason = sherpa_onnx::codec::Reason::Disabled;
    a.code = sherpa_onnx::codec::kErrImageWebpDisabled;
    filtered.skipped.push_back(std::move(a));
  }
  return filtered;
#else
  return plan;
#endif
}

ExportResult EmptyPlanError(const sherpa_onnx::codec::Request& req,
                            const sherpa_onnx::codec::Plan& plan,
                            ExportFormat format) {
  sherpa_onnx::codec::Reason reason = sherpa_onnx::codec::Reason::NotPresent;
  sherpa_onnx::codec::Tier tier = req.policy == sherpa_onnx::codec::Policy::Software
                                      ? sherpa_onnx::codec::Tier::Software
                                      : sherpa_onnx::codec::Tier::Hardware;
  if (!plan.skipped.empty()) {
    reason = plan.skipped.back().reason;
    tier = plan.skipped.back().tier;
  }
  if (format == ExportFormat::Webp) {
    if (req.policy == sherpa_onnx::codec::Policy::Hardware) {
      return FailEncode(sherpa_onnx::codec::kErrImageHwEncoderUnavailable,
                        "platform WebP encoder unavailable");
    }
#if !defined(HAVE_LIBWEBP)
    return FailEncode(
        sherpa_onnx::codec::kErrImageWebpDisabled,
        "libwebp is not linked. Rebuild with sherpaOnnxEnableLibwebp=true "
        "(Android) or SHERPA_ONNX_ENABLE_LIBWEBP=1 (iOS) and ensure libwebp "
        "prebuilts resolve.");
#endif
  }
  return FailEncode(sherpa_onnx::codec::ErrorCodeFor(req, reason, tier),
                    sherpa_onnx::codec::ReasonName(reason));
}

}  // namespace

ExportResult StbImageEncodeBackend::Encode(const uint8_t* rgb, int width,
                                           int height, const std::string& path,
                                           int quality, ExportFormat format) {
  if (!rgb || width <= 0 || height <= 0) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  if (path.empty()) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "empty output path");
  }
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "failed to open output file");
  }
  StbStreamCtx ctx;
  ctx.out = &out;
  int ok = 0;
  if (format == ExportFormat::Jpeg) {
    ok = stbi_write_jpg_to_func(StbStreamCallback, &ctx, width, height, 3, rgb,
                                quality);
  } else if (format == ExportFormat::Png) {
    ok = stbi_write_png_to_func(StbStreamCallback, &ctx, width, height, 3, rgb,
                                width * 3);
  } else {
    return FailEncode("ERR_IMAGE_SW_ENCODER_UNAVAILABLE",
                      "stb does not encode this format");
  }
  if (!ok || !ctx.ok || !out) {
    out.close();
    std::remove(path.c_str());
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "stb encode failed");
  }
  return OkEncode();
}

ExportResult LibwebpImageEncodeBackend::Encode(const uint8_t* rgb, int width,
                                               int height,
                                               const std::string& path,
                                               int quality,
                                               ExportFormat format) {
  if (format != ExportFormat::Webp) {
    return FailEncode("ERR_IMAGE_SW_ENCODER_UNAVAILABLE",
                      "libwebp encodes WebP only");
  }
#if defined(HAVE_LIBWEBP)
  if (!rgb || width <= 0 || height <= 0) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  uint8_t* encoded = nullptr;
  const size_t encodedSize = WebPEncodeRGB(
      rgb, width, height, width * 3, static_cast<float>(quality), &encoded);
  if (encodedSize == 0 || !encoded) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "WebP encode failed");
  }
  const bool written = WriteBytesToFile(path, encoded, encodedSize);
  WebPFree(encoded);
  if (!written) {
    return FailEncode("ERR_IMAGE_ENCODE_FAILED", "failed to write WebP file");
  }
  return OkEncode();
#else
  (void)rgb;
  (void)width;
  (void)height;
  (void)path;
  (void)quality;
  return FailEncode(
      sherpa_onnx::codec::kErrImageWebpDisabled,
      "libwebp is not linked. Rebuild with sherpaOnnxEnableLibwebp=true "
      "(Android) or SHERPA_ONNX_ENABLE_LIBWEBP=1 (iOS) and ensure libwebp "
      "prebuilts resolve.");
#endif
}

void RegisterPlatformImageEncodeProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Reason;
  using sherpa_onnx::codec::Tier;
  auto add = [](const char* name, const char* codec, bool avail,
                Reason reason) {
    Provider p;
    p.media = Media::Image;
    p.dir = Direction::Encode;
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
  const bool bitmap = AndroidBitmapCompressAvailable();
  const Reason bitmapReason = bitmap ? Reason::None : Reason::OsTooOld;
  for (const char* codec : {"jpeg", "png", "webp"}) {
    add("AndroidBitmap", codec, bitmap, bitmapReason);
  }
#endif
#if defined(__APPLE__) && TARGET_OS_IPHONE
  for (const char* codec : {"jpeg", "png", "heic"}) {
    add("ImageIO", codec, true, Reason::None);
  }
#endif
  CodecCatalog::Instance().SetRank("stb", 1);
}

ExportResult EncodeRgbBytesWithPolicy(const uint8_t* rgb, int width, int height,
                                      const std::string& outPath,
                                      const ExportOptions& opts) {
  if (!rgb || width <= 0 || height <= 0) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "invalid RGB frame");
  }
  if (outPath.empty()) {
    return FailEncode("ERR_IMAGE_INVALID_ARGUMENT", "empty output path");
  }

  RegisterPortableImageEncodeProviders();
  RegisterPlatformImageEncodeProviders();

  sherpa_onnx::codec::Request req;
  req.media = sherpa_onnx::codec::Media::Image;
  req.dir = sherpa_onnx::codec::Direction::Encode;
  req.use = sherpa_onnx::codec::Use::Export;
  req.stream.codec = ExportFormatName(opts.format);
  req.policy = sherpa_onnx::codec::CodecRuntime::Instance().ResolveImageEncode(
      sherpa_onnx::codec::ParsePolicy(opts.encodePolicy), std::nullopt);
  req.ownerKey = "image-encode";

  sherpa_onnx::codec::Plan plan =
      sherpa_onnx::codec::MakePlan(req, sherpa_onnx::codec::CodecCatalog::Instance());
  if (opts.format == ExportFormat::Webp &&
      req.policy == sherpa_onnx::codec::Policy::PreferHardware) {
    plan = FilterWebpPreferLibwebp(std::move(plan));
  }

  CODEC_LOGI("image.encode format=%s policy=%s steps=%zu skipped=%zu",
             req.stream.codec.c_str(),
             sherpa_onnx::codec::PolicyName(req.policy), plan.steps.size(),
             plan.skipped.size());

  if (plan.steps.empty()) {
    return EmptyPlanError(req, plan, opts.format);
  }

  const int quality = ClampQuality(opts.quality);
  bool sawHwFail = false;
  std::string fromCode;
  sherpa_onnx::codec::Reason fromReason = sherpa_onnx::codec::Reason::None;
  ExportResult last = FailEncode("ERR_IMAGE_ENCODE_FAILED", "no encoder");

  for (const auto& step : plan.steps) {
    const sherpa_onnx::codec::Provider* p = step.provider;
    if (!p) continue;
    auto backend = OpenEncodeProvider(*p);
    if (!backend || !backend->Supports(opts.format)) {
      if (p->tier == sherpa_onnx::codec::Tier::Hardware) {
        sawHwFail = true;
        fromCode = sherpa_onnx::codec::ErrorCodeFor(
            req, sherpa_onnx::codec::Reason::UnsupportedStream, p->tier);
        fromReason = sherpa_onnx::codec::Reason::UnsupportedStream;
      }
      last = FailEncode(sherpa_onnx::codec::ErrorCodeFor(
                            req, sherpa_onnx::codec::Reason::UnsupportedStream,
                            p->tier),
                        "encoder does not support format");
      continue;
    }
    last = backend->Encode(rgb, width, height, outPath, quality, opts.format);
    if (last.ok) {
      AttachDecision(&last, *p);
      if (sawHwFail && p->tier == sherpa_onnx::codec::Tier::Software) {
        sherpa_onnx::codec::Decision d;
        d.tier = p->tier;
        d.origin = p->origin;
        d.provider = p->name;
        d.fellBack = true;
        d.fallbackReason = fromReason;
        d.fallbackCode = fromCode;
        sherpa_onnx::codec::EmitFallback(req.ownerKey,
                                         sherpa_onnx::codec::Use::Cpu, d);
      }
      CODEC_LOGI("image.encode.ok provider=%s tier=%s origin=%s",
                 last.codecProvider.c_str(), last.codecTier.c_str(),
                 last.codecOrigin.c_str());
      return last;
    }
    if (p->tier == sherpa_onnx::codec::Tier::Hardware) {
      sawHwFail = true;
      fromCode = last.errorCode;
      fromReason = sherpa_onnx::codec::Reason::ConfigureFailed;
    }
  }
  if (last.errorCode.empty()) {
    return EmptyPlanError(req, plan, opts.format);
  }
  return last;
}

}  // namespace image
}  // namespace sherpa_onnx
