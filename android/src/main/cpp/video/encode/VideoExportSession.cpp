#include "encode/VideoExportSession.h"

#include "VideoFrameAccess.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "audio/VideoAudioExtractor.h"
#include "core/Uuid.h"
#include "demux/BitstreamUtil.h"
#include "encode/EncoderBackend.h"
#include "live/LiveVideoEntry.h"

#include <algorithm>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <unistd.h>
#include <vector>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}
#endif

namespace sherpa_onnx {
namespace video {
namespace {

#ifdef HAVE_FFMPEG
bool Cancelled(std::atomic<bool>* flag) {
  return flag != nullptr && flag->load();
}

void EvenDim(int* v) {
  if (*v < 2) {
    *v = 2;
  }
  *v &= ~1;
}

void OutputSize(const VideoTrackInfo& track, int maxSide, int* w, int* h) {
  int dw = track.displayWidth > 0 ? track.displayWidth : track.codedWidth;
  int dh = track.displayHeight > 0 ? track.displayHeight : track.codedHeight;
  int rot = track.transform.rotationDegrees % 360;
  if (rot < 0) {
    rot += 360;
  }
  if (rot == 90 || rot == 270) {
    std::swap(dw, dh);
  }
  if (maxSide > 0) {
    const int longest = std::max(dw, dh);
    if (longest > maxSide && longest > 0) {
      dw = std::max(2, dw * maxSide / longest);
      dh = std::max(2, dh * maxSide / longest);
    }
  }
  EvenDim(&dw);
  EvenDim(&dh);
  *w = dw;
  *h = dh;
}

int FpsFrom(const Timeline* tl, const VideoTrackInfo& track) {
  if (track.nominalFps.num > 0 && track.nominalFps.den > 0) {
    const int fps =
        (track.nominalFps.num + track.nominalFps.den / 2) / track.nominalFps.den;
    return std::max(1, fps);
  }
  if (tl && tl->frameCount() > 1) {
    const int64_t dur = tl->endUs() - tl->startUs();
    if (dur > 0) {
      return std::max(
          1, static_cast<int>((tl->frameCount() * 1000000LL) / dur));
    }
  }
  return 30;
}

RawFrame ViewToRaw(const VideoFrameView& view) {
  RawFrame f;
  f.ptsUs = view.ptsUs;
  f.nv12.width = view.width;
  f.nv12.height = view.height;
  f.nv12.y.data = view.plane[0];
  f.nv12.y.stride = view.stride[0];
  f.nv12.uv.data = view.plane[1];
  f.nv12.uv.stride = view.stride[1];
  return f;
}

void ParseAnnexBNals(const uint8_t* data, size_t size,
                     std::vector<std::vector<uint8_t>>* nals) {
  nals->clear();
  size_t i = 0;
  auto start = [&](size_t p) -> int {
    if (p + 3 < size && data[p] == 0 && data[p + 1] == 0 && data[p + 2] == 1) {
      return 3;
    }
    if (p + 4 <= size && data[p] == 0 && data[p + 1] == 0 && data[p + 2] == 0 &&
        data[p + 3] == 1) {
      return 4;
    }
    return 0;
  };
  while (i < size) {
    int sc = start(i);
    if (sc == 0) {
      ++i;
      continue;
    }
    i += static_cast<size_t>(sc);
    size_t begin = i;
    size_t j = i;
    while (j < size && start(j) == 0) {
      ++j;
    }
    if (j > begin) {
      nals->emplace_back(data + begin, data + j);
    }
    i = j;
  }
}

std::vector<uint8_t> MakeAvcc(const std::vector<uint8_t>& csd) {
  if (csd.size() >= 7 && csd[0] == 1) {
    return csd;
  }
  if (!BitstreamUtil::LooksAnnexB(csd.data(), csd.size())) {
    return csd;
  }
  std::vector<std::vector<uint8_t>> nals;
  ParseAnnexBNals(csd.data(), csd.size(), &nals);
  std::vector<uint8_t> sps;
  std::vector<uint8_t> pps;
  for (const auto& n : nals) {
    if (n.empty()) {
      continue;
    }
    const uint8_t type = n[0] & 0x1f;
    if (type == 7 && sps.empty()) {
      sps = n;
    } else if (type == 8 && pps.empty()) {
      pps = n;
    }
  }
  if (sps.empty() || pps.empty()) {
    return csd;
  }
  std::vector<uint8_t> avcc;
  avcc.push_back(1);
  avcc.push_back(sps.size() > 1 ? sps[1] : 0x42);
  avcc.push_back(sps.size() > 2 ? sps[2] : 0);
  avcc.push_back(sps.size() > 3 ? sps[3] : 0x1e);
  avcc.push_back(0xff);
  avcc.push_back(0xe1);
  avcc.push_back(static_cast<uint8_t>((sps.size() >> 8) & 0xff));
  avcc.push_back(static_cast<uint8_t>(sps.size() & 0xff));
  avcc.insert(avcc.end(), sps.begin(), sps.end());
  avcc.push_back(1);
  avcc.push_back(static_cast<uint8_t>((pps.size() >> 8) & 0xff));
  avcc.push_back(static_cast<uint8_t>(pps.size() & 0xff));
  avcc.insert(avcc.end(), pps.begin(), pps.end());
  return avcc;
}

Status PacketToAvcc(EncodedPacket* pkt) {
  if (pkt->payload.empty()) {
    return Status::Ok();
  }
  if (BitstreamUtil::LooksAvcc(pkt->payload.data(), pkt->payload.size())) {
    return Status::Ok();
  }
  if (!BitstreamUtil::LooksAnnexB(pkt->payload.data(), pkt->payload.size())) {
    return Status::Ok();
  }
  std::vector<uint8_t> avcc;
  auto st = BitstreamUtil::AnnexBToAvcc(pkt->payload.data(), pkt->payload.size(),
                                        &avcc);
  if (!st.ok) {
    return st;
  }
  pkt->payload = std::move(avcc);
  return Status::Ok();
}

const char* MuxerName(const std::string& format) {
  if (format == "mp4") {
    return "mp4";
  }
  if (format == "mov") {
    return av_guess_format("mov", nullptr, nullptr) != nullptr ? "mov" : nullptr;
  }
  if (format == "mkv" || format == "webm") {
    return "matroska";
  }
  return nullptr;
}

bool FormatWantsAac(const std::string& format) {
  return format == "mp4" || format == "mov";
}

struct AvFmt {
  AVFormatContext* fmt = nullptr;
  bool header = false;
  ~AvFmt() {
    if (fmt) {
      if (header) {
        VIDEO_LOGI("video.export trailer");
        av_write_trailer(fmt);
        VIDEO_LOGI("video.export trailer done");
      }
      if (fmt->pb) {
        avio_closep(&fmt->pb);
      }
      avformat_free_context(fmt);
    }
  }
};

Status WriteVideoPacket(AVFormatContext* fmt, AVStream* vs,
                        EncodedPacket pkt, int64_t durationUs) {
  auto st = PacketToAvcc(&pkt);
  if (!st.ok) {
    return st;
  }
  AVPacket* avpkt = av_packet_alloc();
  if (!avpkt) {
    return Status::Fail(kErrEncodeFailed, "av_packet_alloc");
  }
  if (av_new_packet(avpkt, static_cast<int>(pkt.payload.size())) < 0) {
    av_packet_free(&avpkt);
    return Status::Fail(kErrEncodeFailed, "av_new_packet");
  }
  std::memcpy(avpkt->data, pkt.payload.data(), pkt.payload.size());
  avpkt->pts = pkt.ptsUs;
  avpkt->dts = pkt.dtsUs != 0 ? pkt.dtsUs : pkt.ptsUs;
  avpkt->duration = durationUs > 0 ? durationUs : 33333;
  avpkt->stream_index = vs->index;
  if (pkt.flags & kSampleKey) {
    avpkt->flags |= AV_PKT_FLAG_KEY;
  }
  av_packet_rescale_ts(avpkt, AVRational{1, 1000000}, vs->time_base);
  const int wr = av_interleaved_write_frame(fmt, avpkt);
  av_packet_free(&avpkt);
  if (wr < 0) {
    return Status::Fail(kErrEncodeFailed, "write video packet");
  }
  return Status::Ok();
}

Status MuxAudioFromPcm(AVFormatContext* fmt, AVStream* as, AVCodecContext* enc,
                       SwrContext* swr, const std::string& pcmPath, int srcRate,
                       std::atomic<bool>* cancel) {
  const int fd = open(pcmPath.c_str(), O_RDONLY);
  if (fd < 0) {
    return Status::Fail(kErrSpoolIo, "open pcm");
  }
  std::vector<float> in(static_cast<size_t>(enc->frame_size > 0 ? enc->frame_size
                                                                : 1024) *
                        8);
  AVFrame* frame = av_frame_alloc();
  AVPacket* pkt = av_packet_alloc();
  if (!frame || !pkt) {
    if (frame) av_frame_free(&frame);
    if (pkt) av_packet_free(&pkt);
    close(fd);
    return Status::Fail(kErrEncodeFailed, "audio frame alloc");
  }
  frame->format = enc->sample_fmt;
  frame->sample_rate = enc->sample_rate;
  frame->nb_samples = enc->frame_size > 0 ? enc->frame_size : 1024;
#if LIBAVUTIL_VERSION_MAJOR >= 57
  av_channel_layout_copy(&frame->ch_layout, &enc->ch_layout);
#else
  frame->channel_layout = enc->channel_layout;
  frame->channels = enc->channels;
#endif
  if (av_frame_get_buffer(frame, 0) < 0) {
    av_frame_free(&frame);
    av_packet_free(&pkt);
    close(fd);
    return Status::Fail(kErrEncodeFailed, "audio frame buffer");
  }

  int64_t samplesSent = 0;
  Status fail = Status::Ok();
  auto receive = [&]() -> bool {
    for (;;) {
      const int r = avcodec_receive_packet(enc, pkt);
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) {
        return true;
      }
      if (r < 0) {
        fail = Status::Fail(kErrEncodeFailed, "audio receive");
        return false;
      }
      pkt->stream_index = as->index;
      av_packet_rescale_ts(pkt, enc->time_base, as->time_base);
      if (av_interleaved_write_frame(fmt, pkt) < 0) {
        av_packet_unref(pkt);
        fail = Status::Fail(kErrEncodeFailed, "write audio packet");
        return false;
      }
      av_packet_unref(pkt);
    }
  };

