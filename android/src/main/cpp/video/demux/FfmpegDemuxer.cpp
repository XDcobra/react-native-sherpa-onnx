#include "demux/FfmpegDemuxer.h"

#include "VideoLog.h"
#include "core/FileIo.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <vector>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/display.h>
#include <libavutil/error.h>
#include <libavutil/pixfmt.h>
}
#endif

namespace sherpa_onnx {
namespace video {

struct FfmpegDemuxer::Impl {
#ifdef HAVE_FFMPEG
  AVFormatContext* fmt = nullptr;
  AVIOContext* avio = nullptr;
  void* avioOpaque = nullptr;
  uint8_t* avioBuf = nullptr;
  int fd = -1;
  int videoStream = -1;
  int audioStream = -1;
  AVFormatContext* audioFmt = nullptr;
  int64_t pos = 0;
  int64_t size = 0;
  int64_t bytes = 0;
  bool counting = true;
  std::string name;
  bool isMov = false;
#endif
};

#ifdef HAVE_FFMPEG
struct AvioOpaque {
  FfmpegDemuxer::Impl* impl = nullptr;
};

namespace {

int AvioRead(void* opaque, uint8_t* buf, int buf_size) {
  auto* o = static_cast<AvioOpaque*>(opaque);
  if (o == nullptr || o->impl == nullptr || o->impl->fd < 0) {
    return AVERROR(EIO);
  }
  const int64_t n = DefaultFileIo().Pread(o->impl->fd, buf,
                                          static_cast<size_t>(buf_size),
                                          o->impl->pos);
  if (n < 0) {
    return AVERROR(EIO);
  }
  if (n == 0) {
    return AVERROR_EOF;
  }
  o->impl->pos += n;
  if (o->impl->counting) {
    o->impl->bytes += n;
  }
  return static_cast<int>(n);
}

int64_t AvioSeek(void* opaque, int64_t offset, int whence) {
  auto* o = static_cast<AvioOpaque*>(opaque);
  if (o == nullptr || o->impl == nullptr) {
    return AVERROR(EIO);
  }
  if (whence == AVSEEK_SIZE) {
    return o->impl->size;
  }
  int64_t np = o->impl->pos;
  if (whence == SEEK_SET) {
    np = offset;
  } else if (whence == SEEK_CUR) {
    np += offset;
  } else if (whence == SEEK_END) {
    np = o->impl->size + offset;
  }
  if (np < 0) {
    return AVERROR(EINVAL);
  }
  o->impl->pos = np;
  return np;
}

int64_t TbToUs(AVRational tb, int64_t ts) {
  if (ts == AV_NOPTS_VALUE) {
    return 0;
  }
  return av_rescale_q(ts, tb, {1, 1000000});
}

ColorMatrix MapColorSpace(AVColorSpace spc, int height) {
  switch (spc) {
    case AVCOL_SPC_BT709:
      return ColorMatrix::Bt709;
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
      return ColorMatrix::Bt2020;
    case AVCOL_SPC_BT470BG:
    case AVCOL_SPC_SMPTE170M:
      return ColorMatrix::Bt601;
    default:
      return InferColorMatrix(height, ColorMatrix::Bt601, false);
  }
}

int DisplayRotationDegrees(AVStream* st) {
  const uint8_t* data = nullptr;
#if LIBAVFORMAT_VERSION_MAJOR >= 60
  const AVPacketSideData* sd =
      av_packet_side_data_get(st->codecpar->coded_side_data,
                              st->codecpar->nb_coded_side_data,
                              AV_PKT_DATA_DISPLAYMATRIX);
  if (sd && sd->data) {
    data = sd->data;
  }
#endif
  if (data == nullptr) {
    for (int i = 0; i < st->codecpar->nb_coded_side_data; ++i) {
      if (st->codecpar->coded_side_data[i].type == AV_PKT_DATA_DISPLAYMATRIX) {
        data = st->codecpar->coded_side_data[i].data;
        break;
      }
    }
  }
  if (data == nullptr) {
    return 0;
  }
  const double deg = av_display_rotation_get(reinterpret_cast<const int32_t*>(data));
  int r = static_cast<int>(deg >= 0 ? deg + 0.5 : deg - 0.5);
  r = ((r % 360) + 360) % 360;
  // Container rotate=90 is displayed with libyuv 270 (plan §2).
  if (r == 90) {
    return 270;
  }
  if (r == 270) {
    return 90;
  }
  return r;
}

}  // namespace
#endif  // HAVE_FFMPEG

FfmpegDemuxer::FfmpegDemuxer() : impl_(std::make_unique<Impl>()) {}

FfmpegDemuxer::~FfmpegDemuxer() { Close(); }

void FfmpegDemuxer::Close() {
#ifdef HAVE_FFMPEG
  if (impl_->audioFmt) {
    avformat_close_input(&impl_->audioFmt);
    impl_->audioFmt = nullptr;
  }
  if (impl_->fmt) {
    avformat_close_input(&impl_->fmt);
    impl_->fmt = nullptr;
  }
  if (impl_->avio) {
    av_freep(&impl_->avio->buffer);
    avio_context_free(&impl_->avio);
  }
  delete static_cast<AvioOpaque*>(impl_->avioOpaque);
  impl_->avioOpaque = nullptr;
  if (impl_->fd >= 0) {
    DefaultFileIo().Close(impl_->fd);
    impl_->fd = -1;
  }
#endif
}

Status FfmpegDemuxer::Open(const std::string& path) {
#ifndef HAVE_FFMPEG
  (void)path;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  Close();
  path_ = path;
  impl_->fd = DefaultFileIo().Open(path.c_str(), O_RDONLY, 0);
  if (impl_->fd < 0) {
    return Status::Fail(kErrFileCorrupt, "open container");
  }
  struct stat stbuf {};
  if (::fstat(impl_->fd, &stbuf) != 0) {
    return Status::Fail(kErrFileCorrupt, "stat container");
  }
  impl_->size = stbuf.st_size;
  impl_->pos = 0;
  impl_->bytes = 0;
  impl_->counting = true;

  constexpr int kBuf = 4096;
  impl_->avioBuf = static_cast<uint8_t*>(av_malloc(kBuf));
  auto* opaque = new AvioOpaque{impl_.get()};
  impl_->avioOpaque = opaque;
  impl_->avio =
      avio_alloc_context(impl_->avioBuf, kBuf, 0, opaque, AvioRead, nullptr,
                         AvioSeek);
  if (!impl_->avio) {
    delete opaque;
    impl_->avioOpaque = nullptr;
    return Status::Fail(kErrFileCorrupt, "avio");
  }

  impl_->fmt = avformat_alloc_context();
  impl_->fmt->pb = impl_->avio;
  impl_->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "probesize", "32768", 0);
  av_dict_set(&opts, "analyzeduration", "0", 0);
  int err = avformat_open_input(&impl_->fmt, path.c_str(), nullptr, &opts);
  av_dict_free(&opts);
  if (err < 0) {
    char buf[128];
    av_strerror(err, buf, sizeof(buf));
    VIDEO_LOGE("video.demux open failed %s", buf);
    return Status::Fail(kErrContainerUnsupported, buf);
  }

