// Host tests for the lenient UTF-8 decoder behind sherpaonnx::NewJStringUtf8.
// Regression: STT byte-level BPE tokens with a partial multi-byte character
// (0xE6 0xB5) aborted the app via NewStringUTF under CheckJNI.
#include <gtest/gtest.h>

#include <string>

#include "jni/utf8_lenient.h"

namespace {

std::u16string Decode(const std::string& s) {
  return sherpaonnx::Utf8ToUtf16Lenient(s.data(), s.size());
}

TEST(Utf8Lenient, AsciiAndMultiByte) {
  EXPECT_EQ(Decode("abc"), u"abc");
  EXPECT_EQ(Decode("\xc3\xa4"), u"ä");
  EXPECT_EQ(Decode("\xe6\xb5\xb7"), u"海");
}

TEST(Utf8Lenient, TruncatedSequenceFromBpeToken) {
  EXPECT_EQ(Decode("\xe6\xb5"), u"�");
  EXPECT_EQ(Decode("\xe6\xb5" "a"), u"�" "a");
}

TEST(Utf8Lenient, SupplementaryBecomesSurrogatePair) {
  EXPECT_EQ(Decode("\xf0\x9f\x98\x80"), u"\U0001F600");
}

TEST(Utf8Lenient, InvalidBytesBecomeReplacement) {
  EXPECT_EQ(Decode("\x80" "x"), u"�" "x");
  EXPECT_EQ(Decode("\xc0\x80"), u"�");      // overlong NUL
  EXPECT_EQ(Decode("\xed\xa0\x80"), u"�");  // encoded surrogate
  EXPECT_EQ(Decode("\xff"), u"�");
}

TEST(Utf8Lenient, EmbeddedNulIsKept) {
  EXPECT_EQ(Decode(std::string("a\0b", 3)), std::u16string(u"a\0b", 3));
}

}  // namespace