  for (;;) {
    if (Cancelled(cancel)) {
      fail = Status::Fail(kErrCancelled, "export audio");
      break;
    }
    const size_t want = static_cast<size_t>(frame->nb_samples) * sizeof(float);
    const ssize_t n = read(fd, in.data(), want);
    if (n < 0) {
      fail = Status::Fail(kErrSpoolIo, "read pcm");
      break;
    }
    if (n == 0) {
      break;
    }
    const int inSamples = static_cast<int>(static_cast<size_t>(n) / sizeof(float));
    const uint8_t* inPtr = reinterpret_cast<const uint8_t*>(in.data());
    uint8_t* outPtr = frame->data[0];
    const int got = swr_convert(swr, &outPtr, frame->nb_samples, &inPtr, inSamples);
    if (got < 0) {
      fail = Status::Fail(kErrEncodeFailed, "audio swr");
      break;
    }
    if (got == 0) {
      continue;
    }
    frame->nb_samples = got;
    frame->pts = samplesSent;
    samplesSent += got;
    if (avcodec_send_frame(enc, frame) < 0) {
      fail = Status::Fail(kErrEncodeFailed, "audio send");
      break;
    }
    if (!receive()) {
      break;
    }
    frame->nb_samples = enc->frame_size > 0 ? enc->frame_size : 1024;
  }
  if (fail.ok) {
    avcodec_send_frame(enc, nullptr);
    receive();
  }
  av_frame_free(&frame);
  av_packet_free(&pkt);
  close(fd);
  return fail;
}

#endif  // HAVE_FFMPEG

}  // namespace

Status VideoExportSession::Run(const std::string& bufferId,
                               const std::string& outPath,
                               const std::string& format,
                               const VideoExportOptions& opts,
                               std::atomic<bool>* cancel, ProgressFn progress) {
  if (bufferId.empty() || outPath.empty()) {
    return Status::Fail(kErrInvalidArgument, "export path");
  }
  if (format != "mp4" && format != "mov" && format != "mkv" &&
      format != "webm") {
    return Status::Fail(kErrInvalidArgument, "export format");
  }
  auto entry = VideoRegistry::Instance().Get(bufferId);
  if (!entry) {
    return Status::Fail(kErrBufferNotFound, bufferId);
  }
  if (entry->state() == VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "recording live has no export");
  }
  if (!entry->timeline() || entry->timeline()->empty()) {
    return Status::Fail(kErrInvalidArgument, "empty timeline");
  }
#ifndef HAVE_FFMPEG
  (void)opts;
  (void)cancel;
  (void)progress;
  return Status::Fail(kErrFfmpegDisabled, "exportVideo mux");
#else
  if (Cancelled(cancel)) {
    return Status::Fail(kErrCancelled, "export");
  }

