/**
 * End to end on the host: book.pdf page → PDFium raster → ppocrv6-tiny →
 * reading order + paragraphs (OcrReadingOrder). Skips without PDFium or pack.
 */
#include "OcrFactory.h"
#include "OcrReadingOrder.h"
#include "PdfFeatureGuard.h"
#include "PdfPageRasterizer.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>

using namespace sherpa_onnx::ocr;

namespace {

std::string PpocrPack() {
  if (const char* env = std::getenv("PPOCR_MODEL_DIR")) return env;
  struct stat st {};
  for (const char* d : {"build/ocr-models/ppocrv6-tiny", "dist/ocr-models/ppocrv6-tiny"}) {
    if (::stat(d, &st) == 0) return d;
  }
  return {};
}

OcrResult RecognizeBookPage(int page) {
  sherpa_onnx::pdf::RasterOptions ro;
  ro.pages = {page};
  ro.dpi = 144;
  sherpa_onnx::pdf::PdfSource src;
  src.path = std::string(SHERPA_TEST_SOURCE_DIR) + "/test/fixtures/pdf/book.pdf";
  src.fd = -1;
  auto raster = sherpa_onnx::pdf::RasterizePdfPages(src, ro);
  EXPECT_TRUE(raster.ok) << raster.error_code;
  if (!raster.ok || raster.frames.empty()) return {};
  auto backend = CreateOcrBackend("ppocr");
  OcrLoadOptions opts;
  opts.num_threads = 2;
  backend->Load(PpocrPack(), opts);
  OcrFrameView view;
  view.rgb = raster.frames[0].rgb.data();
  view.width = raster.frames[0].width;
  view.height = raster.frames[0].height;
  OcrResult r = backend->Recognize(view);
  backend->Release();
  return r;
}

std::string NoSpaces(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c != ' ') out.push_back(c);
  }
  return out;
}

#define REQUIRE_PDFIUM_AND_PACK()                                         \
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "no PDFium"; \
  if (PpocrPack().empty()) GTEST_SKIP() << "ppocrv6-tiny pack not found"

}  // namespace

TEST(OcrPdfPages, ParagraphsHeadingAndHyphenOnARealPage) {
  REQUIRE_PDFIUM_AND_PACK();
  OcrResult r = RecognizeBookPage(3);
  ASSERT_FALSE(r.text_utf8.empty());
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  // ppocrv6-tiny drops most spaces in English: compare without them.
  const std::string t = NoSpaces(r.text_utf8);
  // Running header, chapter heading and subheading are their own blocks.
  EXPECT_NE(t.find("ChapterOne\n\nTheBeginning\n\n"), std::string::npos) << r.text_utf8;
  // Paragraphs: wrapped lines joined, the short last line included.
  EXPECT_NE(t.find("greencover.Mostofthempassedwithoutasignal,andsomeofthemnevercameback.\n\n"),
            std::string::npos)
      << r.text_utf8;
  // "exam-" / "ple" across a line break (the tiny model misreads a letter later on).
  EXPECT_NE(t.find("exampleofhow"), std::string::npos) << r.text_utf8;
  // Three body paragraphs after the heading block.
  size_t breaks = 0;
  for (size_t p = t.find("TheBeginning"); (p = t.find("\n\n", p + 1)) != std::string::npos;) ++breaks;
  EXPECT_EQ(breaks, 3u) << r.text_utf8;
  // Spans stay in reading order with ranges into the new text.
  int prev = -1;
  for (const auto& s : r.spans) {
    EXPECT_GT(s.utf16_start, prev);
    prev = s.utf16_start;
  }
}

TEST(OcrPdfPages, TwoColumnsAreReadOneAfterTheOther) {
  REQUIRE_PDFIUM_AND_PACK();
  OcrResult r = RecognizeBookPage(5);
  ArrangeLinesIntoParagraphs(&r, OcrReadingDirection::kLtr);
  const std::string t = NoSpaces(r.text_utf8);
  const size_t first = t.find("firstcolumn");
  const size_t harbour_end = t.find("columnsapart");
  const size_t second = t.find("secondcolumn");
  ASSERT_NE(first, std::string::npos) << t;
  ASSERT_NE(harbour_end, std::string::npos) << t;
  ASSERT_NE(second, std::string::npos) << t;
  EXPECT_LT(first, harbour_end) << t;
  EXPECT_LT(harbour_end, second) << "the left column is read to its end first:\n" << t;
}
