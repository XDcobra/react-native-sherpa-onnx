#include "core/FileIo.h"
#include "decode/FakeDecoder.h"
#include "live/PacketSpool.h"

#include <unistd.h>

#include <cstdlib>
#include <string>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

std::string TmpDir() {
  char tmpl[] = "/tmp/vbsp_XXXXXX";
  if (mkdtemp(tmpl) == nullptr) {
    return {};
  }
  return tmpl;
}

}  // namespace

TEST(PacketSpool, RoundTrip) {
  auto dir = TmpDir();
  ASSERT_FALSE(dir.empty());
  PacketSpool spool;
  VideoTrackInfo t;
  t.codedWidth = 64;
  t.codedHeight = 48;
  SpoolOptions opts;
  opts.mode = SpoolRetentionMode::Path;
  opts.directory = dir;
  ASSERT_TRUE(spool.Open(dir, "testuuid", t, opts).ok);
  auto p = FakeDecoderBackend::MakePacket(0, 0, 0, kSampleKey);
  ASSERT_TRUE(spool.Enqueue(p).ok);
  EncodedPacket out;
  ASSERT_TRUE(spool.Read(0, &out).ok);
  EXPECT_EQ(out.ptsUs, 0);
  EXPECT_EQ(out.payload.size(), p.payload.size());
  spool.Finish();
}

TEST(PacketSpool, RecoverTruncation) {
  auto dir = TmpDir();
  ASSERT_FALSE(dir.empty());
  PacketSpool spool;
  VideoTrackInfo t;
  SpoolOptions opts;
  opts.mode = SpoolRetentionMode::Path;
  opts.directory = dir;
  ASSERT_TRUE(spool.Open(dir, "recov", t, opts).ok);
  for (int i = 0; i < 5; ++i) {
    auto p = FakeDecoderBackend::MakePacket(i, i * 33333, i * 33333,
                                            i == 0 ? kSampleKey : 0);
    ASSERT_TRUE(spool.Enqueue(p).ok);
  }
  EXPECT_TRUE(spool.Recover());
}

class EnospcIo : public PosixFileIo {
 public:
  int64_t Pwrite(int fd, const void* buf, size_t n, int64_t offset) override {
    (void)fd;
    (void)buf;
    (void)n;
    (void)offset;
    errno = ENOSPC;
    return -1;
  }
};

TEST(PacketSpool, InjectedEnospcRingOnly) {
  auto dir = TmpDir();
  ASSERT_FALSE(dir.empty());
  EnospcIo io;
  SetDefaultFileIoForTest(&io);
  PacketSpool spool;
  VideoTrackInfo t;
  SpoolOptions opts;
  opts.mode = SpoolRetentionMode::Session;
  opts.directory = dir;
  // Open itself uses Pwrite for header → fail or deactivate.
  auto st = spool.Open(dir, "nospc", t, opts);
  SetDefaultFileIoForTest(nullptr);
  if (st.ok) {
    EXPECT_FALSE(spool.active());
  }
}