  const VideoTrackInfo& srcTrack = entry->packets()->track();
  int outW = 0;
  int outH = 0;
  OutputSize(srcTrack, opts.maxSide, &outW, &outH);
  const int fps = FpsFrom(entry->timeline(), srcTrack);
  const int64_t frameDurUs = std::max(1, 1000000 / fps);

  int64_t fromUs = opts.fromUs;
  int64_t toUs = opts.toUs;
  const int64_t tlStart = entry->timeline()->startUs();
  const int64_t tlEnd = entry->timeline()->endUs();
  if (fromUs < tlStart) {
    fromUs = tlStart;
  }
  if (toUs < 0) {
    toUs = tlEnd;
  }
  if (toUs <= fromUs) {
    return Status::Fail(kErrInvalidArgument, "empty export range");
  }
  const int64_t rangeUs = toUs - fromUs;

  auto factory = GetEncoderFactory();
  auto encoder = factory ? factory() : nullptr;
  if (!encoder) {
    return Status::Fail(kErrEncoderUnavailable, "no encoder factory");
  }
  VideoTrackInfo encTrack = srcTrack;
  encTrack.codec = opts.codec;
  encTrack.codedWidth = outW;
  encTrack.codedHeight = outH;
  encTrack.displayWidth = outW;
  encTrack.displayHeight = outH;
  encTrack.nominalFps = {fps, 1};
  encTrack.transform = {};
  auto cfg = encoder->Configure(encTrack, opts.bitrate);
  if (!cfg.ok) {
    encoder->Close();
    return cfg;
  }