  const char* name = impl_->fmt->iformat && impl_->fmt->iformat->name
                         ? impl_->fmt->iformat->name
                         : "";
  impl_->name = name;
  impl_->isMov = std::strstr(name, "mov") != nullptr ||
                 std::strstr(name, "mp4") != nullptr;
  usesPread_ = impl_->isMov;

  impl_->videoStream = -1;
  for (unsigned i = 0; i < impl_->fmt->nb_streams; ++i) {
    if (impl_->fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
      impl_->videoStream = static_cast<int>(i);
      break;
    }
  }
  if (impl_->videoStream < 0) {
    return Status::Fail(kErrNoVideoTrack, "no video stream");
  }
  for (unsigned i = 0; i < impl_->fmt->nb_streams; ++i) {
    if (impl_->fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      impl_->audioStream = static_cast<int>(i);
      impl_->fmt->streams[i]->discard = AVDISCARD_ALL;
      break;
    }
  }
  if (impl_->audioStream < 0) {
    const int best = av_find_best_stream(impl_->fmt, AVMEDIA_TYPE_AUDIO, -1,
                                         impl_->videoStream, nullptr, 0);
    if (best >= 0) {
      impl_->audioStream = best;
      impl_->fmt->streams[best]->discard = AVDISCARD_ALL;
    }
  }
  AVStream* st = impl_->fmt->streams[impl_->videoStream];
  AVCodecParameters* par = st->codecpar;
  if (par->codec_id == AV_CODEC_ID_H264) {
    track_.codec = VideoCodec::H264;
  } else if (par->codec_id == AV_CODEC_ID_HEVC) {
    track_.codec = VideoCodec::Hevc;
  } else {
    return Status::Fail(kErrCodecUnsupported, avcodec_get_name(par->codec_id));
  }
  track_.codedWidth = par->width;
  track_.codedHeight = par->height;
  track_.displayWidth = par->width;
  track_.displayHeight = par->height;
  track_.transform.rotationDegrees = DisplayRotationDegrees(st);
  if (track_.transform.rotationDegrees == 90 ||
      track_.transform.rotationDegrees == 270) {
    std::swap(track_.displayWidth, track_.displayHeight);
  }
  const bool specSet = par->color_space != AVCOL_SPC_UNSPECIFIED;
  track_.matrix =
      MapColorSpace(par->color_space, par->height);
  (void)specSet;
  track_.range = par->color_range == AVCOL_RANGE_JPEG ? ColorRange::Full
                                                      : ColorRange::Limited;
  if (st->avg_frame_rate.num > 0 && st->avg_frame_rate.den > 0) {
    track_.nominalFps = {st->avg_frame_rate.num, st->avg_frame_rate.den};
  }
  if (par->extradata && par->extradata_size > 0) {
    track_.codecConfig.assign(par->extradata,
                              par->extradata + par->extradata_size);
  }

