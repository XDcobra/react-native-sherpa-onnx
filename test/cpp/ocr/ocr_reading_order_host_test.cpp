#include "OcrReadingOrder.h"
#include "OcrTextUtils.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

using namespace sherpa_onnx::ocr;

namespace {

struct Box {
  const char* text;
  float x0, y0, x1, y1;
};

/** A line-level result as a detector returns it: lines joined by "\n". */
OcrResult Lines(const std::vector<Box>& boxes) {
  OcrResult r;
  int cursor = 0;
  for (const Box& b : boxes) {
    if (!r.text_utf8.empty()) {
      r.text_utf8.push_back('\n');
      cursor += 1;
    }
    OcrSpan s;
    s.utf16_start = cursor;
    r.text_utf8 += b.text;
    cursor += Utf8ToUtf16Length(b.text);
    s.utf16_end = cursor;
    const float q[8] = {b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1};
    for (int k = 0; k < 8; ++k) s.quad.xy[k] = q[k];
    s.confidence = 0.9f;
    r.spans.push_back(s);
  }
  return r;
}

std::string SpanText(const OcrResult& r, size_t i) {
  // ASCII fixtures: UTF-16 offsets equal byte offsets.
  return r.text_utf8.substr(r.spans[i].utf16_start, r.spans[i].utf16_end - r.spans[i].utf16_start);
}

}  // namespace

TEST(OcrReadingOrder, ParagraphsFromGapsIndentAndShortLines) {
  // Line height 20; a 30 px gap or an indented line starts a paragraph.
  OcrResult r = Lines({
      {"Chapter One", 50, 40, 250, 64},
      {"The keeper counted the ships", 70, 100, 560, 120},
      {"every evening and wrote them", 50, 124, 560, 144},
      {"into a book.", 50, 148, 200, 168},
      {"On the third night a boat", 70, 172, 560, 192},
      {"came in.", 50, 196, 150, 216},
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8,
            "Chapter One\n\nThe keeper counted the ships every evening and wrote them into a "
            "book.\n\nOn the third night a boat came in.");
  ASSERT_EQ(r.spans.size(), 6u);
  EXPECT_EQ(SpanText(r, 2), "every evening and wrote them");
  EXPECT_FLOAT_EQ(r.spans[2].quad.xy[0], 50.f);
}

TEST(OcrReadingOrder, TwoColumnsReadColumnByColumn) {
  // Rows of both columns share baselines; the gutter (40 px) wins over row gaps.
  OcrResult r = Lines({
      {"Left one", 50, 100, 280, 120},
      {"Right one", 320, 100, 560, 120},
      {"left two", 50, 124, 280, 144},
      {"right two", 320, 124, 560, 144},
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8, "Left one left two\n\nRight one right two");
  OcrResult rtl = Lines({
      {"A1", 50, 100, 280, 120},
      {"B1", 320, 100, 560, 120},
  });
  ArrangeLinesIntoParagraphs(&rtl, OcrReadingDirection::kRtl);
  EXPECT_EQ(rtl.text_utf8, "B1\n\nA1");
}

TEST(OcrReadingOrder, HyphenatedLineEndsRejoin) {
  OcrResult r = Lines({
      {"a single exam-", 50, 100, 560, 120},
      {"ple of it", 50, 124, 300, 144},
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8, "a single example of it");
  EXPECT_EQ(SpanText(r, 0), "a single exam");
  EXPECT_EQ(SpanText(r, 1), "ple of it");
}

TEST(OcrReadingOrder, VerticalTextRightToLeftWithoutSpaces) {
  // Two speech bubbles of vertical columns (manga): right bubble first, and
  // inside it the right column first. CJK lines join without a space.
  OcrResult r = Lines({
      {"\xE3\x81\x8B", 100, 50, 120, 200},  // left bubble, right column
      {"\xE3\x81\x8D", 76, 50, 96, 160},    // left bubble, left column
      {"\xE3\x81\x82", 400, 50, 420, 220},  // right bubble, right column
      {"\xE3\x81\x84", 376, 50, 396, 180},  // right bubble, left column
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kRtl);
  EXPECT_EQ(r.text_utf8, "\xE3\x81\x82\xE3\x81\x84\n\n\xE3\x81\x8B\xE3\x81\x8D");
}

TEST(OcrReadingOrder, LeavesNonLineResultsAlone) {
  OcrResult r = Lines({{"Hello", 0, 0, 0, 0}});  // no geometry
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8, "Hello");
  OcrResult empty;
  ArrangeLinesIntoParagraphs(&empty, OcrReadingDirection::kLtr);
  EXPECT_TRUE(empty.text_utf8.empty());
}

TEST(OcrReadingOrder, LargerTitleLineDoesNotJoinTheText) {
  // A 40 px title right above 20 px body lines, both flush left.
  OcrResult r = Lines({
      {"Hello World", 50, 40, 560, 80},
      {"The keeper counted the ships", 50, 86, 560, 106},
      {"every evening.", 50, 110, 300, 130},
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8, "Hello World\n\nThe keeper counted the ships every evening.");
}

TEST(OcrReadingOrder, RaggedLineEndsWhenTheNextWordWouldHaveFit) {
  // Column edge 560. "short." ends 200 px early while "Another" (~100 px) would
  // have fit: a paragraph end. "counted the" ends 60 px early before
  // "lighthouse" (~120 px): an ordinary wrap.
  OcrResult r = Lines({
      {"The keeper counted the", 50, 40, 500, 60},
      {"lighthouse lamps every night.", 50, 64, 560, 84},
      {"It was short.", 50, 88, 360, 108},
      {"Another day began with fog and", 50, 112, 560, 132},
      {"rain.", 50, 136, 120, 156},
  });
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  EXPECT_EQ(r.text_utf8,
            "The keeper counted the lighthouse lamps every night. It was short.\n\nAnother day "
            "began with fog and rain.");
}