  if (!entry->StickySession()) {
    encoder->Close();
    return Status::Fail(kErrDecoderUnavailable, "cpu decoder busy");
  }

  IterateRequest ireq;
  ireq.startUs = fromUs;
  ireq.endUs = toUs;
  ireq.sampling = SamplingMode::All;
  ireq.format = VideoPixelFormat::Nv12;
  ireq.maxSide = opts.maxSide;
  ireq.applyTransform = true;
  ireq.packed = true;
  auto itRes = VideoFrameAccess::Iterate(bufferId, ireq);
  if (!itRes.ok()) {
    encoder->Close();
    return itRes.status;
  }
  VideoFrameIterator it = std::move(itRes.value);

  std::vector<EncodedPacket> pending;
  int64_t lastPts = fromUs;
  auto emitProgress = [&](int64_t pts) {
    lastPts = pts;
    if (!progress) {
      return;
    }
    int pct = 0;
    if (rangeUs > 0) {
      pct = static_cast<int>(
          std::min<int64_t>(100, ((pts - fromUs) * 100) / rangeUs));
    }
    progress(pct, pts);
  };

  auto encodeLease = [&](const VideoFrameLease& lease,
                         std::vector<EncodedPacket>* dest) -> Status {
    const VideoFrameView& view = lease.view();
    if (view.format != VideoPixelFormat::Nv12 || view.plane[0] == nullptr ||
        view.plane[1] == nullptr) {
      return Status::Fail(kErrDecodeFailed, "export nv12");
    }
    return encoder->Encode(ViewToRaw(view), dest);
  };

