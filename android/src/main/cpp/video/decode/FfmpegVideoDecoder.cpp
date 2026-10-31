#ifdef HAVE_FFMPEG

#include "decode/FfmpegVideoDecoder.h"

#include "VideoLog.h"
#include "codec/CodecCaps.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
}

#include "libyuv/convert.h"

#include <cstring>

namespace sherpa_onnx {
namespace video {

struct FfmpegVideoDecoder::Impl {
  AVCodecContext* ctx = nullptr;
  AVFrame* frame = nullptr;
  VideoTrackInfo track;
};

FfmpegVideoDecoder::FfmpegVideoDecoder()
    : impl_(std::make_unique<Impl>()) {}

FfmpegVideoDecoder::~FfmpegVideoDecoder() { Close(); }

Status FfmpegVideoDecoder::Configure(const VideoTrackInfo& track) {
  Close();
  impl_->track = track;
  const AVCodecID id =
      track.codec == VideoCodec::Hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264;
  const AVCodec* codec = avcodec_find_decoder(id);
  if (codec == nullptr) {
    return Status::Fail(kErrSwDecoderDisabled, "avcodec_find_decoder");
  }
  impl_->ctx = avcodec_alloc_context3(codec);
  if (impl_->ctx == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "alloc ctx");
  }
  impl_->ctx->width = track.codedWidth;
  impl_->ctx->height = track.codedHeight;
  impl_->ctx->thread_count = sherpa_onnx::codec::FfmpegThreadCount();
  impl_->ctx->thread_type = FF_THREAD_FRAME;
  if (!track.codecConfig.empty()) {
    impl_->ctx->extradata = static_cast<uint8_t*>(
        av_mallocz(track.codecConfig.size() + AV_INPUT_BUFFER_PADDING_SIZE));
    if (impl_->ctx->extradata == nullptr) {
      Close();
      return Status::Fail(kErrDecoderUnavailable, "extradata");
    }
    std::memcpy(impl_->ctx->extradata, track.codecConfig.data(),
                track.codecConfig.size());
    impl_->ctx->extradata_size = static_cast<int>(track.codecConfig.size());
  }
  const int opened = avcodec_open2(impl_->ctx, codec, nullptr);
  if (opened < 0) {
    Close();
    return Status::Fail(kErrDecoderUnavailable, "avcodec_open2");
  }
  impl_->frame = av_frame_alloc();
  if (impl_->frame == nullptr) {
    Close();
    return Status::Fail(kErrDecoderUnavailable, "av_frame");
  }
  configured_ = true;
  VIDEO_LOGI("video.decode ffmpeg %s threads=%d %dx%d",
             VideoCodecName(track.codec), impl_->ctx->thread_count,
             track.codedWidth, track.codedHeight);
  return Status::Ok();
}

Status FfmpegVideoDecoder::Submit(const EncodedPacket& packet) {
  if (!configured_ || impl_->ctx == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "ffmpeg not configured");
  }
  AVPacket pkt;
  av_init_packet(&pkt);
  pkt.data = const_cast<uint8_t*>(packet.payload.data());
  pkt.size = static_cast<int>(packet.payload.size());
  pkt.pts = packet.ptsUs;
  pkt.dts = packet.dtsUs;
  if (packet.flags & kSampleKey) {
    pkt.flags |= AV_PKT_FLAG_KEY;
  }
  const int sent = avcodec_send_packet(impl_->ctx, &pkt);
  if (sent < 0) {
    return Status::Fail(kErrDecodeFailed, "avcodec_send_packet");
  }
  ++submitCount_;
  AVFrame* fr = impl_->frame;
  while (avcodec_receive_frame(impl_->ctx, fr) == 0) {
    if (fr->format != AV_PIX_FMT_YUV420P && fr->format != AV_PIX_FMT_YUVJ420P) {
      av_frame_unref(fr);
      return Status::Fail(kErrCodecUnsupported, "ffmpeg pix_fmt");
    }
    const int w = fr->width;
    const int h = fr->height;
    const int yStride = AlignUp(w);
    const int uvStride = AlignUp(w);
    DecodedRawFrame out;
    const size_t bytes =
        static_cast<size_t>(yStride) * static_cast<size_t>(h) +
        static_cast<size_t>(uvStride) * static_cast<size_t>((h + 1) / 2);
    auto st = out.storage.Allocate(bytes);
    if (!st.ok) {
      av_frame_unref(fr);
      return st;
    }
    uint8_t* dstY = out.storage.data();
    uint8_t* dstUv = dstY + static_cast<size_t>(yStride) * static_cast<size_t>(h);
    const int rc = libyuv::I420ToNV12(
        fr->data[0], fr->linesize[0], fr->data[1], fr->linesize[1], fr->data[2],
        fr->linesize[2], dstY, yStride, dstUv, uvStride, w, h);
    av_frame_unref(fr);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "I420ToNV12");
    }
    out.view.y.data = dstY;
    out.view.y.stride = yStride;
    out.view.uv.data = dstUv;
    out.view.uv.stride = uvStride;
    out.view.width = w;
    out.view.height = h;
    out.ptsUs = fr->pts;
    std::lock_guard<std::mutex> lock(outMu_);
    out_.push_back(std::move(out));
  }
  return Status::Ok();
}

Status FfmpegVideoDecoder::Flush() {
  if (impl_->ctx) {
    avcodec_send_packet(impl_->ctx, nullptr);
    AVFrame* fr = impl_->frame;
    while (fr && avcodec_receive_frame(impl_->ctx, fr) == 0) {
      av_frame_unref(fr);
    }
    avcodec_flush_buffers(impl_->ctx);
  }
  {
    std::lock_guard<std::mutex> lock(outMu_);
    out_.clear();
  }
  ++flushCount_;
  return Status::Ok();
}

bool FfmpegVideoDecoder::Receive(DecodedRawFrame* out) {
  if (out == nullptr) return false;
  std::lock_guard<std::mutex> lock(outMu_);
  if (out_.empty()) return false;
  *out = std::move(out_.front());
  out_.pop_front();
  return true;
}

void FfmpegVideoDecoder::Close() {
  if (impl_->frame) {
    av_frame_free(&impl_->frame);
  }
  if (impl_->ctx) {
    avcodec_free_context(&impl_->ctx);
  }
  {
    std::lock_guard<std::mutex> lock(outMu_);
    out_.clear();
  }
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx

#endif  // HAVE_FFMPEG
