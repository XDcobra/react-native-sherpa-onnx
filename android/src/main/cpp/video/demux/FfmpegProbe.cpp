#include "demux/FfmpegProbe.h"

#include "VideoLog.h"
#include "core/FileIo.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>
}
#endif

namespace sherpa_onnx {
namespace video {

#ifndef HAVE_FFMPEG

Status ProbeVideoFile(const std::string& path, VideoFileProbe* out) {
  (void)path;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
}

#else

namespace {

struct ProbeAvio {
  int fd = -1;
  int64_t size = 0;
  int64_t pos = 0;
};

int ProbeAvioRead(void* opaque, uint8_t* buf, int buf_size) {
  auto* o = static_cast<ProbeAvio*>(opaque);
  if (o == nullptr || o->fd < 0) {
    return AVERROR(EIO);
  }
  const int64_t n = DefaultFileIo().Pread(o->fd, buf, static_cast<size_t>(buf_size),
                                          o->pos);
  if (n < 0) {
    return AVERROR(EIO);
  }
  if (n == 0) {
    return AVERROR_EOF;
  }
  o->pos += n;
  return static_cast<int>(n);
}

int64_t ProbeAvioSeek(void* opaque, int64_t offset, int whence) {
  auto* o = static_cast<ProbeAvio*>(opaque);
  if (o == nullptr) {
    return AVERROR(EIO);
  }
  if (whence == AVSEEK_SIZE) {
    return o->size;
  }
  int64_t next = o->pos;
  if (whence == SEEK_SET) {
    next = offset;
  } else if (whence == SEEK_CUR) {
    next = o->pos + offset;
  } else if (whence == SEEK_END) {
    next = o->size + offset;
  } else {
    return AVERROR(EINVAL);
  }
  if (next < 0) {
    return AVERROR(EINVAL);
  }
  o->pos = next;
  return o->pos;
}

std::string CodecShortName(AVCodecID id) {
  const AVCodec* decoder = avcodec_find_decoder(id);
  if (decoder && decoder->name && decoder->name[0] != '\0') {
    return decoder->name;
  }
  const char* name = avcodec_get_name(id);
  if (name && name[0] != '\0') {
    return name;
  }
  return "unknown";
}

bool FillDuration(AVFormatContext* fmt, int videoStream, int64_t fileSize,
                  VideoFileProbe* out) {
  AVStream* st = fmt->streams[videoStream];
  if (st->duration != AV_NOPTS_VALUE && st->duration > 0 &&
      st->time_base.num > 0 && st->time_base.den > 0) {
    const int64_t us =
        av_rescale_q(st->duration, st->time_base, AVRational{1, 1000000});
    if (us > 0) {
      out->durationUs = us;
      out->durationExact = true;
      return true;
    }
  }
  if (fmt->duration > 0) {
    const int64_t us =
        av_rescale_q(fmt->duration, AVRational{1, AV_TIME_BASE},
                     AVRational{1, 1000000});
    if (us > 0) {
      out->durationUs = us;
      out->durationExact = true;
      return true;
    }
  }
  if (st->nb_frames > 0 && st->avg_frame_rate.num > 0 &&
      st->avg_frame_rate.den > 0) {
    const int64_t us = av_rescale_q(
        st->nb_frames,
        AVRational{st->avg_frame_rate.den, st->avg_frame_rate.num},
        AVRational{1, 1000000});
    if (us > 0) {
      out->durationUs = us;
      out->durationExact = false;
      return true;
    }
  }
  if (fmt->bit_rate > 0 && fileSize > 0) {
    const int64_t us =
        static_cast<int64_t>((static_cast<double>(fileSize) * 8.0 * 1000000.0) /
                             static_cast<double>(fmt->bit_rate));
    if (us > 0) {
      out->durationUs = us;
      out->durationExact = false;
      return true;
    }
  }
  return false;
}

}  // namespace

Status ProbeVideoFile(const std::string& path, VideoFileProbe* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "probe out is null");
  }
  *out = VideoFileProbe{};
  if (path.empty()) {
    return Status::Fail(kErrInvalidArgument, "empty path");
  }

  ProbeAvio avioState;
  avioState.fd = DefaultFileIo().Open(path.c_str(), O_RDONLY, 0);
  if (avioState.fd < 0) {
    return Status::Fail(kErrFileCorrupt, "open container");
  }
  struct stat stbuf {};
  if (::fstat(avioState.fd, &stbuf) != 0) {
    DefaultFileIo().Close(avioState.fd);
    return Status::Fail(kErrFileCorrupt, "stat container");
  }
  avioState.size = stbuf.st_size;
  avioState.pos = 0;