  // Prime encoder until codec-config is available (or a few frames are encoded).
  int primed = 0;
  while (encoder->CodecConfig().empty() && !it.done() && primed < 8) {
    if (Cancelled(cancel)) {
      encoder->Close();
      return Status::Fail(kErrCancelled, "export");
    }
    auto lease = it.Next();
    if (!lease.ok()) {
      encoder->Close();
      return lease.status;
    }
    auto st = encodeLease(lease.value, &pending);
    if (!st.ok) {
      encoder->Close();
      return st;
    }
    ++primed;
  }
  if (encoder->CodecConfig().empty() && pending.empty()) {
    encoder->Close();
    return Status::Fail(kErrEncodeFailed, "encoder produced no config");
  }

  const char* muxer = MuxerName(format);
  if (muxer == nullptr) {
    encoder->Close();
    if (format == "mov") {
      return Status::Fail(kErrEncodeFailed,
                          "mov muxer unavailable in this FFmpeg build");
    }
    return Status::Fail(kErrInvalidArgument, "muxer");
  }

  AvFmt av;
  if (avformat_alloc_output_context2(&av.fmt, nullptr, muxer, outPath.c_str()) <
          0 ||
      av.fmt == nullptr) {
    encoder->Close();
    return Status::Fail(kErrEncodeFailed, "alloc muxer");
  }
  AVStream* vs = avformat_new_stream(av.fmt, nullptr);
  if (!vs) {
    encoder->Close();
    return Status::Fail(kErrEncodeFailed, "video stream");
  }
  vs->time_base = AVRational{1, 1000000};
  vs->codecpar->codec_type = AVMEDIA_TYPE_VIDEO;
  vs->codecpar->codec_id =
      opts.codec == VideoCodec::Hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264;
  vs->codecpar->width = outW;
  vs->codecpar->height = outH;
  vs->codecpar->format = AV_PIX_FMT_YUV420P;
  vs->codecpar->bit_rate = opts.bitrate > 0 ? opts.bitrate : 2'000'000;
  std::vector<uint8_t> extradata = encoder->CodecConfig();
  if (opts.codec == VideoCodec::H264) {
    extradata = MakeAvcc(extradata);
  }
  if (!extradata.empty()) {
    vs->codecpar->extradata = static_cast<uint8_t*>(
        av_mallocz(extradata.size() + AV_INPUT_BUFFER_PADDING_SIZE));
    if (!vs->codecpar->extradata) {
      encoder->Close();
      return Status::Fail(kErrEncodeFailed, "extradata");
    }
    std::memcpy(vs->codecpar->extradata, extradata.data(), extradata.size());
    vs->codecpar->extradata_size = static_cast<int>(extradata.size());
  }

