#include "VideoImageBridge.h"

#include "VideoFrameAccess.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "image/ImageRegistry.h"
#include "image/ImageTypes.h"

#include <cstring>

namespace sherpa_onnx {
namespace video {

ImageBridgeResult VideoImageBridge::CreateImageBuffer(
    const std::string& videoBufferId, const ImageBridgeRequest& req) {
  ImageBridgeResult r;
  auto e = VideoRegistry::Instance().Get(videoBufferId);
  if (!e || e->timeline() == nullptr) {
    r.status = Status::Fail(kErrBufferNotFound, videoBufferId);
    return r;
  }
  IterateRequest ir;
  ir.startUs = req.startUs;
  ir.endUs = req.endUs;
  ir.sampling = req.sampling;
  ir.fps = req.fps;
  ir.uniformCount = req.uniformCount;
  ir.timesUs = req.timesUs;
  ir.format = VideoPixelFormat::Rgb24;
  ir.maxSide = req.maxSide;
  ir.applyTransform = true;
  ir.packed = true;
  VIDEO_LOGI(
      "video.image bridge start id=%s sampling=%d fps=%g maxSide=%d",
      videoBufferId.c_str(), static_cast<int>(req.sampling), req.fps,
      req.maxSide);
  auto itRes = VideoFrameAccess::Iterate(videoBufferId, ir);
  if (!itRes.ok()) {
    VIDEO_LOGE("video.image bridge iterate failed code=%s msg=%s",
               itRes.status.errorCode.c_str(),
               itRes.status.errorMessage.c_str());
    r.status = itRes.status;
    return r;
  }
  auto img = image::ImageRegistry::Instance().CreateEmpty();
  auto it = std::move(itRes.value);
  int count = 0;
  while (!it.done()) {
    auto lease = it.Next();
    if (!lease.ok() || !lease.value.valid()) {
      VIDEO_LOGE(
          "video.image bridge frame fail i=%d code=%s msg=%s", count,
          lease.status.errorCode.c_str(), lease.status.errorMessage.c_str());
      image::ImageRegistry::Instance().Release(img);
      r.status = lease.status;
      return r;
    }
    const auto& v = lease.value.view();
    image::RgbFrame frame;
    frame.width = v.width;
    frame.height = v.height;
    frame.sourceVideoBufferId = videoBufferId;
    frame.sourcePtsUs = v.ptsUs;
    frame.sourceFrameIndex = v.frameIndex;
    const int row = v.width * 3;
    frame.rgb.resize(static_cast<size_t>(row) * static_cast<size_t>(v.height));
    for (int y = 0; y < v.height; ++y) {
      std::memcpy(frame.rgb.data() + static_cast<size_t>(y) * row,
                  v.plane[0] + static_cast<size_t>(y) * v.stride[0],
                  static_cast<size_t>(row));
    }
    if (!image::ImageRegistry::Instance().AppendRgbFrame(
            img, std::move(frame), image::ImageThresholdPathType::HeapOrigin)) {
      image::ImageRegistry::Instance().Release(img);
      r.status = Status::Fail(kErrInvalidArgument, "append rgb");
      return r;
    }
    ++count;
  }
  r.imageBufferId = img;
  r.frameCount = count;
  VIDEO_LOGI("video.image bridge done frames=%d id=%s", count, img.c_str());
  return r;
}

}  // namespace video
}  // namespace sherpa_onnx
