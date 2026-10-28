#include "DocComic.h"

#include "DocPath.h"
#include "decode/ImageDecoder.h"

#include <algorithm>

#if defined(__ANDROID__)
#include <android/log.h>
#define DOC_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:doc", __VA_ARGS__)
#else
#define DOC_LOGI(...) \
  do {                \
  } while (0)
#endif

namespace sherpa_onnx {
namespace document {

ExtractImagesResult ExtractComicImages(ArchiveReader& ar, const char* format,
                                       const ExtractOptions& opt) {
  ExtractImagesResult r;
  r.format = format ? format : "cbz";
  std::vector<size_t> indices;
  for (size_t i = 0; i < ar.catalog().size(); ++i) {
    const auto& e = ar.catalog()[i];
    if (IsHiddenOrMetaName(e.name)) {
      DOC_LOGI("comic skip meta %s", e.name.c_str());
      continue;
    }
    if (!LooksLikeImageName(e.name)) {
      DOC_LOGI("comic skip non-image %s", e.name.c_str());
      continue;
    }
    if (e.encrypted) {
      r.error_code = kErrDrm;
      r.error_message = "Encrypted comic archive entry";
      return r;
    }
    indices.push_back(i);
  }
  std::sort(indices.begin(), indices.end(), [&](size_t a, size_t b) {
    return NaturalCompare(ar.catalog()[a].name, ar.catalog()[b].name) < 0;
  });

  sherpa_onnx::image::DecodeOptions dec;
  dec.maxSide = opt.max_side;
  const int total = static_cast<int>(indices.size());
  int page = 0;
  for (int n = 0; n < total; ++n) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, n, total, "entry");
    const size_t idx = indices[static_cast<size_t>(n)];
    const std::string name = ar.catalog()[idx].name;
    std::string err_code;
    std::string err_msg;
    std::vector<uint8_t> bytes;
    if (!ar.ReadNamed(name, &bytes, &err_code, &err_msg)) {
      if (err_code == kErrDrm) {
        r.error_code = kErrDrm;
        r.error_message = err_msg;
        return r;
      }
      DOC_LOGI("comic read skip %s %s", name.c_str(), err_msg.c_str());
      continue;
    }
    auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
        bytes.data(), bytes.size(), dec);
    if (!decoded.ok) {
      DOC_LOGI("comic decode skip %s %s", name.c_str(),
               decoded.errorCode.c_str());
      continue;
    }
    ++page;
    DocImageFrame fr;
    fr.rgb = std::move(decoded.frame);
    fr.section_index = page - 1;
    fr.href = name;
    fr.page_number = page;
    r.frames.push_back(std::move(fr));
  }
  Progress(opt, total, total, "done");
  if (r.frames.empty()) {
    r.error_code = kErrNoImages;
    r.error_message = "No decodable images in comic archive";
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace document
}  // namespace sherpa_onnx