  auto stIdx = BuildIndex();
  if (!stIdx.ok) {
    return stIdx;
  }
  if (impl_->audioStream >= 0) {
    auto ast = BuildAudioIndex();
    if (!ast.ok) {
      VIDEO_LOGW("video.audio index failed %s", ast.errorMessage.c_str());
      audio_.reset();
    }
  }
  impl_->counting = false;
  openBytes_ = impl_->bytes;
  VIDEO_LOGI("video.demux open %s codec=%s frames=%lld keys index_ms bytes=%lld",
             name, VideoCodecName(track_.codec),
             static_cast<long long>(timeline_.frameCount()),
             static_cast<long long>(openBytes_));
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::BuildIndex() {
#ifndef HAVE_FFMPEG
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  AVStream* st = impl_->fmt->streams[impl_->videoStream];
  const int n = avformat_index_get_entries_count(st);
  std::vector<SampleEntry> samples;
  if (n > 0) {
    samples.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      const AVIndexEntry* e = avformat_index_get_entry(st, i);
      if (!e) {
        continue;
      }
      SampleEntry s;
      s.ptsUs = TbToUs(st->time_base, e->timestamp);
      s.dtsUs = s.ptsUs;
      s.fileOffset = e->pos;
      s.size = static_cast<uint32_t>(e->size > 0 ? e->size : 0);
      if (e->flags & AVINDEX_KEYFRAME) {
        s.flags |= kSampleKey;
      }
      samples.push_back(s);
    }
    std::sort(samples.begin(), samples.end(),
              [](const SampleEntry& a, const SampleEntry& b) {
                return a.ptsUs < b.ptsUs;
              });
    frameCountExact_ = impl_->isMov;
    indexState_ = IndexState::Complete;
    if (!impl_->isMov) {
      // Matroska cues are keyframes only.
      bool onlyKeys = true;
      for (const auto& s : samples) {
        if ((s.flags & kSampleKey) == 0) {
          onlyKeys = false;
          break;
        }
      }
      if (onlyKeys && samples.size() < 2) {
        frameCountExact_ = false;
        indexState_ = IndexState::Building;
      } else if (onlyKeys) {
        frameCountExact_ = false;
        indexState_ = IndexState::Complete;
      }
    }
  } else {
    frameCountExact_ = false;
    indexState_ = IndexState::Building;
  }
  timeline_.AssignImmutable(std::move(samples));
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::GetSample(int64_t decodeIndex, SampleEntry* out) const {
  const int64_t p = timeline_.PresentationOfDecode(decodeIndex);
  return timeline_.Get(p, out);
}

Status FfmpegDemuxer::ReadPacket(int64_t decodeIndex, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)decodeIndex;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (usesPread_) {
    return ReadMovByPread(decodeIndex, out);
  }
  return ReadMatroska(decodeIndex, out);
#endif
}

Status FfmpegDemuxer::ReadMovByPread(int64_t decodeIndex, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)decodeIndex;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  SampleEntry s;
  auto st = GetSample(decodeIndex, &s);
  if (!st.ok) {
    return st;
  }
  if (s.fileOffset < 0 || s.size == 0) {
    return Status::Fail(kErrFileCorrupt, "sample offset");
  }
  EncodedPacket pkt;
  pkt.ptsUs = s.ptsUs;
  pkt.dtsUs = s.dtsUs;
  pkt.flags = s.flags;
  pkt.payload.resize(s.size);
  const int64_t n =
      DefaultFileIo().Pread(impl_->fd, pkt.payload.data(), s.size, s.fileOffset);
  if (n != static_cast<int64_t>(s.size)) {
    return Status::Fail(kErrFileCorrupt, "pread sample");
  }
  *out = std::move(pkt);
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::ReadMatroska(int64_t decodeIndex, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)decodeIndex;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  SampleEntry s;
  auto gst = GetSample(decodeIndex, &s);
  if (!gst.ok) {
    return gst;
  }
  AVStream* st = impl_->fmt->streams[impl_->videoStream];
  const int64_t ts = av_rescale_q(s.ptsUs, {1, 1000000}, st->time_base);
  int err = av_seek_frame(impl_->fmt, impl_->videoStream, ts,
                          AVSEEK_FLAG_BACKWARD);
  if (err < 0) {
    return Status::Fail(kErrDecodeFailed, "av_seek_frame");
  }
  AVPacket* pkt = av_packet_alloc();
  while (true) {
    err = av_read_frame(impl_->fmt, pkt);
    if (err < 0) {
      av_packet_free(&pkt);
      return Status::Fail(kErrFileCorrupt, "av_read_frame");
    }
    if (pkt->stream_index != impl_->videoStream) {
      av_packet_unref(pkt);
      continue;
    }
    const int64_t pts = TbToUs(st->time_base, pkt->pts);
    if (pts < s.ptsUs) {
      av_packet_unref(pkt);
      continue;
    }
    EncodedPacket ep;
    ep.ptsUs = pts;
    ep.dtsUs = TbToUs(st->time_base, pkt->dts);
    ep.flags = s.flags;
    ep.payload.assign(pkt->data, pkt->data + pkt->size);
    *out = std::move(ep);
    av_packet_free(&pkt);
    return Status::Ok();
  }
#endif
}

