#include "audio/VideoAudioExtractor.h"

#include "VideoEntry.h"
#include "VideoLog.h"
#include "audio/AudioPacketReader.h"
#include "audio/FfmpegAudioDecoder.h"
#include "core/FileIo.h"
#include "core/Uuid.h"
#include "live/LiveVideoEntry.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <vector>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}
#endif

namespace sherpa_onnx {
namespace video {

namespace {

bool Cancelled(std::atomic<bool>* flag) {
  return flag != nullptr && flag->load();
}

void DownmixToMono(const PcmChunk& chunk, std::vector<float>* mono) {
  mono->resize(static_cast<size_t>(chunk.frames));
  if (chunk.channels <= 1) {
    std::copy(chunk.data, chunk.data + chunk.frames, mono->begin());
    return;
  }
  for (int i = 0; i < chunk.frames; ++i) {
    float acc = 0.f;
    for (int c = 0; c < chunk.channels; ++c) {
      acc += chunk.data[i * chunk.channels + c];
    }
    (*mono)[static_cast<size_t>(i)] = acc / static_cast<float>(chunk.channels);
  }
}

}  // namespace

Status VideoAudioExtractor::Run(std::shared_ptr<VideoEntry> entry,
                                const AudioExtractOptions& opts,
                                const std::string& outPath,
                                std::atomic<bool>* cancel, ProgressFn progress,
                                AudioExtractResult* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "extract result");
  }
  *out = AudioExtractResult{};
  if (!entry) {
    return Status::Fail(kErrBufferNotFound, "extract");
  }
  if (entry->state() == VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "recording live has no export");
  }