  const bool wantAudio = entry->audioTrack() != nullptr &&
                         entry->audioTrack()->decodable &&
                         entry->audioTimeline() != nullptr &&
                         !entry->audioTimeline()->empty();
  AVStream* as = nullptr;
  AVCodecContext* aenc = nullptr;
  SwrContext* swr = nullptr;
  std::string pcmPath;
  int pcmRate = 0;
  struct AudioCleanup {
    AVCodecContext** aenc;
    SwrContext** swr;
    std::string* path;
    ~AudioCleanup() {
      if (aenc && *aenc) {
        avcodec_free_context(aenc);
      }
      if (swr && *swr) {
        swr_free(swr);
      }
      if (path && !path->empty()) {
        unlink(path->c_str());
      }
    }
  } audioCleanup{&aenc, &swr, &pcmPath};

  if (wantAudio) {
    AudioExtractOptions aopts;
    aopts.rangeStartUs = fromUs;
    aopts.rangeEndUs = toUs;
    aopts.targetSampleRate = entry->audioTrack()->sampleRate > 0
                                 ? entry->audioTrack()->sampleRate
                                 : 48000;
    const std::string dir = VideoRegistry::Instance().cacheDir();
    pcmPath = (dir.empty() ? std::string("/tmp") : dir) + "/vid_exp_" +
              UuidV4() + ".f32";
    AudioExtractResult ares;
    auto ast = VideoAudioExtractor::Run(entry, aopts, pcmPath, cancel, nullptr,
                                        &ares);
    if (!ast.ok || ares.numSamples <= 0) {
      VIDEO_LOGI("video.export skip audio code=%s", ast.errorCode.c_str());
      unlink(pcmPath.c_str());
      pcmPath.clear();
    } else {
      pcmRate = ares.sampleRate > 0 ? ares.sampleRate : aopts.targetSampleRate;
      const bool aac = FormatWantsAac(format);
      const AVCodec* codec =
          avcodec_find_encoder(aac ? AV_CODEC_ID_AAC : AV_CODEC_ID_OPUS);
      if (!codec) {
        VIDEO_LOGI("video.export no audio encoder, video-only");
        unlink(pcmPath.c_str());
        pcmPath.clear();
      } else {
        aenc = avcodec_alloc_context3(codec);
        if (!aenc) {
          encoder->Close();
          return Status::Fail(kErrEncodeFailed, "audio enc alloc");
        }
        aenc->sample_rate = aac ? pcmRate : 48000;
        aenc->bit_rate = aac ? 128000 : 64000;
#if LIBAVUTIL_VERSION_MAJOR >= 57
        av_channel_layout_default(&aenc->ch_layout, 1);
#else
        aenc->channel_layout = AV_CH_LAYOUT_MONO;
        aenc->channels = 1;
#endif
        aenc->sample_fmt = AV_SAMPLE_FMT_FLTP;
#if defined(AV_CODEC_CONFIG_SAMPLE_FORMAT)
        {
          const void* fmtConfigs = nullptr;
          int fmtNum = 0;
          avcodec_get_supported_config(aenc, codec, AV_CODEC_CONFIG_SAMPLE_FORMAT,
                                       0, &fmtConfigs, &fmtNum);
          if (fmtConfigs && fmtNum > 0) {
            aenc->sample_fmt =
                static_cast<const AVSampleFormat*>(fmtConfigs)[0];
          }
        }
#endif
        aenc->time_base = AVRational{1, aenc->sample_rate};
        if (avcodec_open2(aenc, codec, nullptr) < 0) {
          encoder->Close();
          return Status::Fail(kErrEncodeFailed, "audio enc open");
        }
        VIDEO_LOGI("video.export audio enc %s fmt=%d rate=%d frame=%d",
                   codec->name ? codec->name : "?",
                   static_cast<int>(aenc->sample_fmt), aenc->sample_rate,
                   aenc->frame_size);
        as = avformat_new_stream(av.fmt, nullptr);
        if (!as) {
          encoder->Close();
          return Status::Fail(kErrEncodeFailed, "audio stream");
        }
        if (avcodec_parameters_from_context(as->codecpar, aenc) < 0) {
          encoder->Close();
          return Status::Fail(kErrEncodeFailed, "audio params");
        }
        as->time_base = aenc->time_base;
        AVChannelLayout inLayout;
        AVChannelLayout outLayout;
        av_channel_layout_default(&inLayout, 1);
        av_channel_layout_copy(&outLayout, &aenc->ch_layout);
        const int sr = swr_alloc_set_opts2(
            &swr, &outLayout, aenc->sample_fmt, aenc->sample_rate, &inLayout,
            AV_SAMPLE_FMT_FLT, pcmRate, 0, nullptr);
        av_channel_layout_uninit(&inLayout);
        av_channel_layout_uninit(&outLayout);
        if (sr < 0 || swr == nullptr || swr_init(swr) < 0) {
          encoder->Close();
          return Status::Fail(kErrEncodeFailed, "audio swr");
        }
      }
    }
  }

