#include "audio/FfmpegAudioDecoder.h"

#include "VideoLog.h"

#include <algorithm>
#include <cstring>
#include <deque>
#include <unordered_map>
#include <vector>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}
#endif

namespace sherpa_onnx {
namespace video {

#ifdef HAVE_FFMPEG
namespace {

AVCodecID ToAvCodecId(AudioCodec c) {
  switch (c) {
    case AudioCodec::Aac:
      return AV_CODEC_ID_AAC;
    case AudioCodec::Mp3:
      return AV_CODEC_ID_MP3;
    case AudioCodec::Opus:
      return AV_CODEC_ID_OPUS;
    case AudioCodec::Vorbis:
      return AV_CODEC_ID_VORBIS;
    case AudioCodec::Flac:
      return AV_CODEC_ID_FLAC;
    case AudioCodec::PcmS16le:
      return AV_CODEC_ID_PCM_S16LE;
    case AudioCodec::PcmF32le:
      return AV_CODEC_ID_PCM_F32LE;
    default:
      return AV_CODEC_ID_NONE;
  }
}

}  // namespace
#endif

struct FfmpegAudioDecoderImpl {
#ifdef HAVE_FFMPEG
  AVCodecContext* ctx = nullptr;
  SwrContext* swr = nullptr;
  AVFrame* frame = nullptr;
  AudioTrackInfo info;
  int maxOutChannels = 2;
  int outChannels = 0;
  int outRate = 0;
  int64_t skipRemaining = 0;
  bool applyPriming = true;
  bool havePts = false;
  int64_t nextPtsUs = 0;
  int64_t lastPktPtsUs = 0;
  bool eosSent = false;
  std::deque<std::vector<float>> freeBufs;
  std::unordered_map<float*, std::vector<float>> live;
  std::vector<float> scratch;
#endif
};

FfmpegAudioDecoder::FfmpegAudioDecoder()
    : impl_(std::make_unique<FfmpegAudioDecoderImpl>()) {}

FfmpegAudioDecoder::~FfmpegAudioDecoder() {
#ifdef HAVE_FFMPEG
  if (impl_->swr) {
    swr_free(&impl_->swr);
  }
  if (impl_->frame) {
    av_frame_free(&impl_->frame);
  }
  if (impl_->ctx) {
    avcodec_free_context(&impl_->ctx);
  }
#endif
}

int FfmpegAudioDecoder::sampleRate() const {
#ifdef HAVE_FFMPEG
  return impl_->outRate;
#else
  return 0;
#endif
}

int FfmpegAudioDecoder::channels() const {
#ifdef HAVE_FFMPEG
  return impl_->outChannels;
#else
  return 0;
#endif
}

bool FfmpegAudioDecoder::configured() const {
#ifdef HAVE_FFMPEG
  return impl_->ctx != nullptr;
#else
  return false;
#endif
}

Status FfmpegAudioDecoder::Configure(const AudioTrackInfo& info,
                                     int maxOutChannels) {
#ifndef HAVE_FFMPEG
  (void)info;
  (void)maxOutChannels;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (info.codec == AudioCodec::Unsupported || !info.decodable) {
    return Status::Fail(kErrAudioCodecUnsupported,
                        std::string("codec=") +
                            (info.codecName.empty() ? AudioCodecName(info.codec)
                                                    : info.codecName.c_str()));
  }
  if (info.sampleRate <= 0 || info.channels <= 0) {
    return Status::Fail(kErrInvalidArgument, "audio track rate/channels");
  }
  const AVCodecID id = ToAvCodecId(info.codec);
  const AVCodec* codec = avcodec_find_decoder(id);
  if (codec == nullptr) {
    return Status::Fail(kErrAudioCodecUnsupported,
                        std::string("no decoder for ") + info.codecName);
  }
  if (impl_->swr) {
    swr_free(&impl_->swr);
  }
  if (impl_->frame) {
    av_frame_free(&impl_->frame);
  }
  if (impl_->ctx) {
    avcodec_free_context(&impl_->ctx);
  }
  impl_->ctx = avcodec_alloc_context3(codec);
  if (impl_->ctx == nullptr) {
    return Status::Fail(kErrAudioDecodeFailed, "avcodec_alloc_context3");
  }
  impl_->ctx->sample_rate = info.sampleRate;
  impl_->ctx->pkt_timebase = AVRational{1, 1000000};
  if (info.channelLayoutMask != 0) {
    av_channel_layout_from_mask(&impl_->ctx->ch_layout, info.channelLayoutMask);
  } else {
    av_channel_layout_default(&impl_->ctx->ch_layout, info.channels);
  }
  if (!info.extradata.empty()) {
    impl_->ctx->extradata = static_cast<uint8_t*>(
        av_mallocz(info.extradata.size() + AV_INPUT_BUFFER_PADDING_SIZE));
    if (impl_->ctx->extradata == nullptr) {
      return Status::Fail(kErrAudioDecodeFailed, "extradata alloc");
    }
    std::memcpy(impl_->ctx->extradata, info.extradata.data(),
                info.extradata.size());
    impl_->ctx->extradata_size = static_cast<int>(info.extradata.size());
  }
  const int openErr = avcodec_open2(impl_->ctx, codec, nullptr);
  if (openErr < 0) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(openErr, buf, sizeof(buf));
    return Status::Fail(kErrAudioDecodeFailed,
                        std::string("avcodec_open2: ") + buf);
  }
  impl_->frame = av_frame_alloc();
  if (impl_->frame == nullptr) {
    return Status::Fail(kErrAudioDecodeFailed, "av_frame_alloc");
  }
  impl_->info = info;
  impl_->maxOutChannels = maxOutChannels > 0 ? maxOutChannels : 2;
  impl_->outRate = info.sampleRate;
  impl_->outChannels = 0;
  impl_->skipRemaining = impl_->applyPriming ? info.initialPaddingSamples : 0;
  impl_->havePts = false;
  impl_->nextPtsUs = 0;
  impl_->eosSent = false;
  VIDEO_LOGI("video.audio decode configure codec=%s rate=%d ch=%d pad=%lld",
             info.codecName.empty() ? AudioCodecName(info.codec)
                                    : info.codecName.c_str(),
             info.sampleRate, info.channels,
             static_cast<long long>(impl_->skipRemaining));
  return Status::Ok();
#endif
}

Status FfmpegAudioDecoder::Submit(const EncodedPacket& pkt) {
#ifndef HAVE_FFMPEG
  (void)pkt;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (impl_->ctx == nullptr) {
    return Status::Fail(kErrInvalidState, "decoder not configured");
  }
  AVPacket* avpkt = av_packet_alloc();
  if (avpkt == nullptr) {
    return Status::Fail(kErrAudioDecodeFailed, "av_packet_alloc");
  }
  int err = 0;
  if (pkt.payload.empty()) {
    impl_->eosSent = true;
    err = avcodec_send_packet(impl_->ctx, nullptr);
  } else {
    avpkt->data = const_cast<uint8_t*>(pkt.payload.data());
    avpkt->size = static_cast<int>(pkt.payload.size());
    avpkt->pts = pkt.ptsUs;
    avpkt->dts = pkt.dtsUs != 0 ? pkt.dtsUs : pkt.ptsUs;
    impl_->lastPktPtsUs = pkt.ptsUs;
    if (!impl_->havePts) {
      impl_->nextPtsUs = pkt.ptsUs;
      impl_->havePts = true;
    }
    err = avcodec_send_packet(impl_->ctx, avpkt);
  }
  av_packet_free(&avpkt);
  if (err == AVERROR(EAGAIN)) {
    return Status::Ok();
  }
  if (err < 0 && err != AVERROR_EOF) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(err, buf, sizeof(buf));
    return Status::Fail(kErrAudioDecodeFailed,
                        std::string("avcodec_send_packet: ") + buf);
  }
  return Status::Ok();
#endif
}

