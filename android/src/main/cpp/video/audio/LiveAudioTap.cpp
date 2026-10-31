#include "audio/LiveAudioTap.h"

#include "VideoEntry.h"
#include "VideoLog.h"
#include "audio/AudioPacketReader.h"
#include "audio/FfmpegAudioDecoder.h"
#include "live/LiveVideoEntry.h"

#include <algorithm>
#include <vector>

namespace sherpa_onnx {
namespace video {

Status LiveAudioTap::Start(std::shared_ptr<VideoEntry> entry, int targetRate,
                           SamplesFn fn) {
  Stop();
  if (!entry || !entry->audioTrack() || !entry->audioTrack()->decodable) {
    return Status::Fail(kErrNoAudioTrack, "live tap");
  }
  entry_ = std::move(entry);
  fn_ = std::move(fn);
  targetRate_ = targetRate > 0 ? targetRate : 16000;
  run_.store(true);
  th_ = std::thread([this] { Loop(); });
  return Status::Ok();
}

void LiveAudioTap::Stop() {
  run_.store(false);
  if (th_.joinable()) th_.join();
}

void LiveAudioTap::Loop() {
  AudioPacketReader reader(entry_);
  FfmpegAudioDecoder decoder;
  auto st = decoder.Configure(*entry_->audioTrack(), 1);
  if (!st.ok) {
    VIDEO_LOGE("video.audio tap configure %s", st.errorMessage.c_str());
    return;
  }
  (void)reader.SeekTo(0);
  while (run_.load()) {
    auto pkt = reader.Next(50);
    if (!pkt.ok()) {
      auto live = std::dynamic_pointer_cast<LiveVideoEntry>(entry_);
      if (!live || live->state() != VideoBufferState::Recording) break;
      continue;
    }
    decoder.Submit(pkt.value);
    PcmChunk chunk;
    while (decoder.Receive(&chunk)) {
      if (fn_ && chunk.frames > 0) {
        std::vector<float> mono(static_cast<size_t>(chunk.frames));
        for (int i = 0; i < chunk.frames; ++i) {
          float s = 0;
          for (int c = 0; c < chunk.channels; ++c) {
            s += chunk.data[i * chunk.channels + c];
          }
          mono[static_cast<size_t>(i)] = s / std::max(chunk.channels, 1);
        }
        if (chunk.sampleRate != targetRate_ && chunk.sampleRate > 0) {
          const double ratio =
              static_cast<double>(targetRate_) / chunk.sampleRate;
          const int outN = std::max(1, static_cast<int>(chunk.frames * ratio));
          std::vector<float> rs(static_cast<size_t>(outN));
          for (int i = 0; i < outN; ++i) {
            const double src = i / ratio;
            int i0 = static_cast<int>(src);
            if (i0 >= chunk.frames) i0 = chunk.frames - 1;
            rs[static_cast<size_t>(i)] = mono[static_cast<size_t>(i0)];
          }
          fn_(rs.data(), outN, targetRate_);
        } else {
          fn_(mono.data(), chunk.frames, chunk.sampleRate);
        }
      }
      decoder.ReturnChunk(&chunk);
    }
  }
}

}  // namespace video
}  // namespace sherpa_onnx
