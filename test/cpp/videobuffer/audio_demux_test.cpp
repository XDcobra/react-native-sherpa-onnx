#include "audio/AudioPacketReader.h"
#include "demux/FfmpegDemuxer.h"

#include <fstream>
#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

std::string Fixture(const char* name) {
  return std::string("test/fixtures/videobuffer/") + name;
}

bool Exists(const std::string& p) {
  std::ifstream in(p);
  return in.good();
}

}  // namespace

TEST(AudioDemux, NoAudioFileHasNullTrack) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("h264_gop15_b.mp4"));
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_FALSE(d.hasAudio());
  EXPECT_EQ(d.audioTrack(), nullptr);
}

TEST(AudioDemux, AudioOnlyStillNoVideoTrack) {
  FfmpegDemuxer d;
  auto st = d.Open(Fixture("audio_only.m4a"));
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrNoVideoTrack);
}

TEST(AudioDemux, Mp4AacIndexAndPread) {
  const std::string path = Fixture("av_h264_aac.mp4");
  if (!Exists(path)) {
    GTEST_SKIP() << "missing " << path;
  }
  FfmpegDemuxer d;
  auto st = d.Open(path);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_TRUE(d.hasAudio());
  const auto* a = d.audioTrack();
  ASSERT_NE(a, nullptr);
  EXPECT_EQ(a->codec, AudioCodec::Aac);
  EXPECT_TRUE(a->decodable);
  EXPECT_EQ(a->sampleRate, 48000);
  EXPECT_EQ(a->channels, 2);
  EXPECT_GT(d.audioTimeline().size(), 0);
  EncodedPacket pkt;
  ASSERT_TRUE(d.ReadAudioPacket(0, &pkt).ok) << "first audio packet";
  EXPECT_FALSE(pkt.payload.empty());
}

TEST(AudioDemux, Mp4OpenStillNoFullPayloadRead) {
  const std::string path = Fixture("av_h264_aac.mp4");
  if (!Exists(path)) {
    GTEST_SKIP() << "missing " << path;
  }
  FfmpegDemuxer d;
  ASSERT_TRUE(d.Open(path).ok);
  std::ifstream in(path, std::ios::binary | std::ios::ate);
  const auto fileSize = static_cast<int64_t>(in.tellg());
  EXPECT_LE(d.bytesReadDuringOpen(), fileSize);
  EXPECT_TRUE(d.usesPread());
}

TEST(AudioDemux, MkvOpusOpens) {
  const std::string path = Fixture("av_h264_opus.mkv");
  if (!Exists(path)) {
    GTEST_SKIP() << "missing " << path;
  }
  FfmpegDemuxer d;
  auto st = d.Open(path);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_TRUE(d.hasAudio());
  EXPECT_EQ(d.audioTrack()->codec, AudioCodec::Opus);
}

TEST(AudioDemux, UnsupportedAc3NotDecodable) {
  const std::string path = Fixture("av_h264_ac3.mp4");
  if (!Exists(path)) {
    GTEST_SKIP() << "missing " << path;
  }
  FfmpegDemuxer d;
  auto st = d.Open(path);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_TRUE(d.hasAudio());
  EXPECT_EQ(d.audioTrack()->codec, AudioCodec::Unsupported);
  EXPECT_FALSE(d.audioTrack()->decodable);
}
