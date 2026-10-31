#include "VideoRegistry.h"
#include "codec/CodecArbiter.h"
#include "codec/CodecRuntime.h"
#include "core/MemoryBudget.h"
#include "decode/DecoderBackend.h"
#include "decode/DecoderPool.h"
#include "demux/FfmpegDemuxer.h"
#include "encode/EncoderBackend.h"
#include "encode/FakeEncoder.h"
#include "encode/VideoExportSession.h"
#include "live/LiveVideoEntry.h"
#include "synth.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unistd.h>

#include <gtest/gtest.h>

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavformat/avformat.h>
}
#endif

using namespace sherpa_onnx::video;
using sherpa_onnx::video::test::FillIpp;

class ExportSessionTest : public ::testing::Test {
 protected:
  void SetUp() override {
    RegisterDecoderFactory([]() {
      return std::unique_ptr<DecoderBackend>(new FakeDecoderBackend());
    });
    RegisterEncoderFactory([]() {
      return std::unique_ptr<EncoderBackend>(new FakeEncoder());
    });
    DecoderPool::Instance().CloseAll();
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Cpu, 1);
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Display, 1);
    VideoRegistry::Instance().SetCacheDir("/tmp");
    sherpa_onnx::codec::CodecRuntime::Instance().Init(2LL * 1024 * 1024 * 1024);
  }
  void TearDown() override {
    DecoderPool::Instance().CloseAll();
    ResetDecoderFactoryForTest();
    ResetEncoderFactoryForTest();
    MemoryBudget::Instance().ResetUsedForTest();
    MemoryBudget::Instance().Configure(VideoRamClass::Mid);
    sherpa_onnx::codec::CodecArbiter::Instance().ResetForTest();
  }

  std::shared_ptr<OfflineVideoEntry> MakeClip(int frames = 6) {
    auto src = std::make_unique<MemoryPacketSource>();
    FillIpp(src.get(), frames, 3, false);
    return VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  }
};

TEST_F(ExportSessionTest, MissingBuffer) {
  VideoExportOptions opts;
  auto st = VideoExportSession::Run("vid_off_missing", "/tmp/out.mp4", "mp4",
                                    opts, nullptr, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrBufferNotFound);
}

TEST_F(ExportSessionTest, RecordingLiveRejected) {
  LiveVideoOptions liveOpts;
  liveOpts.spool.mode = SpoolRetentionMode::None;
  auto live = VideoRegistry::Instance().CreateLive(liveOpts).value;
  ASSERT_NE(live, nullptr);
  VideoExportOptions opts;
  auto st = VideoExportSession::Run(live->id(), "/tmp/out.mp4", "mp4", opts,
                                    nullptr, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrInvalidState);
  VideoRegistry::Instance().Release(live->id());
}

TEST_F(ExportSessionTest, BadFormatRejected) {
  auto e = MakeClip();
  VideoExportOptions opts;
  auto st = VideoExportSession::Run(e->id(), "/tmp/out.avi", "avi", opts,
                                    nullptr, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrInvalidArgument);
  VideoRegistry::Instance().Release(e->id());
}

#ifdef HAVE_FFMPEG
TEST_F(ExportSessionTest, SecondExportPoolFull) {
  auto hold = sherpa_onnx::codec::CodecArbiter::Instance().TryAcquire(
      sherpa_onnx::codec::ResourceClass::HwVideoEncode, "held-export");
  ASSERT_TRUE(hold.ok()) << hold.status.errorMessage;
  auto e = MakeClip();
  VideoExportOptions opts;
  auto st = VideoExportSession::Run(e->id(), "/tmp/out.mp4", "mp4", opts,
                                    nullptr, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrEncoderUnavailable);
  VideoRegistry::Instance().Release(e->id());
}
#endif

#ifndef HAVE_FFMPEG
TEST_F(ExportSessionTest, FfmpegDisabled) {
  auto e = MakeClip();
  VideoExportOptions opts;
  auto st = VideoExportSession::Run(e->id(), "/tmp/out.mp4", "mp4", opts,
                                    nullptr, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrFfmpegDisabled);
  VideoRegistry::Instance().Release(e->id());
}
#else

