#ifdef HAVE_FFMPEG

#include "encode/FfmpegVideoEncoder.h"

#include "VideoLog.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
}

#include "libyuv/convert.h"

#include <algorithm>
#include <cstring>

namespace sherpa_onnx {
namespace video {

struct FfmpegVideoEncoder::Impl {
  AVCodecContext* ctx = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* pkt = nullptr;
};

FfmpegVideoEncoder::FfmpegVideoEncoder() : impl_(std::make_unique<Impl>()) {}

FfmpegVideoEncoder::~FfmpegVideoEncoder() { Close(); }

void FfmpegVideoEncoder::CaptureExtradata() {
  if (impl_->ctx == nullptr || impl_->ctx->extradata == nullptr ||
      impl_->ctx->extradata_size <= 0) {
    return;
  }
  codecConfig_.assign(impl_->ctx->extradata,
                      impl_->ctx->extradata + impl_->ctx->extradata_size);
}

Status FfmpegVideoEncoder::Configure(const VideoTrackInfo& track, int bitrate) {
  Close();
  if (track.codedWidth <= 0 || track.codedHeight <= 0) {
    return Status::Fail(kErrInvalidArgument, "encoder size");
  }
  const AVCodec* codec = avcodec_find_encoder_by_name("libvpx_vp9");
  if (codec == nullptr) {
    return Status::Fail(kErrSwEncoderDisabled, "libvpx_vp9");
  }
  impl_->ctx = avcodec_alloc_context3(codec);
  if (impl_->ctx == nullptr) {
    return Status::Fail(kErrEncoderUnavailable, "alloc ctx");
  }
  int fps = 30;
  if (track.nominalFps.num > 0 && track.nominalFps.den > 0) {
    fps = std::max(
        1, (track.nominalFps.num + track.nominalFps.den / 2) /
               track.nominalFps.den);
  }
  impl_->ctx->width = track.codedWidth;
  impl_->ctx->height = track.codedHeight;
  impl_->ctx->pix_fmt = AV_PIX_FMT_YUV420P;
  impl_->ctx->time_base = AVRational{1, 1000000};
  impl_->ctx->framerate = AVRational{fps, 1};
  impl_->ctx->bit_rate = bitrate > 0 ? bitrate : 2'000'000;
  impl_->ctx->gop_size = std::max(1, fps);
  impl_->ctx->max_b_frames = 0;
  impl_->ctx->thread_count = 1;
  av_opt_set(impl_->ctx->priv_data, "deadline", "realtime", 0);
  av_opt_set(impl_->ctx->priv_data, "cpu-used", "8", 0);
  const int opened = avcodec_open2(impl_->ctx, codec, nullptr);
  if (opened < 0) {
    Close();
    return Status::Fail(kErrEncoderUnavailable, "avcodec_open2 libvpx_vp9");
  }
  impl_->frame = av_frame_alloc();
  impl_->pkt = av_packet_alloc();
  if (impl_->frame == nullptr || impl_->pkt == nullptr) {
    Close();
    return Status::Fail(kErrEncoderUnavailable, "av_frame");
  }
  impl_->frame->format = AV_PIX_FMT_YUV420P;
  impl_->frame->width = track.codedWidth;
  impl_->frame->height = track.codedHeight;
  if (av_frame_get_buffer(impl_->frame, 32) < 0) {
    Close();
    return Status::Fail(kErrEncoderUnavailable, "av_frame_get_buffer");
  }
  track_ = track;
  CaptureExtradata();
  configured_ = true;
  packetCount_ = 0;
  VIDEO_LOGI("video.encode ffmpeg.vp9 %dx%d bitrate=%d fps=%d config=%zu",
             track.codedWidth, track.codedHeight,
             bitrate > 0 ? bitrate : 2'000'000, fps, codecConfig_.size());
  return Status::Ok();
}

Status FfmpegVideoEncoder::Drain(std::vector<EncodedPacket>* out) {
  if (impl_->ctx == nullptr || impl_->pkt == nullptr || out == nullptr) {
    return Status::Fail(kErrEncodeFailed, "ffmpeg encoder");
  }
  while (true) {
    const int rc = avcodec_receive_packet(impl_->ctx, impl_->pkt);
    if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) {
      break;
    }
    if (rc < 0) {
      return Status::Fail(kErrEncodeFailed, "avcodec_receive_packet");
    }
    EncodedPacket pkt;
    pkt.ptsUs = impl_->pkt->pts;
    pkt.dtsUs = impl_->pkt->dts != AV_NOPTS_VALUE ? impl_->pkt->dts
                                                  : impl_->pkt->pts;
    if (impl_->pkt->flags & AV_PKT_FLAG_KEY) {
      pkt.flags = kSampleKey;
    }
    pkt.payload.assign(impl_->pkt->data, impl_->pkt->data + impl_->pkt->size);
    out->push_back(std::move(pkt));
    ++packetCount_;
    if (packetCount_ == 1) {
      VIDEO_LOGI("video.encode ffmpeg.vp9 first packet bytes=%d key=%d",
                 impl_->pkt->size,
                 (impl_->pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0);
    }
    av_packet_unref(impl_->pkt);
  }
  CaptureExtradata();
  return Status::Ok();
}

Status FfmpegVideoEncoder::Encode(const RawFrame& frame,
                                  std::vector<EncodedPacket>* out) {
  if (!configured_ || impl_->ctx == nullptr || impl_->frame == nullptr) {
    return Status::Fail(kErrEncodeFailed, "ffmpeg encoder");
  }
  if (out == nullptr || frame.nv12.y.data == nullptr ||
      frame.nv12.uv.data == nullptr || frame.nv12.width <= 0 ||
      frame.nv12.height <= 0) {
    return Status::Fail(kErrInvalidArgument, "empty nv12");
  }
  if (av_frame_make_writable(impl_->frame) < 0) {
    return Status::Fail(kErrEncodeFailed, "av_frame_make_writable");
  }
  const int rc = libyuv::NV12ToI420(
      frame.nv12.y.data, frame.nv12.y.stride, frame.nv12.uv.data,
      frame.nv12.uv.stride, impl_->frame->data[0], impl_->frame->linesize[0],
      impl_->frame->data[1], impl_->frame->linesize[1], impl_->frame->data[2],
      impl_->frame->linesize[2], frame.nv12.width, frame.nv12.height);
  if (rc != 0) {
    return Status::Fail(kErrEncodeFailed, "NV12ToI420");
  }
  impl_->frame->pts = frame.ptsUs;
  const int sent = avcodec_send_frame(impl_->ctx, impl_->frame);
  if (sent < 0) {
    return Status::Fail(kErrEncodeFailed, "avcodec_send_frame");
  }
  return Drain(out);
}

Status FfmpegVideoEncoder::Flush(std::vector<EncodedPacket>* out) {
  if (!configured_ || impl_->ctx == nullptr) {
    return Status::Fail(kErrEncodeFailed, "ffmpeg encoder");
  }
  avcodec_send_frame(impl_->ctx, nullptr);
  return Drain(out);
}

void FfmpegVideoEncoder::Close() {
  if (impl_->pkt) {
    av_packet_free(&impl_->pkt);
  }
  if (impl_->frame) {
    av_frame_free(&impl_->frame);
  }
  if (impl_->ctx) {
    avcodec_free_context(&impl_->ctx);
  }
  codecConfig_.clear();
  configured_ = false;
  packetCount_ = 0;
}

}  // namespace video
}  // namespace sherpa_onnx

#endif  // HAVE_FFMPEG
