#include "core/FileIo.h"
#include "decode/FakeDecoder.h"
#include "live/AudioPacketRing.h"
#include "live/LiveVideoEntry.h"
#include "live/PacketSpool.h"

#include <unistd.h>

#include <cstdlib>
#include <string>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

std::string TmpDir() {
  char tmpl[] = "/tmp/vbaudio_XXXXXX";
  if (mkdtemp(tmpl) == nullptr) return {};
  return tmpl;
}

EncodedPacket AudioPkt(int64_t pts, size_t n) {
  EncodedPacket p;
  p.ptsUs = pts;
  p.payload.assign(n, 0xAB);
  return p;
}

}  // namespace

TEST(LiveAudio, RingEvictsWithVideoStart) {
  AudioPacketRing ring;
  ring.Configure(1, 1024 * 1024);
  AudioTimeline tl;
  for (int i = 0; i < 20; ++i) {
    ASSERT_TRUE(ring.Append(AudioPkt(i * 100000, 64), &tl).ok);
  }
  ring.EvictBefore(1'000'000);
  EXPECT_GE(ring.rangeUs().startUs, 1'000'000 - 100000);
}

TEST(LiveAudio, SpoolV2AudioRoundTrip) {
  auto dir = TmpDir();
  ASSERT_FALSE(dir.empty());
  PacketSpool spool;
  VideoTrackInfo t;
  t.codedWidth = 16;
  t.codedHeight = 16;
  AudioTrackInfo a;
  a.codec = AudioCodec::Aac;
  a.sampleRate = 48000;
  a.channels = 2;
  a.decodable = true;
  SpoolOptions opts;
  opts.mode = SpoolRetentionMode::Path;
  opts.directory = dir;
  ASSERT_TRUE(spool.Open(dir, "auduuid", t, opts, &a).ok);
  auto v = FakeDecoderBackend::MakePacket(0, 0, 0, kSampleKey);
  ASSERT_TRUE(spool.Enqueue(v).ok);
  auto ap = AudioPkt(0, 32);
  ASSERT_TRUE(spool.EnqueueAudio(ap).ok);
  EncodedPacket out;
  ASSERT_TRUE(spool.Read(0, &out).ok);
  EncodedPacket aout;
  ASSERT_TRUE(spool.ReadAudio(0, &aout).ok);
  EXPECT_EQ(aout.payload.size(), 32u);
  EXPECT_EQ(spool.audioCount(), 1);
  EXPECT_TRUE(spool.Recover());
  spool.Finish();
}

TEST(LiveAudio, LiveEntryAudioWriter) {
  LiveVideoOptions opts;
  opts.spool.mode = SpoolRetentionMode::None;
  auto e = LiveVideoEntry::Create(opts, "/tmp");
  ASSERT_NE(e, nullptr);
  VideoTrackInfo t;
  t.codedWidth = 16;
  t.codedHeight = 16;
  ASSERT_TRUE(e->SetCodecConfig(VideoCodec::H264, {}, t).ok);
  AudioTrackInfo a;
  a.codec = AudioCodec::Aac;
  a.sampleRate = 48000;
  a.channels = 2;
  a.decodable = true;
  ASSERT_TRUE(e->SetAudioConfig(a).ok);
  auto v = FakeDecoderBackend::MakePacket(0, 0, 0, kSampleKey);
  ASSERT_TRUE(e->AppendPacket(v).ok);
  ASSERT_TRUE(e->AppendAudioPacket(AudioPkt(0, 16)).ok);
  EncodedPacket out;
  ASSERT_TRUE(e->ReadAudioPacket(0, &out).ok);
  EXPECT_EQ(out.payload.size(), 16u);
  auto info = e->Info();
  ASSERT_TRUE(info.audio.has_value());
  EXPECT_EQ(info.audio->sampleRate, 48000);
}
