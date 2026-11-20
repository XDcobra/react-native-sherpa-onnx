#include "punct-text-spacing.h"

#include <gtest/gtest.h>

using sherpaonnx::punct_text::RestoreInputWordBreaks;

TEST(PunctTextSpacing, PutsWordBreaksBackAfterMarks) {
  EXPECT_EQ(RestoreInputWordBreaks("going to be honest it is fine",
                                   "going?to be honest!it is fine."),
            "going? to be honest! it is fine.");
  EXPECT_EQ(RestoreInputWordBreaks("a sentence next sentence", "a sentence.next sentence."),
            "a sentence. next sentence.");
}

TEST(PunctTextSpacing, KeepsNumbersLinksAndChinese) {
  EXPECT_EQ(RestoreInputWordBreaks("it costs 3.5", "it costs 3.5."), "it costs 3.5.");
  EXPECT_EQ(RestoreInputWordBreaks("see www.a.org", "see www.a.org."), "see www.a.org.");
  EXPECT_EQ(RestoreInputWordBreaks("今天 很好", "今天，很好。"), "今天，很好。");
}

TEST(PunctTextSpacing, LeavesOutputAloneWhenTheModelChangedAWord) {
  EXPECT_EQ(RestoreInputWordBreaks("hello world", "hello,word."), "hello,word.");
}

TEST(PunctTextSpacing, ComparesAsciiWithoutCase) {
  EXPECT_EQ(RestoreInputWordBreaks("hello world", "Hello,World."), "Hello, World.");
}
