#pragma once

#include "OcrTypes.h"

#include "../image/ImageTypes.h"
#include "../textbuffer/TxtLiveEntry.h"
#include "../textbuffer/TxtOcrLayout.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {

/** What a recognize result stores on its text buffer, besides the text. */
struct OcrTextData {
  std::vector<TxtSpatialSpan> spans;
  std::shared_ptr<TxtOcrLayout> layout;
};

/**
 * Spans (with the source frame's page number, section, href and video time
 * from `frame_info`, which may return null) and the OCR layout (frame ranges,
 * elements) of a recognize result. Pure: no registries.
 */
OcrTextData MakeOcrTextData(
    const std::string& image_buffer_id, const std::string& family, const OcrResult& result,
    const std::function<const image::ImageFrameInfo*(int frame)>& frame_info);

}  // namespace ocr
}  // namespace sherpa_onnx
