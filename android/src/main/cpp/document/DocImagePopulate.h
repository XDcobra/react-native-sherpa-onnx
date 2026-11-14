#pragma once

#include "DocTypes.h"

#include "ImageRegistry.h"

namespace sherpa_onnx {
namespace document {

/**
 * Image buffer from an image extraction, shared by the iOS and Android
 * bridges. Decoded frames become a RAM / mmap buffer; lazy frames
 * (DocImageFrame::load) become a lazy-lru buffer that decodes pages on demand
 * and knows their sizes up front. `hot_frames` (lazy only) is clamped to 1..32.
 */
image::ImageRegistry::CreateResult CreateImageBufferFromDocument(ExtractImagesResult& result,
                                                                 int max_side, int hot_frames);

}  // namespace document
}  // namespace sherpa_onnx