  AVFormatContext* fmt = nullptr;
  AVIOContext* avio = nullptr;
  uint8_t* avioBuf = nullptr;

  struct Cleanup {
    ProbeAvio* state;
    AVFormatContext** fmt;
    AVIOContext** avio;
    ~Cleanup() {
      if (fmt && *fmt) {
        avformat_close_input(fmt);
      }
      if (avio && *avio) {
        av_freep(&(*avio)->buffer);
        avio_context_free(avio);
      }
      if (state && state->fd >= 0) {
        DefaultFileIo().Close(state->fd);
        state->fd = -1;
      }
    }
  } cleanup{&avioState, &fmt, &avio};

  constexpr int kBuf = 4096;
  avioBuf = static_cast<uint8_t*>(av_malloc(kBuf));
  if (!avioBuf) {
    return Status::Fail(kErrFileCorrupt, "avio buffer");
  }
  avio = avio_alloc_context(avioBuf, kBuf, 0, &avioState, ProbeAvioRead, nullptr,
                            ProbeAvioSeek);
  if (!avio) {
    av_free(avioBuf);
    return Status::Fail(kErrFileCorrupt, "avio");
  }

  fmt = avformat_alloc_context();
  if (!fmt) {
    return Status::Fail(kErrFileCorrupt, "format context");
  }
  fmt->pb = avio;
  fmt->flags |= AVFMT_FLAG_CUSTOM_IO;

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "probesize", "32768", 0);
  av_dict_set(&opts, "analyzeduration", "2000000", 0);
  // Empty name: content sniff only — a mislabeled .mp4 must not force the mov demuxer.
  int err = avformat_open_input(&fmt, "", nullptr, &opts);
  av_dict_free(&opts);
  if (err < 0) {
    char buf[128];
    av_strerror(err, buf, sizeof(buf));
    VIDEO_LOGE("video.probe open failed %s", buf);
    return Status::Fail(kErrContainerUnsupported, buf);
  }

  AVDictionary* infoOpts = nullptr;
  av_dict_set(&infoOpts, "probesize", "32768", 0);
  av_dict_set(&infoOpts, "analyzeduration", "2000000", 0);
  if (avformat_find_stream_info(fmt, &infoOpts) < 0) {
    av_dict_free(&infoOpts);
    return Status::Fail(kErrContainerUnsupported, "stream info");
  }
  av_dict_free(&infoOpts);

  int videoStream = -1;
  int audioStream = -1;
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    const auto type = fmt->streams[i]->codecpar->codec_type;
    if (type == AVMEDIA_TYPE_VIDEO && videoStream < 0) {
      videoStream = static_cast<int>(i);
    } else if (type == AVMEDIA_TYPE_AUDIO && audioStream < 0) {
      audioStream = static_cast<int>(i);
    }
  }
  if (videoStream < 0) {
    return Status::Fail(kErrNoVideoTrack, "no video stream");
  }

  AVStream* vst = fmt->streams[videoStream];
  AVCodecParameters* par = vst->codecpar;
  if (fmt->iformat && fmt->iformat->name && fmt->iformat->name[0] != '\0') {
    out->inputFormatName = fmt->iformat->name;
  } else {
    out->inputFormatName = "unknown";
  }
  out->codecName = CodecShortName(par->codec_id);
  out->codedWidth = par->width;
  out->codedHeight = par->height;
  if (audioStream >= 0 && fmt->streams[audioStream]->codecpar) {
    out->audioCodecName =
        CodecShortName(fmt->streams[audioStream]->codecpar->codec_id);
  }

  if (!FillDuration(fmt, videoStream, avioState.size, out)) {
    VIDEO_LOGW("video.probe duration unknown format=%s codec=%s",
               out->inputFormatName.c_str(), out->codecName.c_str());
    return Status::Fail(kErrDurationUnknown, "Could not determine duration");
  }

  VIDEO_LOGI("video.probe format=%s codec=%s %dx%d durationUs=%lld exact=%d",
             out->inputFormatName.c_str(), out->codecName.c_str(),
             out->codedWidth, out->codedHeight,
             static_cast<long long>(out->durationUs),
             out->durationExact ? 1 : 0);
  return Status::Ok();
}

#endif

}  // namespace video
}  // namespace sherpa_onnx
