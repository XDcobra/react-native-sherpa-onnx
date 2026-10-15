#include "OcrTextUtils.h"

#include <cstdint>

namespace sherpa_onnx {
namespace ocr {

int Utf8ToUtf16Length(const std::string& utf8) {
  int units = 0;
  for (size_t i = 0; i < utf8.size();) {
    const unsigned char c = static_cast<unsigned char>(utf8[i]);
    size_t len = 1;
    uint32_t cp = c;
    if (c >= 0xF0) {
      len = 4;
      cp = (c & 0x07) << 18;
      if (i + 3 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 12;
        cp |= (static_cast<unsigned char>(utf8[i + 2]) & 0x3F) << 6;
        cp |= (static_cast<unsigned char>(utf8[i + 3]) & 0x3F);
      }
    } else if (c >= 0xE0) {
      len = 3;
      cp = (c & 0x0F) << 12;
      if (i + 2 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 6;
        cp |= (static_cast<unsigned char>(utf8[i + 2]) & 0x3F);
      }
    } else if (c >= 0xC0) {
      len = 2;
      cp = (c & 0x1F) << 6;
      if (i + 1 < utf8.size()) {
        cp |= (static_cast<unsigned char>(utf8[i + 1]) & 0x3F);
      }
    }
    units += (cp > 0xFFFF) ? 2 : 1;
    i += len;
  }
  return units;
}

}  // namespace ocr
}  // namespace sherpa_onnx