  if (avio_open(&av.fmt->pb, outPath.c_str(), AVIO_FLAG_WRITE) < 0) {
    encoder->Close();
    return Status::Fail(kErrSpoolIo, "avio_open");
  }
  if (avformat_write_header(av.fmt, nullptr) < 0) {
    encoder->Close();
    return Status::Fail(kErrEncodeFailed, "write header");
  }
  av.header = true;

  for (auto& pkt : pending) {
    auto st = WriteVideoPacket(av.fmt, vs, std::move(pkt), frameDurUs);
    if (!st.ok) {
      encoder->Close();
      return st;
    }
  }
  pending.clear();
  emitProgress(lastPts);

  while (!it.done()) {
    if (Cancelled(cancel)) {
      encoder->Close();
      return Status::Fail(kErrCancelled, "export");
    }
    auto lease = it.Next();
    if (!lease.ok()) {
      encoder->Close();
      return lease.status;
    }
    std::vector<EncodedPacket> pkts;
    auto st = encodeLease(lease.value, &pkts);
    if (!st.ok) {
      encoder->Close();
      return st;
    }
    for (auto& pkt : pkts) {
      const int64_t pts = pkt.ptsUs;
      auto wr = WriteVideoPacket(av.fmt, vs, std::move(pkt), frameDurUs);
      if (!wr.ok) {
        encoder->Close();
        return wr;
      }
      emitProgress(pts);
    }
    if (pkts.empty()) {
      emitProgress(lease.value.view().ptsUs);
    }
  }

  std::vector<EncodedPacket> flushed;
  auto fl = encoder->Flush(&flushed);
  encoder->Close();
  if (!fl.ok) {
    return fl;
  }
  for (auto& pkt : flushed) {
    const int64_t pts = pkt.ptsUs;
    auto wr = WriteVideoPacket(av.fmt, vs, std::move(pkt), frameDurUs);
    if (!wr.ok) {
      return wr;
    }
    emitProgress(pts);
  }

  // Drop the HW decoder (AImageReader) before Opus mux / return-to-JS so Mali
  // is not holding GraphicBuffers while HWUI redraws the File I/O result.
  it = VideoFrameIterator();
  entry->DropStickySession();
  VIDEO_LOGI("video.export decoder released format=%s", format.c_str());

  if (as && aenc && swr && !pcmPath.empty()) {
    VIDEO_LOGI("video.export mux audio begin");
    auto ast = MuxAudioFromPcm(av.fmt, as, aenc, swr, pcmPath, pcmRate, cancel);
    if (!ast.ok) {
      return ast;
    }
    VIDEO_LOGI("video.export mux audio end");
  }

  if (progress) {
    progress(100, toUs);
  }
  VIDEO_LOGI("video.export ok format=%s codec=%s %dx%d path=%s", format.c_str(),
             opts.codec == VideoCodec::Hevc ? "hevc" : "h264", outW, outH,
             outPath.c_str());
  return Status::Ok();
#endif
}

}  // namespace video
}  // namespace sherpa_onnx
