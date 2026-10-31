#include "VideoTypes.h"
#include "demux/FfmpegProbe.h"

#include <cstdio>
#include <fstream>
#include <string>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

std::string Fixture(const char* name) {
  return std::string("test/fixtures/videobuffer/") + name;
}

bool ContainsIgnoreCase(const std::string& hay, const char* needle) {
  return hay.find(needle) != std::string::npos;
}

}  // namespace

TEST(FfmpegProbe, FfmpegDisabledOrOpens) {
#ifndef HAVE_FFMPEG
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("h264_gop15_b.mp4"), &p);
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrFfmpegDisabled);
#else
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("h264_gop15_b.mp4"), &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_TRUE(ContainsIgnoreCase(p.inputFormatName, "mov") ||
              ContainsIgnoreCase(p.inputFormatName, "mp4"))
      << p.inputFormatName;
  EXPECT_NE(p.codecName.find("h264"), std::string::npos) << p.codecName;
  EXPECT_GT(p.codedWidth, 0);
  EXPECT_GT(p.codedHeight, 0);
  EXPECT_GT(p.durationUs, 0);
#endif
}

#ifdef HAVE_FFMPEG

TEST(FfmpegProbe, HevcMov) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("hevc_hvc1.mov"), &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_NE(p.codecName.find("hevc"), std::string::npos) << p.codecName;
  EXPECT_TRUE(ContainsIgnoreCase(p.inputFormatName, "mov") ||
              ContainsIgnoreCase(p.inputFormatName, "mp4"))
      << p.inputFormatName;
}

TEST(FfmpegProbe, H264Mkv) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("h264.mkv"), &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_NE(p.inputFormatName.find("matroska"), std::string::npos)
      << p.inputFormatName;
  EXPECT_NE(p.codecName.find("h264"), std::string::npos) << p.codecName;
}

TEST(FfmpegProbe, VideoPlusAudioSample) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(
      "example/android/app/src/main/assets/test_videos/sample.mp4", &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_NE(p.codecName.find("h264"), std::string::npos) << p.codecName;
  ASSERT_TRUE(p.audioCodecName.has_value());
  EXPECT_NE(p.audioCodecName->find("aac"), std::string::npos)
      << *p.audioCodecName;
}

TEST(FfmpegProbe, Vp9ReportsCodecWithoutOpen) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("vp9.webm"), &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_NE(p.codecName.find("vp9"), std::string::npos) << p.codecName;
  EXPECT_TRUE(ContainsIgnoreCase(p.inputFormatName, "matroska") ||
              ContainsIgnoreCase(p.inputFormatName, "webm"))
      << p.inputFormatName;
}

TEST(FfmpegProbe, AudioOnlyNoVideoTrack) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("audio_only.m4a"), &p);
  ASSERT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrNoVideoTrack);
}

TEST(FfmpegProbe, GarbageRejected) {
  VideoFileProbe p;
  auto st = ProbeVideoFile(Fixture("garbage.bin"), &p);
  ASSERT_FALSE(st.ok);
  EXPECT_FALSE(st.errorCode.empty());
}

TEST(FfmpegProbe, MislabeledMkvAsMp4SniffsMatroska) {
  const std::string src = Fixture("h264.mkv");
  const std::string dst = "/tmp/vb_probe_mislabeled.mp4";
  {
    std::ifstream in(src, std::ios::binary);
    ASSERT_TRUE(in) << src;
    std::ofstream out(dst, std::ios::binary | std::ios::trunc);
    ASSERT_TRUE(out) << dst;
    out << in.rdbuf();
  }
  VideoFileProbe p;
  auto st = ProbeVideoFile(dst, &p);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_NE(p.inputFormatName.find("matroska"), std::string::npos)
      << p.inputFormatName;
  EXPECT_EQ(p.inputFormatName.find("mp4"), std::string::npos) << p.inputFormatName;
  std::remove(dst.c_str());
}

#endif