#ifdef HAVE_FFMPEG
namespace {

bool EnsureSwr(FfmpegAudioDecoderImpl* impl, AVFrame* frame, int maxOutCh) {  const int srcCh = frame->ch_layout.nb_channels;
  const int srcRate = frame->sample_rate > 0 ? frame->sample_rate
                                             : impl->info.sampleRate;
  int outCh = std::min(maxOutCh, srcCh);
  if (outCh < 1) {
    outCh = 1;
  }
  if (impl->swr && impl->outChannels == outCh && impl->outRate == srcRate) {
    return true;
  }
  if (impl->swr) {
    swr_free(&impl->swr);
  }
  AVChannelLayout outLayout;
  av_channel_layout_default(&outLayout, outCh);
  const int ret = swr_alloc_set_opts2(
      &impl->swr, &outLayout, AV_SAMPLE_FMT_FLT, srcRate, &frame->ch_layout,
      static_cast<AVSampleFormat>(frame->format), srcRate, 0, nullptr);
  av_channel_layout_uninit(&outLayout);
  if (ret < 0 || impl->swr == nullptr) {
    return false;
  }
  if (swr_init(impl->swr) < 0) {
    swr_free(&impl->swr);
    return false;
  }
  impl->outChannels = outCh;
  impl->outRate = srcRate;
  VIDEO_LOGI("video.audio swr outCh=%d outRate=%d inFmt=%d inCh=%d", outCh,
             srcRate, frame->format, srcCh);
  return true;
}

}  // namespace
#endif