#ifdef HAVE_FFMPEG
namespace {

AudioCodec MapAudioCodec(AVCodecID id) {
  switch (id) {
    case AV_CODEC_ID_AAC:
      return AudioCodec::Aac;
    case AV_CODEC_ID_MP3:
      return AudioCodec::Mp3;
    case AV_CODEC_ID_OPUS:
      return AudioCodec::Opus;
    case AV_CODEC_ID_VORBIS:
      return AudioCodec::Vorbis;
    case AV_CODEC_ID_FLAC:
      return AudioCodec::Flac;
    case AV_CODEC_ID_PCM_S16LE:
      return AudioCodec::PcmS16le;
    case AV_CODEC_ID_PCM_F32LE:
      return AudioCodec::PcmF32le;
    default:
      return AudioCodec::Unsupported;
  }
}

}  // namespace
#endif

Status FfmpegDemuxer::BuildAudioIndex() {
#ifndef HAVE_FFMPEG
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (impl_->audioStream < 0 || impl_->fmt == nullptr) {
    return Status::Fail(kErrNoAudioTrack, "no audio stream");
  }
  AVStream* st = impl_->fmt->streams[impl_->audioStream];
  AVCodecParameters* par = st->codecpar;
  AudioTrackInfo info;
  info.codec = MapAudioCodec(par->codec_id);
  info.codecName = avcodec_get_name(par->codec_id);
  info.sampleRate = par->sample_rate;
  info.channels = par->ch_layout.nb_channels;
  info.channelLayoutMask = par->ch_layout.order == AV_CHANNEL_ORDER_NATIVE
                               ? par->ch_layout.u.mask
                               : 0;
  info.frameSize = par->frame_size;
  info.initialPaddingSamples = par->initial_padding;
  info.timeBase = {st->time_base.num, st->time_base.den};
  if (par->extradata && par->extradata_size > 0) {
    info.extradata.assign(par->extradata, par->extradata + par->extradata_size);
  }
  // Host Homebrew FFmpeg may ship AC-3/DTS/ALAC; our prebuilts do not. The
  // AudioCodec mapping is the product decoder set (aac/mp3/opus/vorbis/flac/pcm).
  info.decodable = info.codec != AudioCodec::Unsupported &&
                   avcodec_find_decoder(par->codec_id) != nullptr;
  audio_ = info;

  std::vector<AudioPacketEntry> entries;
  const int n = avformat_index_get_entries_count(st);
  if (n > 0) {
    entries.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      const AVIndexEntry* e = avformat_index_get_entry(st, i);
      if (!e) continue;
      AudioPacketEntry a;
      a.ptsUs = TbToUs(st->time_base, e->timestamp);
      a.fileOffset = e->pos;
      a.size = static_cast<uint32_t>(e->size > 0 ? e->size : 0);
      entries.push_back(a);
    }
    std::sort(entries.begin(), entries.end(),
              [](const AudioPacketEntry& a, const AudioPacketEntry& b) {
                return a.ptsUs < b.ptsUs;
              });
    for (size_t i = 0; i < entries.size(); ++i) {
      if (i + 1 < entries.size()) {
        entries[i].durationUs = static_cast<int32_t>(
            entries[i + 1].ptsUs - entries[i].ptsUs);
      } else if (info.sampleRate > 0 && info.frameSize > 0) {
        entries[i].durationUs = static_cast<int32_t>(
            (1000000LL * info.frameSize) / info.sampleRate);
      }
    }
  }
  audioTimeline_.AssignImmutable(std::move(entries));
  VIDEO_LOGI("video.audio open codec=%s decodable=%d rate=%d ch=%d packets=%lld",
             info.codecName.c_str(), info.decodable ? 1 : 0, info.sampleRate,
             info.channels,
             static_cast<long long>(audioTimeline_.size()));
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::EnsureAudioContext() {
#ifndef HAVE_FFMPEG
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (impl_->isMov || impl_->audioFmt != nullptr) {
    return Status::Ok();
  }
  if (path_.empty()) {
    return Status::Fail(kErrFileCorrupt, "audio context path");
  }
  AVFormatContext* fmt = nullptr;
  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "probesize", "32768", 0);
  av_dict_set(&opts, "analyzeduration", "0", 0);
  int err = avformat_open_input(&fmt, path_.c_str(), nullptr, &opts);
  av_dict_free(&opts);
  if (err < 0 || fmt == nullptr) {
    return Status::Fail(kErrFileCorrupt, "audio avformat_open_input");
  }
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    if (static_cast<int>(i) != impl_->audioStream) {
      fmt->streams[i]->discard = AVDISCARD_ALL;
    }
  }
  impl_->audioFmt = fmt;
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::ReadAudioPacket(int64_t index, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)index;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  if (!audio_) {
    return Status::Fail(kErrNoAudioTrack, "no audio");
  }
  if (usesPread_) {
    return ReadAudioMov(index, out);
  }
  return ReadAudioMatroska(index, out);
