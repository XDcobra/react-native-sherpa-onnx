#include "live/LiveIngest.h"

#include "VideoLog.h"
#include "demux/FfmpegDemuxer.h"

#include <chrono>
#include <thread>

namespace sherpa_onnx {
namespace video {

Status LiveIngest::Run(const std::string& path, LiveVideoEntry* live,
                       const LiveIngestOptions& opts) {
  if (live == nullptr) {
    return Status::Fail(kErrInvalidArgument, "live");
  }
  FfmpegDemuxer demux;
  auto st = demux.Open(path);
  if (!st.ok) {
    return st;
  }
  st = live->SetCodecConfig(demux.track().codec, demux.track().codecConfig,
                            demux.track());
  if (!st.ok) {
    return st;
  }
  int64_t prevPts = 0;
  const int64_t n = demux.sampleCount();
  for (int64_t i = 0; i < n; ++i) {
    EncodedPacket pkt;
    st = demux.ReadPacket(i, &pkt);
    if (!st.ok) {
      return st;
    }
    if (opts.pacing == IngestPacing::Realtime && i > 0) {
      const int64_t dt = pkt.ptsUs - prevPts;
      if (dt > 0) {
        std::this_thread::sleep_for(std::chrono::microseconds(dt));
      }
    }
    prevPts = pkt.ptsUs;
    st = live->AppendPacket(pkt);
    if (!st.ok) {
      return st;
    }
  }
  VIDEO_LOGI("video.live ingest done frames=%lld", static_cast<long long>(n));
  return Status::Ok();
}

}  // namespace video
}  // namespace sherpa_onnx
