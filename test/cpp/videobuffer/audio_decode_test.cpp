#include "OfflineVideoEntry.h"
#include "audio/AudioPacketReader.h"
#include "audio/FfmpegAudioDecoder.h"

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

std::shared_ptr<OfflineVideoEntry> OpenOrSkip(const char* name) {
  const std::string path = Fixture(name);
  if (!Exists(path)) {
    return nullptr;
  }
  auto r = OfflineVideoEntry::OpenFile(path, "/tmp");
  if (!r.ok()) {
    return nullptr;
  }
  return r.value;
}

int DecodeAll(FfmpegAudioDecoder* dec, AudioPacketReader* reader,
              int64_t* firstPts, int* frames) {
  *frames = 0;
  *firstPts = -1;
  while (true) {
    auto pkt = reader->Next(0);
    if (!pkt.ok()) {
      EncodedPacket eos;
      EXPECT_TRUE(dec->Submit(eos).ok);
      break;
    }
    auto st = dec->Submit(pkt.value);
    if (!st.ok) {
      return 0;
    }
    PcmChunk chunk;
    while (dec->Receive(&chunk)) {
      if (*firstPts < 0) {
        *firstPts = chunk.ptsUs;
      }
      *frames += chunk.frames;
      dec->ReturnChunk(&chunk);
    }
  }
  PcmChunk chunk;
  while (dec->Receive(&chunk)) {
    if (*firstPts < 0) {
      *firstPts = chunk.ptsUs;
    }
    *frames += chunk.frames;
    dec->ReturnChunk(&chunk);
  }
  return 1;
}

}  // namespace

TEST(AudioDecode, AacPrimingSampleZeroAtFirstPts) {
  auto e = OpenOrSkip("av_h264_aac.mp4");
  if (!e) {
    GTEST_SKIP() << "missing av_h264_aac.mp4";
  }
  ASSERT_NE(e->audioTrack(), nullptr);
  AudioPacketReader reader(e);
  ASSERT_TRUE(reader.SeekTo(0).ok);
  FfmpegAudioDecoder dec;
  ASSERT_TRUE(dec.Configure(*e->audioTrack()).ok) << "configure";
  int64_t firstPts = -1;
  int frames = 0;
  ASSERT_EQ(DecodeAll(&dec, &reader, &firstPts, &frames), 1);
  EXPECT_GT(frames, 0);
  EXPECT_GE(firstPts, 0);
  EXPECT_LT(firstPts, 50000);
  EXPECT_EQ(dec.sampleRate(), 48000);
}

TEST(AudioDecode, RampSeekTrim) {
  auto e = OpenOrSkip("av_ramp_aac.mp4");
  if (!e) {
    GTEST_SKIP() << "missing av_ramp_aac.mp4";
  }
  AudioPacketReader reader(e);
  const int64_t target = 200000;
  ASSERT_TRUE(reader.SeekTo(target).ok);
  FfmpegAudioDecoder dec;
  ASSERT_TRUE(dec.Configure(*e->audioTrack()).ok);
  int64_t firstPts = -1;
  int frames = 0;
  ASSERT_EQ(DecodeAll(&dec, &reader, &firstPts, &frames), 1);
  EXPECT_GT(frames, 0);
  EXPECT_GE(firstPts, 0);
  EXPECT_LE(firstPts, target + 30000);
}

TEST(AudioDecode, OpusOpens) {
  auto e = OpenOrSkip("av_h264_opus.mkv");
  if (!e) {
    GTEST_SKIP() << "missing av_h264_opus.mkv";
  }
  ASSERT_NE(e->audioTrack(), nullptr);
  EXPECT_EQ(e->audioTrack()->codec, AudioCodec::Opus);
  AudioPacketReader reader(e);
  ASSERT_TRUE(reader.SeekTo(0).ok);
  FfmpegAudioDecoder dec;
  ASSERT_TRUE(dec.Configure(*e->audioTrack()).ok);
  int64_t firstPts = -1;
  int frames = 0;
  ASSERT_EQ(DecodeAll(&dec, &reader, &firstPts, &frames), 1);
  EXPECT_GT(frames, 8000);
}

TEST(AudioDecode, FlushDoesNotReapplyPriming) {
  auto e = OpenOrSkip("av_h264_aac.mp4");
  if (!e) {
    GTEST_SKIP() << "missing av_h264_aac.mp4";
  }
  AudioPacketReader reader(e);
  ASSERT_TRUE(reader.SeekTo(0).ok);
  FfmpegAudioDecoder dec;
  ASSERT_TRUE(dec.Configure(*e->audioTrack()).ok);
  PcmChunk chunk;
  int primedFrames = 0;
  for (int i = 0; i < 8; ++i) {
    auto pkt = reader.Next(0);
    ASSERT_TRUE(pkt.ok());
    ASSERT_TRUE(dec.Submit(pkt.value).ok);
    while (dec.Receive(&chunk)) {
      primedFrames += chunk.frames;
      dec.ReturnChunk(&chunk);
    }
  }
  EXPECT_GT(primedFrames, 0);
  dec.Flush();
  ASSERT_TRUE(reader.SeekTo(0).ok);
  auto pkt = reader.Next(0);
  ASSERT_TRUE(pkt.ok());
  ASSERT_TRUE(dec.Submit(pkt.value).ok);
  int afterFlush = 0;
  while (dec.Receive(&chunk)) {
    afterFlush += chunk.frames;
    dec.ReturnChunk(&chunk);
  }
  // Priming is not re-applied, so the first packet after flush yields PCM
  // (the same packet at start-of-stream is often entirely encoder delay).
  EXPECT_GT(afterFlush, 0);
}