#endif
}

Status FfmpegDemuxer::ReadAudioMov(int64_t index, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)index;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  AudioPacketEntry e;
  auto st = audioTimeline_.Get(index, &e);
  if (!st.ok) return st;
  if (e.fileOffset < 0 || e.size == 0) {
    return Status::Fail(kErrFileCorrupt, "audio sample offset");
  }
  EncodedPacket pkt;
  pkt.ptsUs = e.ptsUs;
  pkt.dtsUs = e.ptsUs;
  pkt.payload.resize(e.size);
  const int64_t n =
      DefaultFileIo().Pread(impl_->fd, pkt.payload.data(), e.size, e.fileOffset);
  if (n != static_cast<int64_t>(e.size)) {
    return Status::Fail(kErrFileCorrupt, "audio pread");
  }
  *out = std::move(pkt);
  return Status::Ok();
#endif
}

Status FfmpegDemuxer::ReadAudioMatroska(int64_t index, EncodedPacket* out) {
#ifndef HAVE_FFMPEG
  (void)index;
  (void)out;
  return Status::Fail(kErrFfmpegDisabled, "FFmpeg disabled");
#else
  auto est = EnsureAudioContext();
  if (!est.ok) return est;
  AudioPacketEntry target;
  auto gst = audioTimeline_.Get(index, &target);
  int64_t seekUs = 0;
  if (gst.ok) {
    seekUs = target.ptsUs;
  } else if (audioTimeline_.size() == 0) {
    seekUs = 0;
  } else {
    return gst;
  }
  AVFormatContext* fmt = impl_->audioFmt ? impl_->audioFmt : impl_->fmt;
  AVStream* st = fmt->streams[impl_->audioStream];
  const int64_t ts = av_rescale_q(seekUs, {1, 1000000}, st->time_base);
  int err = av_seek_frame(fmt, impl_->audioStream, ts, AVSEEK_FLAG_BACKWARD);
  if (err < 0) {
    return Status::Fail(kErrDecodeFailed, "audio av_seek_frame");
  }
  AVPacket* pkt = av_packet_alloc();
  int seen = 0;
  while (true) {
    err = av_read_frame(fmt, pkt);
    if (err < 0) {
      av_packet_free(&pkt);
      return Status::Fail(kErrFileCorrupt, "audio av_read_frame");
    }
    if (pkt->stream_index != impl_->audioStream) {
      av_packet_unref(pkt);
      continue;
    }
    EncodedPacket ep;
    ep.ptsUs = TbToUs(st->time_base, pkt->pts);
    ep.dtsUs = TbToUs(st->time_base, pkt->dts);
    ep.payload.assign(pkt->data, pkt->data + pkt->size);
    if (!gst.ok) {
      AudioPacketEntry a;
      a.ptsUs = ep.ptsUs;
      a.size = static_cast<uint32_t>(ep.payload.size());
      audioTimeline_.Append(a);
      if (seen == index) {
        *out = std::move(ep);
        av_packet_free(&pkt);
        return Status::Ok();
      }
      ++seen;
      av_packet_unref(pkt);
      continue;
    }
    if (ep.ptsUs < target.ptsUs) {
      av_packet_unref(pkt);
      continue;
    }
    *out = std::move(ep);
    av_packet_free(&pkt);
    return Status::Ok();
  }
#endif
}

}  // namespace video
}  // namespace sherpa_onnx