#ifndef HAVE_FFMPEG
  (void)opts;
  (void)outPath;
  (void)cancel;
  (void)progress;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  const AudioTrackInfo* track = entry->audioTrack();
  const AudioTimeline* tl = entry->audioTimeline();
  if (track == nullptr || tl == nullptr || tl->empty()) {
    return Status::Fail(kErrNoAudioTrack, "extract");
  }
  if (!track->decodable) {
    return Status::Fail(kErrAudioCodecUnsupported,
                        std::string("codec=") +
                            (track->codecName.empty()
                                 ? AudioCodecName(track->codec)
                                 : track->codecName.c_str()));
  }
  if (Cancelled(cancel)) {
    return Status::Fail(kErrCancelled, "extract");
  }

  int64_t rangeStart = opts.rangeStartUs;
  int64_t rangeEnd = opts.rangeEndUs;
  const int64_t audioStart = tl->startUs();
  const int64_t audioEnd = tl->endUs();
  if (rangeEnd < 0) {
    rangeEnd = audioEnd;
  }
  if (rangeStart < audioStart) {
    rangeStart = audioStart;
  }
  if (rangeEnd <= rangeStart) {
    return Status::Fail(kErrInvalidArgument, "empty extract range");
  }

  const int targetRate =
      opts.targetSampleRate > 0 ? opts.targetSampleRate : track->sampleRate;
  if (targetRate <= 0) {
    return Status::Fail(kErrInvalidArgument, "target sample rate");
  }

  AudioPacketReader reader(entry);
  auto seekSt = reader.SeekTo(rangeStart);
  if (!seekSt.ok) {
    return seekSt;
  }

  FfmpegAudioDecoder decoder;
  auto cfg = decoder.Configure(*track, 2);
  if (!cfg.ok) {
    return cfg;
  }

  SwrContext* swr = nullptr;
  AVChannelLayout inLayout;
  AVChannelLayout outLayout;
  av_channel_layout_default(&inLayout, 1);
  av_channel_layout_default(&outLayout, 1);
  const int swrRet = swr_alloc_set_opts2(
      &swr, &outLayout, AV_SAMPLE_FMT_FLT, targetRate, &inLayout,
      AV_SAMPLE_FMT_FLT, track->sampleRate, 0, nullptr);
  av_channel_layout_uninit(&inLayout);
  av_channel_layout_uninit(&outLayout);
  if (swrRet < 0 || swr == nullptr || swr_init(swr) < 0) {
    if (swr) {
      swr_free(&swr);
    }
    return Status::Fail(kErrAudioDecodeFailed, "extract swr");
  }

  FileIo& io = DefaultFileIo();
  const int fd = io.Open(outPath.c_str(), O_CREAT | O_WRONLY | O_TRUNC, 0644);
  if (fd < 0) {
    swr_free(&swr);
    return Status::Fail(kErrSpoolIo, "open extract f32");
  }

  int64_t written = 0;
  int64_t writeOff = 0;
  bool started = false;
  const int64_t mediaStartUs = rangeStart;
  std::vector<float> mono;
  std::vector<float> resampled;
  Status fail = Status::Ok();
  bool eos = false;

  auto writeConverted = [&](const float* in, int inFrames) -> bool {
    if (inFrames <= 0) {
      return true;
    }
    const uint8_t* inPtr = reinterpret_cast<const uint8_t*>(in);
    int maxOut = swr_get_out_samples(swr, inFrames);
    if (maxOut < 0) {
      maxOut = inFrames;
    }
    resampled.resize(static_cast<size_t>(std::max(maxOut, 1)));
    uint8_t* outPtr = reinterpret_cast<uint8_t*>(resampled.data());
    const int got =
        swr_convert(swr, &outPtr, maxOut, &inPtr, inFrames);
    if (got < 0) {
      fail = Status::Fail(kErrAudioDecodeFailed, "extract swr_convert");
      return false;
    }
    if (got == 0) {
      return true;
    }
    const size_t bytes = static_cast<size_t>(got) * sizeof(float);
    const int64_t n =
        io.Pwrite(fd, resampled.data(), bytes, writeOff);
    if (n != static_cast<int64_t>(bytes)) {
      fail = Status::Fail(kErrSpoolIo, "extract pwrite");
      return false;
    }
    writeOff += n;
    written += got;
    return true;
  };

  auto drainDecoder = [&]() {
    PcmChunk chunk;
    while (decoder.Receive(&chunk)) {
      DownmixToMono(chunk, &mono);
      int begin = 0;
      int end = chunk.frames;
      const double usPer = 1000000.0 / static_cast<double>(chunk.sampleRate);
      if (chunk.ptsUs < rangeStart) {
        const int64_t skip =
            static_cast<int64_t>(
                std::llround(static_cast<double>(rangeStart - chunk.ptsUs) /
                             usPer));
        begin = static_cast<int>(std::min<int64_t>(
            std::max<int64_t>(skip, 0), chunk.frames));
      }
      const int64_t chunkEndUs =
          chunk.ptsUs +
          (static_cast<int64_t>(chunk.frames) * 1000000LL) / chunk.sampleRate;
      if (chunkEndUs > rangeEnd) {
        const int64_t keep =
            static_cast<int64_t>(
                std::llround(static_cast<double>(rangeEnd - chunk.ptsUs) /
                             usPer));
        end = static_cast<int>(std::max<int64_t>(
            0, std::min<int64_t>(keep, chunk.frames)));
      }
      if (end > begin) {
        if (!started) {
          started = true;
        }
        if (!writeConverted(mono.data() + begin, end - begin)) {
          decoder.ReturnChunk(&chunk);
          return false;
        }
      }
      decoder.ReturnChunk(&chunk);
      if (chunkEndUs >= rangeEnd) {
        eos = true;
        return true;
      }
    }
    return true;
  };

  while (!eos) {
    if (Cancelled(cancel)) {
      fail = Status::Fail(kErrCancelled, "extract");
      break;
    }
    auto pkt = reader.Next(0);
    if (!pkt.ok()) {
      EncodedPacket empty;
      decoder.Submit(empty);
      drainDecoder();
      // flush resampler delay
      resampled.resize(1024);
      uint8_t* outPtr = reinterpret_cast<uint8_t*>(resampled.data());
      int got = 0;
      do {
        got = swr_convert(swr, &outPtr, 1024, nullptr, 0);
        if (got > 0) {
          const size_t bytes = static_cast<size_t>(got) * sizeof(float);
          const int64_t n = io.Pwrite(fd, resampled.data(), bytes, writeOff);
          if (n != static_cast<int64_t>(bytes)) {
            fail = Status::Fail(kErrSpoolIo, "extract pwrite flush");
            break;
          }
          writeOff += n;
          written += got;
        }
      } while (got > 0);
      break;
    }
    auto st = decoder.Submit(pkt.value);
    if (!st.ok) {
      fail = st;
      break;
    }
    if (!drainDecoder()) {
      break;
    }
    if (progress) {
      const int64_t now = pkt.value.ptsUs;
      int pct = 0;
      if (rangeEnd > rangeStart) {
        pct = static_cast<int>(
            std::clamp((now - rangeStart) * 100 / (rangeEnd - rangeStart),
                       static_cast<int64_t>(0), static_cast<int64_t>(100)));
      }
      progress(pct, (now - mediaStartUs) / 1000);
    }
  }

  io.Close(fd);
  swr_free(&swr);

  if (!fail.ok) {
    io.Unlink(outPath.c_str());
    return fail;
  }
  if (written <= 0) {
    io.Unlink(outPath.c_str());
    return Status::Fail(kErrAudioDecodeFailed, "no samples in range");
  }

  out->numSamples = written;
  out->sampleRate = targetRate;
  out->mediaStartUs = mediaStartUs;
  out->sourceCodec =
      track->codecName.empty() ? AudioCodecName(track->codec) : track->codecName;
  out->sourceSampleRate = track->sampleRate;
  out->sourceChannels = track->channels;
  out->path = outPath;
  VIDEO_LOGI(
      "video.audio extract samples=%lld rate=%d startUs=%lld codec=%s path=%s",
      static_cast<long long>(written), targetRate,
      static_cast<long long>(mediaStartUs), out->sourceCodec.c_str(),
      outPath.c_str());
  if (progress) {
    progress(100, (rangeEnd - mediaStartUs) / 1000);
  }
  return Status::Ok();
#endif
}

}  // namespace video
}  // namespace sherpa_onnx
