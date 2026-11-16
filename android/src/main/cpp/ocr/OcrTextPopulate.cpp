#include "OcrTextPopulate.h"

#include "../image/ImageRegistry.h"
#include "../textbuffer/TextRegistry.h"
#include "OcrTextData.h"

#include <memory>
#include <unordered_map>

namespace sherpa_onnx {
namespace ocr {

bool PopulateTextFromOcr(const std::string& text_buffer_id, const std::string& image_buffer_id,
                         const std::string& family, const OcrResult& result,
                         std::string* error_code, std::string* error_message) {
  auto& images = image::ImageRegistry::Instance();
  std::unordered_map<int, image::ImageFrameInfo> frame_info;
  auto info_of = [&](int frame) -> const image::ImageFrameInfo* {
    auto it = frame_info.find(frame);
    if (it == frame_info.end()) {
      image::ImageFrameInfo fi;
      if (!images.GetFrameInfo(image_buffer_id, frame, fi)) fi.index = -1;
      it = frame_info.emplace(frame, fi).first;
    }
    return it->second.index < 0 ? nullptr : &it->second;
  };

  const OcrTextData data = MakeOcrTextData(image_buffer_id, family, result, info_of);
  std::string populate_error;
  if (!txt_populate_offline_if_empty(text_buffer_id, result.text_utf8, {}, {}, {}, "", "", "",
                                     data.spans, &populate_error)) {
    if (error_code) *error_code = "OCR_ALREADY_POPULATED";
    if (error_message) {
      *error_message = populate_error.empty() ? "Text buffer already populated" : populate_error;
    }
    return false;
  }

  txt_set_offline_ocr_layout(text_buffer_id, data.layout);
  return true;
}

}  // namespace ocr
}  // namespace sherpa_onnx
