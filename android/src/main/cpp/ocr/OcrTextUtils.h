#pragma once

#include <string>

namespace sherpa_onnx {
namespace ocr {

/** UTF-8 → UTF-16 code unit count (BMP + surrogate pairs). */
int Utf8ToUtf16Length(const std::string& utf8);

}  // namespace ocr
}  // namespace sherpa_onnx
