#include "VideoRegistry.h"
#include "demux/FfmpegDemuxer.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <fstream>
#include <string>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
}

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
  // Tiny committed fixtures (~2 KB) may be fully probed, and moov is read a
  // second time for the ctts offsets; the open path is still index+pread, not
  // av_read_frame payload decode (see MovReorderedOpenNoPacketPayloads).
  EXPECT_LE(openBytes, 2 * fileSize);
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

TEST(FfmpegDemuxer, MkvWithoutCuesBuildsPacketIndex) {
  FfmpegDemuxer d;
  auto st = d.Open(
      "example/android/app/src/main/assets/test_videos/sample.mkv");
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::H264);
  EXPECT_GE(d.timeline().frameCount(), 10)
      << "matroska cues-only must expand to every packet";
  EXPECT_TRUE(d.frameCountExact());
  SampleEntry s;
  ASSERT_TRUE(d.timeline().Get(0, &s).ok);
  EncodedPacket pkt;
  ASSERT_TRUE(d.ReadPacket(0, &pkt).ok) << "first packet after scan";
  EXPECT_FALSE(pkt.payload.empty());
}

TEST(FfmpegDemuxer, WebmWithoutCuesBuildsPacketIndex) {
  FfmpegDemuxer d;
  auto st = d.Open(
      "example/android/app/src/main/assets/test_videos/sample.webm");
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::H264);
  EXPECT_GE(d.timeline().frameCount(), 10)
      << "webm cues-only must expand to every packet";
  EXPECT_TRUE(d.frameCountExact());
}

TEST(FfmpegDemuxer, AudioOnly) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("audio_only.m4a"));
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrNoVideoTrack);
}

TEST(FfmpegDemuxer, Vp9Opens) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("vp9.webm"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(d.track().codec, VideoCodec::Vp9);
  EXPECT_GT(d.timeline().frameCount(), 0);
  EXPECT_GE(d.timeline().ClosestKeyframe(0), 0);
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

namespace {

struct PacketTimes {
  int64_t ptsUs = 0;
  int64_t dtsUs = 0;
};

// Video packet times as FFmpeg's own packet reader reports them, in
// presentation order. MOV index entries carry the DTS only; the PTS
// (DTS + ctts) exists on read packets, so this is the reference.
std::vector<PacketTimes> ReadFramePacketTimes(const std::string& path) {
  std::vector<PacketTimes> out;
  AVFormatContext* fmt = nullptr;
  if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) {
    return out;
  }
  const int vs =
      av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  AVPacket* pkt = av_packet_alloc();
  while (vs >= 0 && av_read_frame(fmt, pkt) >= 0) {
    if (pkt->stream_index == vs) {
      const AVRational tb = fmt->streams[vs]->time_base;
      const int64_t pts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
      out.push_back({av_rescale_q(pts, tb, {1, 1000000}),
                     av_rescale_q(pkt->dts, tb, {1, 1000000})});
    }
    av_packet_unref(pkt);
  }
  av_packet_free(&pkt);
  avformat_close_input(&fmt);
  std::stable_sort(out.begin(), out.end(),
                   [](const PacketTimes& a, const PacketTimes& b) {
                     return a.ptsUs < b.ptsUs;
                   });
  return out;
}

class MovIndexTimesTest : public ::testing::TestWithParam<const char*> {};

}  // namespace

// B-frame streams decode out of presentation order. Each timeline sample must
// carry its real presentation time; DTS in its place showed the frames in
// decode order (I P B B …: playback stepping back and forth).
TEST_P(MovIndexTimesTest, TimelineMatchesPacketTimes) {
  const std::string path = Fixture(GetParam());
  const auto expected = ReadFramePacketTimes(path);
  ASSERT_FALSE(expected.empty());
  FfmpegDemuxer d;
  auto st = d.Open(path);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_EQ(d.timeline().frameCount(), static_cast<int64_t>(expected.size()));
  for (size_t i = 0; i < expected.size(); ++i) {
    SampleEntry s;
    ASSERT_TRUE(d.timeline().Get(static_cast<int64_t>(i), &s).ok);
    EXPECT_EQ(s.ptsUs, expected[i].ptsUs) << "presentation index " << i;
    EXPECT_EQ(s.dtsUs, expected[i].dtsUs) << "presentation index " << i;
  }
  // Packets read in decode order carry the same times.
  for (int64_t dec = 0; dec < d.timeline().frameCount(); ++dec) {
    EncodedPacket pkt;
    ASSERT_TRUE(d.ReadPacket(dec, &pkt).ok);
    SampleEntry s;
    ASSERT_TRUE(d.GetSample(dec, &s).ok);
    EXPECT_EQ(pkt.ptsUs, s.ptsUs) << "decode index " << dec;
    if (dec > 0) {
      SampleEntry prev;
      ASSERT_TRUE(d.GetSample(dec - 1, &prev).ok);
      EXPECT_LT(prev.dtsUs, s.dtsUs) << "decode index " << dec;
    }
  }
}

INSTANTIATE_TEST_SUITE_P(Fixtures, MovIndexTimesTest,
                         ::testing::Values("av_h264_aac.mp4", "hevc_hvc1.mov",
                                           "h264_gop15_b.mp4",
                                           "h264_editlist.mp4",
                                           "h264_vfr.mp4", "h264_frag.mp4"));

TEST(FfmpegDemuxer, MovReorderedOpenNoPacketPayloads) {
  // The PTS fix must not turn the MOV open into a full packet scan.
  FfmpegDemuxer d;
  ASSERT_TRUE(d.Open(Fixture("av_h264_aac.mp4")).ok);
  std::ifstream in(Fixture("av_h264_aac.mp4"), std::ios::binary | std::ios::ate);
  const auto fileSize = static_cast<int64_t>(in.tellg());
  EXPECT_LT(d.bytesReadDuringOpen(), fileSize / 2);
}

TEST(FfmpegDemuxer, LiveIngestAsFast) {
  auto created = VideoRegistry::Instance().CreateLive(LiveVideoOptions{});
  ASSERT_TRUE(created.ok());
  auto st = LiveIngest::Run(Fixture("h264_gop15_b.mp4"), created.value.get(), {});
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_GT(created.value->Info().frameCount, 0);
  VideoRegistry::Instance().Release(created.value->id());
}
