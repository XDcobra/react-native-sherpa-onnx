#include "VideoRegistry.h"
#include "demux/FfmpegDemuxer.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"

#include <gtest/gtest.h>

#include <fstream>
#include <string>

using namespace sherpa_onnx::video;

namespace {

std::string Fixture(const char* name) {
  return std::string("test/fixtures/videobuffer/") + name;
}

}  // namespace

TEST(FfmpegDemuxer, H264GopKeyframeTable) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264_gop15_b.mp4"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::H264);
  EXPECT_EQ(d.timeline().frameCount(), 15);
  EXPECT_TRUE(d.frameCountExact());
  SampleEntry s;
  ASSERT_TRUE(d.timeline().Get(0, &s).ok);
  EXPECT_NE((s.flags & kSampleKey), 0u);
}

TEST(FfmpegDemuxer, Mp4OpenNoPacketPayloads) {
  FfmpegDemuxer d;
  ASSERT_TRUE(d.Open(Fixture("h264_gop15_b.mp4")).ok);
  const int64_t openBytes = d.bytesReadDuringOpen();
  std::ifstream in(Fixture("h264_gop15_b.mp4"), std::ios::binary | std::ios::ate);
  const auto fileSize = static_cast<int64_t>(in.tellg());
  ASSERT_GT(fileSize, 0);
  EXPECT_GT(openBytes, 0);
  EXPECT_LE(openBytes, fileSize);
  // Tiny committed fixtures (~2 KB) may be fully probed; the open path is still
  // index+pread, not av_read_frame payload decode.
  EXPECT_TRUE(d.usesPread());
  EncodedPacket pkt;
  ASSERT_TRUE(d.ReadPacket(0, &pkt).ok);
  EXPECT_FALSE(pkt.payload.empty());
}

TEST(FfmpegDemuxer, Rot90MapsTo270) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264_rot90.mp4"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_TRUE(d.track().transform.rotationDegrees == 270 ||
              d.track().transform.rotationDegrees == 90 ||
              d.track().transform.rotationDegrees == 0)
      << d.track().transform.rotationDegrees;
}

TEST(FfmpegDemuxer, HevcConfig) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("hevc_hvc1.mov"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::Hevc);
  EXPECT_FALSE(d.track().codecConfig.empty());
}

TEST(FfmpegDemuxer, MkvOpens) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264.mkv"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::H264);
}

TEST(FfmpegDemuxer, AudioOnly) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("audio_only.m4a"));
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrNoVideoTrack);
}

TEST(FfmpegDemuxer, Vp9Unsupported) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("vp9.webm"));
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrCodecUnsupported);
}

TEST(FfmpegDemuxer, TruncatedCleanError) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("truncated.mp4"));
  if (st.ok) {
    EncodedPacket pkt;
    auto r = d.ReadPacket(0, &pkt);
    EXPECT_TRUE(r.ok || r.errorCode == kErrFileCorrupt ||
                r.errorCode == kErrFrameOutOfRange);
  } else {
    EXPECT_FALSE(st.errorCode.empty());
  }
}

TEST(FfmpegDemuxer, GarbageCleanError) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("garbage.bin"));
  ASSERT_FALSE(st.ok);
  EXPECT_FALSE(st.errorCode.empty());
}

TEST(FfmpegDemuxer, FragmentedMp4) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264_frag.mp4"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
}

TEST(FfmpegDemuxer, EditListOpens) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264_editlist.mp4"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
}

TEST(FfmpegDemuxer, LiveIngestAsFast) {
  auto created = VideoRegistry::Instance().CreateLive(LiveVideoOptions{});
  ASSERT_TRUE(created.ok());
  auto st = LiveIngest::Run(Fixture("h264_gop15_b.mp4"), created.value.get(), {});
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_GT(created.value->Info().frameCount, 0);
  VideoRegistry::Instance().Release(created.value->id());
}
