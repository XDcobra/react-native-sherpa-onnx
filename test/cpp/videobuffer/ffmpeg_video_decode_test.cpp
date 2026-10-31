#include "OfflineVideoEntry.h"
#include "VideoPacketReader.h"
#include "decode/DecoderBackend.h"
#include "decode/FfmpegVideoDecoder.h"

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

#ifdef HAVE_FFMPEG
TEST(FfmpegVideoDecode, H264GopDecodesAtLeastOneFrame) {
  RegisterBundledVideoSwDecoders();
  const std::string path = Fixture("h264_gop15_b.mp4");
  if (!Exists(path)) {
    GTEST_SKIP() << "missing h264_gop15_b.mp4";
  }
  auto r = OfflineVideoEntry::OpenFile(path, "/tmp");
  ASSERT_TRUE(r.ok()) << r.status.errorMessage;
  auto e = r.value;
  ASSERT_NE(e->packets(), nullptr);
  FfmpegVideoDecoder dec;
  auto st = dec.Configure(e->packets()->track());
  if (!st.ok && st.errorCode == kErrSwDecoderDisabled) {
    GTEST_SKIP() << "host libav has no H.264 decoder";
  }
  ASSERT_TRUE(st.ok) << st.errorMessage;
  VideoPacketReader reader(e);
  ASSERT_TRUE(reader.SeekToKeyframe(0).ok);
  int frames = 0;
  int64_t lastPts = -1;
  for (int i = 0; i < 64; ++i) {
    auto pkt = reader.Next(0);
    if (!pkt.ok()) break;
    ASSERT_TRUE(dec.Submit(pkt.value).ok) << pkt.status.errorMessage;
    DecodedRawFrame fr;
    while (dec.Receive(&fr)) {
      EXPECT_GT(fr.view.width, 0);
      EXPECT_GT(fr.view.height, 0);
      EXPECT_NE(fr.view.y.data, nullptr);
      if (lastPts >= 0) {
        EXPECT_GE(fr.ptsUs, lastPts);
      }
      lastPts = fr.ptsUs;
      ++frames;
    }
  }
  EXPECT_GT(frames, 0);
  if (e->timeline()) {
    EXPECT_LE(frames, e->timeline()->frameCount());
  }
}

TEST(FfmpegVideoDecode, HevcSkippedUnlessFixturePresent) {
  RegisterBundledVideoSwDecoders();
  const std::string path = Fixture("hevc_basic.mp4");
  if (!Exists(path)) {
    GTEST_SKIP() << "no HEVC fixture";
  }
  auto r = OfflineVideoEntry::OpenFile(path, "/tmp");
  ASSERT_TRUE(r.ok()) << r.status.errorMessage;
  FfmpegVideoDecoder dec;
  auto st = dec.Configure(r.value->packets()->track());
  if (!st.ok && st.errorCode == kErrSwDecoderDisabled) {
    GTEST_SKIP() << "host libav has no HEVC decoder";
  }
  ASSERT_TRUE(st.ok) << st.errorMessage;
}
#endif
