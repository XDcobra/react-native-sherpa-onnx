#include "OfflineVideoEntry.h"
#include "VideoRegistry.h"
#include "audio/VideoAudioExtractor.h"
#include "core/Uuid.h"

#include <atomic>
#include <cstdio>
#include <fstream>
#include <gtest/gtest.h>
#include <string>
#include <vector>

using namespace sherpa_onnx::video;

namespace {

std::string Fixture(const char* name) {
  return std::string("test/fixtures/videobuffer/") + name;
}

bool Exists(const std::string& p) {
  std::ifstream in(p);
  return in.good();
}

std::string TmpF32() {
  return std::string("/tmp/vid_aud_") + UuidV4() + ".f32";
}

int64_t FileSamples(const std::string& path) {
  std::ifstream in(path, std::ios::binary | std::ios::ate);
  if (!in) return 0;
  return static_cast<int64_t>(in.tellg()) / static_cast<int64_t>(sizeof(float));
}

}  // namespace

TEST(AudioExtract, DurationWithinOnePacket) {
  if (!Exists(Fixture("av_h264_aac.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("av_h264_aac.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok()) << opened.status.errorMessage;
  const std::string out = TmpF32();
  AudioExtractOptions opts;
  opts.targetSampleRate = 16000;
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, opts, out, nullptr, nullptr, &r);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(r.sampleRate, 16000);
  EXPECT_EQ(r.sourceSampleRate, 48000);
  EXPECT_EQ(r.sourceChannels, 2);
  const int64_t durUs = opened.value->audioTimeline()->endUs() -
                        opened.value->audioTimeline()->startUs();
  const int64_t expect = durUs * 16000 / 1000000;
  // ±2 AAC frames after 48 kHz → 16 kHz, covering encoder delay/padding.
  EXPECT_NEAR(r.numSamples, expect, 2048 * 16000 / 48000 + 64);
  EXPECT_EQ(FileSamples(out), r.numSamples);
  std::remove(out.c_str());
}

TEST(AudioExtract, LateAudioMediaStart) {
  if (!Exists(Fixture("av_audio_late.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("av_audio_late.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok()) << opened.status.errorMessage;
  const std::string out = TmpF32();
  AudioExtractOptions opts;
  opts.targetSampleRate = 16000;
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, opts, out, nullptr, nullptr, &r);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_GE(r.mediaStartUs, 400000);
  EXPECT_LE(r.mediaStartUs, 600000);
  std::remove(out.c_str());
}

TEST(AudioExtract, RangeTrim) {
  if (!Exists(Fixture("av_h264_aac.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("av_h264_aac.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok());
  const std::string out = TmpF32();
  AudioExtractOptions opts;
  opts.rangeStartUs = 1000000;
  opts.rangeEndUs = 2000000;
  opts.targetSampleRate = 16000;
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, opts, out, nullptr, nullptr, &r);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_EQ(r.mediaStartUs, 1000000);
  EXPECT_NEAR(r.numSamples, 16000, 400);
  std::remove(out.c_str());
}

TEST(AudioExtract, CancelUnlinks) {
  if (!Exists(Fixture("av_h264_aac.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("av_h264_aac.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok());
  const std::string out = TmpF32();
  std::atomic<bool> cancel{true};
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, {}, out, &cancel, nullptr, &r);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrCancelled);
  EXPECT_FALSE(Exists(out));
}

TEST(AudioExtract, UnsupportedAc3) {
  if (!Exists(Fixture("av_h264_ac3.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("av_h264_ac3.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok());
  const std::string out = TmpF32();
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, {}, out, nullptr, nullptr, &r);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrAudioCodecUnsupported);
}

TEST(AudioExtract, TempFileSweep) {
  VideoRegistry::Instance().SetCacheDir("/tmp/vb_extract_sweep");
  const std::string orphan =
      std::string("/tmp/vb_extract_sweep/vid_aud_") + UuidV4() + ".f32";
  {
    std::ofstream out(orphan, std::ios::binary);
    float z = 0;
    out.write(reinterpret_cast<const char*>(&z), sizeof(z));
  }
  ASSERT_TRUE(Exists(orphan));
  const int n = VideoRegistry::Instance().SweepOrphans(-1);
  EXPECT_GE(n, 1);
  EXPECT_FALSE(Exists(orphan));
}

TEST(AudioExtract, NoAudioTrack) {
  if (!Exists(Fixture("h264_gop15_b.mp4"))) {
    GTEST_SKIP();
  }
  auto opened = OfflineVideoEntry::OpenFile(Fixture("h264_gop15_b.mp4"), "/tmp");
  ASSERT_TRUE(opened.ok());
  const std::string out = TmpF32();
  AudioExtractResult r;
  auto st = VideoAudioExtractor::Run(opened.value, {}, out, nullptr, nullptr, &r);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrNoAudioTrack);
}