bool FfmpegAudioDecoder::Receive(PcmChunk* out) {
#ifndef HAVE_FFMPEG
  (void)out;
  return false;
#else
  if (out == nullptr || impl_->ctx == nullptr || impl_->frame == nullptr) {
    return false;
  }
  while (true) {
    const int err = avcodec_receive_frame(impl_->ctx, impl_->frame);
    if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) {
      return false;
    }
    if (err < 0) {
      VIDEO_LOGE("video.audio receive_frame err=%d", err);
      return false;
    }
    AVFrame* frame = impl_->frame;
    if (!EnsureSwr(impl_.get(), frame, impl_->maxOutChannels)) {
      VIDEO_LOGE("video.audio swr init failed");
      av_frame_unref(frame);
      return false;
    }
    int srcFrames = frame->nb_samples;
    int skip = 0;
    if (impl_->skipRemaining > 0) {
      skip = static_cast<int>(
          std::min(impl_->skipRemaining, static_cast<int64_t>(srcFrames)));
      impl_->skipRemaining -= skip;
    }
    const int keep = srcFrames - skip;
    if (keep <= 0) {
      av_frame_unref(frame);
      continue;
    }
    const int maxOut = swr_get_out_samples(impl_->swr, srcFrames);
    const uint8_t* inPlanes[AV_NUM_DATA_POINTERS];
    for (int i = 0; i < AV_NUM_DATA_POINTERS; ++i) {
      inPlanes[i] = frame->extended_data[i];
    }
    impl_->scratch.resize(static_cast<size_t>(std::max(maxOut, srcFrames)) *
                          static_cast<size_t>(impl_->outChannels));
    uint8_t* outPtr = reinterpret_cast<uint8_t*>(impl_->scratch.data());
    const int converted =
        swr_convert(impl_->swr, &outPtr, maxOut, inPlanes, srcFrames);
    av_frame_unref(frame);
    if (converted < 0) {
      VIDEO_LOGE("video.audio swr_convert %d", converted);
      return false;
    }
    const int outKeep = std::max(0, converted - skip);
    if (outKeep <= 0) {
      continue;
    }
    std::vector<float> buf;
    if (!impl_->freeBufs.empty()) {
      buf = std::move(impl_->freeBufs.front());
      impl_->freeBufs.pop_front();
    }
    buf.resize(static_cast<size_t>(outKeep) *
               static_cast<size_t>(impl_->outChannels));
    const float* src =
        impl_->scratch.data() +
        static_cast<size_t>(skip) * static_cast<size_t>(impl_->outChannels);
    std::memcpy(buf.data(), src, buf.size() * sizeof(float));
    out->frames = outKeep;
    out->channels = impl_->outChannels;
    out->sampleRate = impl_->outRate;
    out->ptsUs = impl_->nextPtsUs;
    impl_->nextPtsUs +=
        (static_cast<int64_t>(outKeep) * 1000000LL) / impl_->outRate;
    float* ptr = buf.data();
    impl_->live.emplace(ptr, std::move(buf));
    out->data = ptr;
    return true;
  }
#endif
}

void FfmpegAudioDecoder::Flush() {
#ifdef HAVE_FFMPEG
  if (impl_->ctx) {
    avcodec_flush_buffers(impl_->ctx);
  }
  if (impl_->swr) {
    swr_free(&impl_->swr);
  }
  impl_->skipRemaining = 0;
  impl_->applyPriming = false;
  impl_->havePts = false;
  impl_->eosSent = false;
  VIDEO_LOGI("video.audio decode flush (priming not reapplied)");
#endif
}

void FfmpegAudioDecoder::ReturnChunk(PcmChunk* chunk) {
#ifdef HAVE_FFMPEG
  if (chunk == nullptr || chunk->data == nullptr) {
    return;
  }
  auto it = impl_->live.find(chunk->data);
  if (it != impl_->live.end()) {
    impl_->freeBufs.push_back(std::move(it->second));
    impl_->live.erase(it);
  }
  chunk->data = nullptr;
  chunk->frames = 0;
#else
  (void)chunk;
#endif
}

}  // namespace video
}  // namespace sherpa_onnx
