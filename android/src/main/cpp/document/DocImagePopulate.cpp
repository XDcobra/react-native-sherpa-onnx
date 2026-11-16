#include "DocImagePopulate.h"

#include <memory>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace document {

image::ImageRegistry::CreateResult CreateImageBufferFromDocument(ExtractImagesResult& result,
                                                                 int max_side, int hot_frames) {
  auto& registry = image::ImageRegistry::Instance();
  const bool lazy = !result.frames.empty() && result.frames.front().load;
  if (lazy) {
    image::DecodeOptions dec;
    dec.maxSide = max_side;
    auto backend = std::make_shared<image::ImageFileLazyBackend>(dec);
    std::vector<image::ImageRegistry::LazyFrameMeta> meta;
    meta.reserve(result.frames.size());
    for (auto& fr : result.frames) {
      backend->AddLoader(std::move(fr.load), fr.expected_width, fr.expected_height);
      image::ImageRegistry::LazyFrameMeta m;
      m.sectionIndex = fr.section_index;
      m.href = fr.href;
      m.pageNumber = fr.page_number;
      meta.push_back(std::move(m));
    }
    return registry.CreateLazyFromBackend(std::move(backend), meta,
                                          image::ImageThresholdPathType::FileOrigin, hot_frames);
  }
  std::vector<image::RgbFrame> frames;
  frames.reserve(result.frames.size());
  for (auto& fr : result.frames) {
    fr.rgb.sectionIndex = fr.section_index;
    fr.rgb.href = fr.href;
    fr.rgb.pageNumber = fr.page_number;
    frames.push_back(std::move(fr.rgb));
  }
  return registry.CreateFromRgbFrames(std::move(frames), image::ImageThresholdPathType::FileOrigin);
}

}  // namespace document
}  // namespace sherpa_onnx