namespace {

struct ExportFormatCase {
  const char* format;
  const char* ext;
  /** Substring of AVInputFormat.name: mov family vs matroska/webm. */
  const char* demuxerNeedle;
};

void ProbeContainer(const std::string& path, const char* needle,
                    AVCodecID expectedCodec, int expectedW, int expectedH) {
  const int prevLog = av_log_get_level();
  av_log_set_level(AV_LOG_QUIET);
  AVFormatContext* fmt = nullptr;
  const int opened = avformat_open_input(&fmt, path.c_str(), nullptr, nullptr);
  av_log_set_level(prevLog);
  ASSERT_GE(opened, 0) << "avformat_open_input " << path;
  std::unique_ptr<AVFormatContext, void (*)(AVFormatContext*)> hold(
      fmt, [](AVFormatContext* c) { avformat_close_input(&c); });
  av_log_set_level(AV_LOG_QUIET);
  const int probed = avformat_find_stream_info(fmt, nullptr);
  av_log_set_level(prevLog);
  ASSERT_GE(probed, 0) << "find_stream_info";
  ASSERT_NE(fmt->iformat, nullptr);
  ASSERT_NE(fmt->iformat->name, nullptr);
  EXPECT_NE(std::strstr(fmt->iformat->name, needle), nullptr)
      << "iformat=" << fmt->iformat->name << " needle=" << needle;

  AVStream* vs = nullptr;
  for (unsigned i = 0; i < fmt->nb_streams; ++i) {
    if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
      vs = fmt->streams[i];
      break;
    }
  }
  ASSERT_NE(vs, nullptr) << "no video stream";
  EXPECT_EQ(vs->codecpar->codec_id, expectedCodec);
  EXPECT_EQ(vs->codecpar->width, expectedW);
  EXPECT_EQ(vs->codecpar->height, expectedH);
}

}  // namespace

TEST_F(ExportSessionTest, MuxesSyntheticPackets) {
  auto e = MakeClip();
  ASSERT_NE(e, nullptr);
  const std::string path =
      std::string(::testing::TempDir()) + "sherpa_export_test.mp4";
  unlink(path.c_str());
  VideoExportOptions opts;
  opts.bitrate = 500000;
  int lastPct = -1;
  auto st = VideoExportSession::Run(
      e->id(), path, "mp4", opts, nullptr,
      [&](int percent, int64_t) { lastPct = percent; });
  EXPECT_TRUE(st.ok) << st.errorCode << " " << st.errorMessage;
  EXPECT_EQ(lastPct, 100);
  FILE* f = fopen(path.c_str(), "rb");
  ASSERT_NE(f, nullptr);
  fseek(f, 0, SEEK_END);
  const long sz = ftell(f);
  fclose(f);
  EXPECT_GT(sz, 32);
  unlink(path.c_str());
  VideoRegistry::Instance().Release(e->id());
}

TEST_F(ExportSessionTest, Cancelled) {
  auto e = MakeClip();
  const std::string path =
      std::string(::testing::TempDir()) + "sherpa_export_cancel.mp4";
  unlink(path.c_str());
  std::atomic<bool> cancel{true};
  VideoExportOptions opts;
  auto st = VideoExportSession::Run(e->id(), path, "mp4", opts, &cancel, nullptr);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrCancelled);
  unlink(path.c_str());
  VideoRegistry::Instance().Release(e->id());
}

class ExportFormatReopenTest
    : public ExportSessionTest,
      public ::testing::WithParamInterface<ExportFormatCase> {};

TEST_P(ExportFormatReopenTest, ContainerReopensAsImport) {
  const ExportFormatCase c = GetParam();
  auto e = MakeClip();
  ASSERT_NE(e, nullptr);
  const std::string path = std::string(::testing::TempDir()) + "sherpa_export_" +
                           c.format + "." + c.ext;
  unlink(path.c_str());
  VideoExportOptions opts;
  opts.codec = VideoCodec::H264;
  opts.bitrate = 500000;
  auto st =
      VideoExportSession::Run(e->id(), path, c.format, opts, nullptr, nullptr);
  ASSERT_TRUE(st.ok) << c.format << " " << st.errorCode << " "
                     << st.errorMessage;

  ProbeContainer(path, c.demuxerNeedle, AV_CODEC_ID_H264,
                 FakeDecoderBackend::kDefaultWidth,
                 FakeDecoderBackend::kDefaultHeight);

  FfmpegDemuxer demux;
  const int prevLog = av_log_get_level();
  av_log_set_level(AV_LOG_QUIET);
  auto open = demux.Open(path);
  av_log_set_level(prevLog);
  ASSERT_TRUE(open.ok) << c.format << " FfmpegDemuxer " << open.errorCode << " "
                       << open.errorMessage;
  EXPECT_EQ(demux.track().codec, VideoCodec::H264);
  EXPECT_EQ(demux.track().codedWidth, FakeDecoderBackend::kDefaultWidth);
  EXPECT_EQ(demux.track().codedHeight, FakeDecoderBackend::kDefaultHeight);

  unlink(path.c_str());
  VideoRegistry::Instance().Release(e->id());
}

INSTANTIATE_TEST_SUITE_P(
    Containers, ExportFormatReopenTest,
    ::testing::Values(ExportFormatCase{"mp4", "mp4", "mov"},
                      ExportFormatCase{"mov", "mov", "mov"},
                      ExportFormatCase{"mkv", "mkv", "matroska"},
                      ExportFormatCase{"webm", "webm", "matroska"}),
    [](const ::testing::TestParamInfo<ExportFormatCase>& info) {
      return info.param.format;
    });

#endif
