#ifdef __ANDROID__

#include "platform/android/AImageDecoderBackend.h"

#include "ImageDecoder.h"

#include <android/bitmap.h>
#include <android/imagedecoder.h>

#include "libyuv/convert_from_argb.h"

#include <vector>

namespace sherpa_onnx {
namespace image {

bool AImageDecoderBackend::Supports(DecodeFormat format) const {
  return format != DecodeFormat::Unknown;
}

DecodeResult AImageDecoderBackend::Decode(const uint8_t* data, size_t size,
                                          const DecodeOptions& opts) {
  DecodeResult out;
  if (__builtin_available(android 30, *)) {
    AImageDecoder* dec = nullptr;
    int rc = AImageDecoder_createFromBuffer(data, size, &dec);
    if (rc != ANDROID_IMAGE_DECODER_SUCCESS || dec == nullptr) {
      out.errorCode = "ERR_IMAGE_DECODE_FAILED";
      out.errorMessage = "AImageDecoder_createFromBuffer";
      return out;
    }
    const AImageDecoderHeaderInfo* header = AImageDecoder_getHeaderInfo(dec);
    int w = AImageDecoderHeaderInfo_getWidth(header);
    int h = AImageDecoderHeaderInfo_getHeight(header);
    if (opts.maxSide > 0) {
      const int longest = w > h ? w : h;
      if (longest > opts.maxSide && longest > 0) {
        const int tw = w * opts.maxSide / longest;
        const int th = h * opts.maxSide / longest;
        AImageDecoder_setTargetSize(dec, tw > 0 ? tw : 1, th > 0 ? th : 1);
        w = tw > 0 ? tw : 1;
        h = th > 0 ? th : 1;
        out.scaleApplied =
            static_cast<float>(opts.maxSide) / static_cast<float>(longest);
      }
    }
    AImageDecoder_setAndroidBitmapFormat(dec, ANDROID_BITMAP_FORMAT_RGBA_8888);
    const size_t stride = static_cast<size_t>(w) * 4u;
    std::vector<uint8_t> rgba(stride * static_cast<size_t>(h));
    rc = AImageDecoder_decodeImage(dec, rgba.data(), stride, rgba.size());
    AImageDecoder_delete(dec);
    if (rc != ANDROID_IMAGE_DECODER_SUCCESS) {
      out.errorCode = "ERR_IMAGE_DECODE_FAILED";
      out.errorMessage = "AImageDecoder_decodeImage";
      return out;
    }
    out.frame.width = w;
    out.frame.height = h;
    out.frame.rgb.resize(static_cast<size_t>(w) * static_cast<size_t>(h) * 3u);
    // RGBA_8888 in memory is libyuv ABGR; ABGRToRAW drops A → packed RGB.
    libyuv::ABGRToRAW(rgba.data(), static_cast<int>(stride),
                      out.frame.rgb.data(), w * 3, w, h);
    out.ok = out.frame.valid();
    out.format = ImageDecoder::DetectFormat(data, size);
    return out;
  }
  out.errorCode = "ERR_IMAGE_HW_DECODER_UNAVAILABLE";
  out.errorMessage = "os-too-old";
  return out;
}

}  // namespace image
}  // namespace sherpa_onnx

#endif
