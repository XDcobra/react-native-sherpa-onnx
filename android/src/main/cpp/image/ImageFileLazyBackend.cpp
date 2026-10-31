#include "ImageFileLazyBackend.h"

#include "decode/ImageDecodeBackend.h"
#include "decode/ImageDecoder.h"

#include <fstream>

namespace sherpa_onnx {
namespace image {

ImageFileLazyBackend::ImageFileLazyBackend(DecodeOptions opts) : opts_(opts) {}

void ImageFileLazyBackend::AddPath(std::string path) {
  Slot slot;
  slot.path = std::move(path);
  slots_.push_back(std::move(slot));
}

void ImageFileLazyBackend::AddBytes(std::vector<uint8_t> bytes) {
  Slot slot;
  slot.bytes = std::move(bytes);
  slots_.push_back(std::move(slot));
}

int ImageFileLazyBackend::frame_count() const {
  return static_cast<int>(slots_.size());
}

bool ImageFileLazyBackend::DecodeFrame(int index, RgbFrame* out,
                                       std::string* err_code,
                                       std::string* err_message) {
  auto fail = [&](const char* code, const std::string& msg) {
    if (err_code) *err_code = code;
    if (err_message) *err_message = msg;
    return false;
  };
  if (!out) {
    return fail("ERR_IMAGE_INVALID_ARGUMENT", "out required");
  }
  if (index < 0 || index >= static_cast<int>(slots_.size())) {
    return fail("ERR_IMAGE_INVALID_ARGUMENT", "frame index out of range");
  }

  const Slot& slot = slots_[static_cast<size_t>(index)];
  const uint8_t* data = nullptr;
  size_t size = 0;
  std::vector<uint8_t> owned;
  if (!slot.path.empty()) {
    std::ifstream in(slot.path, std::ios::binary);
    if (!in) {
      return fail("ERR_IMAGE_DECODE_FAILED", "cannot open file: " + slot.path);
    }
    in.seekg(0, std::ios::end);
    const auto len = in.tellg();
    if (len <= 0) {
      return fail("ERR_IMAGE_DECODE_FAILED", "empty file: " + slot.path);
    }
    in.seekg(0, std::ios::beg);
    owned.resize(static_cast<size_t>(len));
    if (!in.read(reinterpret_cast<char*>(owned.data()), len)) {
      return fail("ERR_IMAGE_DECODE_FAILED", "read failed: " + slot.path);
    }
    data = owned.data();
    size = owned.size();
  } else {
    if (slot.bytes.empty()) {
      return fail("ERR_IMAGE_DECODE_FAILED", "empty image bytes");
    }
    data = slot.bytes.data();
    size = slot.bytes.size();
  }

  decode_count_.fetch_add(1);
  DecodeResult decoded = DecodeWithPolicy(data, size, opts_, "img");
  if (!decoded.ok) {
    return fail(decoded.errorCode.empty() ? "ERR_IMAGE_DECODE_FAILED"
                                          : decoded.errorCode.c_str(),
                decoded.errorMessage);
  }
  lastProvider_ = decoded.codecProvider;
  lastTier_ = decoded.codecTier;
  lastOrigin_ = decoded.codecOrigin;
  *out = std::move(decoded.frame);
  return true;
}

}  // namespace image
}  // namespace sherpa_onnx
