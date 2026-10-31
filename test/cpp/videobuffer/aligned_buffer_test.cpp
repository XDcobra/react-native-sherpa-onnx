#include "core/AlignedBuffer.h"

#include <cstdint>
#include <utility>

#include <gtest/gtest.h>

using sherpa_onnx::video::AlignedBuffer;
using sherpa_onnx::video::kAlignBytes;

TEST(AlignedBuffer, SixtyFourByteAlignment) {
  AlignedBuffer buf;
  auto st = buf.Allocate(100);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  EXPECT_GE(buf.size(), 100u);
  EXPECT_EQ(reinterpret_cast<uintptr_t>(buf.data()) % kAlignBytes, 0u);
}

TEST(AlignedBuffer, RejectsZero) {
  AlignedBuffer buf;
  auto st = buf.Allocate(0);
  EXPECT_FALSE(st.ok);
}

TEST(AlignedBuffer, MoveTransfersOwnership) {
  AlignedBuffer a;
  ASSERT_TRUE(a.Allocate(128).ok);
  uint8_t* p = a.data();
  AlignedBuffer b = std::move(a);
  EXPECT_EQ(b.data(), p);
  EXPECT_TRUE(a.data() == nullptr || a.empty());
}
