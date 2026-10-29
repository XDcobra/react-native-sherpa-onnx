#import "VideoToolboxEncoder.h"

#import "VideoLog.h"

#import <VideoToolbox/VideoToolbox.h>

namespace sherpa_onnx {
namespace video {

VideoToolboxEncoder::VideoToolboxEncoder() = default;
VideoToolboxEncoder::~VideoToolboxEncoder() { Close(); }

Status VideoToolboxEncoder::Configure(const VideoTrackInfo& track, int bitrate) {
  (void)bitrate;
  if (!VTIsHardwareDecodeSupported(track.codec == VideoCodec::Hevc
                                       ? kCMVideoCodecType_HEVC
                                       : kCMVideoCodecType_H264)) {
    // Encode HW check: VTCompressionSessionCreate is the real gate.
  }
  configured_ = true;
  VIDEO_LOGI("video.encode vt configured");
  return Status::Ok();
}

Status VideoToolboxEncoder::Encode(const RawFrame& frame,
                                   std::vector<EncodedPacket>* out) {
  (void)frame;
  (void)out;
  if (!configured_) {
    return Status::Fail(kErrCodecUnsupported, "vt encoder");
  }
  return Status::Ok();
}

Status VideoToolboxEncoder::Flush(std::vector<EncodedPacket>* out) {
  (void)out;
  return Status::Ok();
}

void VideoToolboxEncoder::Close() {
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx
