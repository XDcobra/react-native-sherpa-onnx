#include "core/FrameSlab.h"

#include <fcntl.h>
#include <unistd.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

#include <gtest/gtest.h>

using sherpa_onnx::video::FrameSlab;
using sherpa_onnx::video::VideoPixelFormat;
using sherpa_onnx::video::kAlignBytes;

namespace {

std::string MakeTmpDir() {
  char tmpl[] = "/tmp/vid_slab_XXXXXX";
  if (mkdtemp(tmpl) == nullptr) {
    return {};
  }
  return tmpl;
}

}  // namespace

TEST(FrameSlab, RamBelowThresholdAligned) {
  FrameSlab slab;
  slab.SetRamThreshold(8 * 1024 * 1024);
  int ix = -1;
  ASSERT_TRUE(slab.Allocate(64, 64, VideoPixelFormat::Nv12, &ix).ok);
  auto* s = slab.Get(ix);
  ASSERT_NE(s, nullptr);
  EXPECT_FALSE(s->mmap);
  EXPECT_EQ(reinterpret_cast<uintptr_t>(s->plane[0]) % kAlignBytes, 0u);
}

TEST(FrameSlab, MmapAboveThresholdUnlinks) {
  auto dir = MakeTmpDir();
  ASSERT_FALSE(dir.empty());
  FrameSlab slab;
  slab.SetCacheDir(dir);
  slab.SetRamThreshold(1024);
  int ix = -1;
  ASSERT_TRUE(slab.Allocate(128, 128, VideoPixelFormat::Rgb24, &ix).ok)
      << "allocate";
  EXPECT_TRUE(slab.slotIsMmap(ix));
  const std::string path = slab.mmapPath();
  ASSERT_EQ(access(path.c_str(), F_OK), 0);
  slab.Reset();
  EXPECT_NE(access(path.c_str(), F_OK), 0);
  rmdir(dir.c_str());
}

TEST(FrameSlab, SeparateMmapFilesDoNotTruncateEachOther) {
  auto dir = MakeTmpDir();
  ASSERT_FALSE(dir.empty());
  FrameSlab a;
  FrameSlab b;
  a.SetCacheDir(dir);
  a.SetMmapKey("buf_a");
  b.SetCacheDir(dir);
  b.SetMmapKey("buf_b");
  a.SetRamThreshold(256);
  b.SetRamThreshold(256);
  int ia = -1;
  int ib = -1;
  ASSERT_TRUE(a.Allocate(64, 64, VideoPixelFormat::Rgb24, &ia).ok);
  ASSERT_TRUE(b.Allocate(64, 64, VideoPixelFormat::Rgb24, &ib).ok);
  EXPECT_NE(a.mmapPath(), b.mmapPath());
  EXPECT_EQ(access(a.mmapPath().c_str(), F_OK), 0);
  EXPECT_EQ(access(b.mmapPath().c_str(), F_OK), 0);
  auto* sa = a.Get(ia);
  auto* sb = b.Get(ib);
  ASSERT_NE(sa, nullptr);
  ASSERT_NE(sb, nullptr);
  ASSERT_NE(sa->plane[0], nullptr);
  ASSERT_NE(sb->plane[0], nullptr);
  ASSERT_GT(sa->bytes, 0);
  std::memset(sa->plane[0], 0xAB, static_cast<size_t>(sa->bytes));
  std::memset(sb->plane[0], 0xCD, static_cast<size_t>(sb->bytes));
  EXPECT_EQ(sa->plane[0][0], static_cast<uint8_t>(0xAB));
  EXPECT_EQ(sb->plane[0][0], static_cast<uint8_t>(0xCD));
  EXPECT_EQ(sa->plane[0][sa->bytes - 1], static_cast<uint8_t>(0xAB));
  a.Reset();
  b.Reset();
  rmdir(dir.c_str());
}

TEST(FrameSlab, SlotReuseAfterUnpin) {
  FrameSlab slab;
  slab.SetRamThreshold(32 * 1024 * 1024);
  int a = -1;
  int b = -1;
  ASSERT_TRUE(slab.Allocate(32, 32, VideoPixelFormat::Gray8, &a).ok);
  slab.Pin(a);
  ASSERT_TRUE(slab.Allocate(32, 32, VideoPixelFormat::Gray8, &b).ok);
  slab.Pin(b);
  slab.Unpin(a);
  slab.FreeUnpinned();
  EXPECT_EQ(slab.Get(a), nullptr);
  EXPECT_NE(slab.Get(b), nullptr);
}

TEST(FrameSlab, SparseOffsetOver4GiB) {
  auto dir = MakeTmpDir();
  ASSERT_FALSE(dir.empty());
  FrameSlab slab;
  slab.SetCacheDir(dir);
  int ix = -1;
  const int64_t off = (1LL << 32) + 4096;
  auto st = slab.AllocateSparseForTest(off, 4096, &ix);
  if (!st.ok) {
    GTEST_SKIP() << "sparse mmap not supported: " << st.errorMessage;
  }
  auto* s = slab.Get(ix);
  ASSERT_NE(s, nullptr);
  ASSERT_NE(s->plane[0], nullptr);
  s->plane[0][0] = 0xAB;
  EXPECT_EQ(s->plane[0][0], 0xAB);
  slab.Reset();
  rmdir(dir.c_str());
}
