/**
 * End to end on the host: a scanned PDF page (no text layer) → PDFium raster →
 * ppocrv6-tiny → OCR text buffer (as recognize stores it) → reader page
 * document → attached OCR blocks. Skips without PDFium or the model pack.
 */
#include "OcrFactory.h"
#include "OcrReadingOrder.h"
#include "OcrTextData.h"
#include "PdfFeatureGuard.h"
#include "PdfPageRasterizer.h"
#include "reader/ReaderLayout.h"
#include "reader/ReaderRegistry.h"
#include "textbuffer/TxtUtf16.h"

#include <gtest/gtest.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>

using namespace sherpa_onnx;

namespace {

std::string PackDir() {
  if (const char* env = std::getenv("PPOCR_MODEL_DIR")) return env;
  struct stat st {};
  for (const char* d : {"build/ocr-models/ppocrv6-tiny", "dist/ocr-models/ppocrv6-tiny"}) {
    if (::stat(d, &st) == 0) return d;
  }
  return {};
}

/** A text buffer the way OcrEngine + PopulateTextFromOcr fill it for one frame. */
std::shared_ptr<TxtOfflineEntry> RecognizeScanPage(const std::string& imageBufferId) {
  pdf::RasterOptions ro;
  ro.pages = {1};
  ro.dpi = 144;
  pdf::PdfSource src;
  src.path = std::string(SHERPA_TEST_SOURCE_DIR) +
             "/example/android/app/src/main/assets/test_pdfs/scan_only_page.pdf";
  auto raster = pdf::RasterizePdfPages(src, ro);
  EXPECT_TRUE(raster.ok) << raster.error_code << " " << raster.error_message;
  if (!raster.ok || raster.frames.empty()) return nullptr;
  auto backend = ocr::CreateOcrBackend("ppocr");
  ocr::OcrLoadOptions opts;
  opts.num_threads = 2;
  backend->Load(PackDir(), opts);
  ocr::OcrFrameView view;
  view.rgb = raster.frames[0].rgb.data();
  view.width = raster.frames[0].width;
  view.height = raster.frames[0].height;
  ocr::OcrResult r = backend->Recognize(view);
  backend->Release();
  ocr::ArrangeLinesIntoParagraphs(&r, ocr::OcrReadingDirection::kLtr);
  r.frames.push_back({0, 0, txt_utf16_length(r.text_utf8), view.width, view.height});
  const ocr::OcrTextData data = ocr::MakeOcrTextData(imageBufferId, "ppocr", r, nullptr);
  auto entry = std::make_shared<TxtOfflineEntry>();
  EXPECT_TRUE(entry->tryPopulate(r.text_utf8, {}, {}, {}, "", "", "", data.spans));
  EXPECT_TRUE(entry->trySetOcrLayout(data.layout));
  return entry;
}

}  // namespace

TEST(OcrReaderPages, ScannedPageGetsTextBlocksWithPlaces) {
  if (!pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "no PDFium";
  if (PackDir().empty()) GTEST_SKIP() << "ppocrv6-tiny pack not found";
  auto& reg = reader::ReaderRegistry::Instance();
  reader::ReaderError err;
  const std::string id = reg.CreatePages("img_off_scan", {{"page:1", 1}}, "scan", &err);
  ASSERT_FALSE(id.empty()) << err.message;

  auto entry = RecognizeScanPage("img_off_scan");
  ASSERT_TRUE(entry);
  ASSERT_FALSE(entry->text.empty());
  int attached = 0;
  ASSERT_TRUE(reg.AttachPageText(id, entry, &attached, &err)) << err.message;
  EXPECT_GE(attached, 2) << entry->text;

  auto snap = reg.Snapshot(id);
  ASSERT_GE(snap->blocks.size(), 3u);
  EXPECT_EQ(snap->blocks[0].type, reader::ReaderBlockType::Page);
  std::string all;
  for (size_t i = 1; i < snap->blocks.size(); ++i) {
    const auto& b = snap->blocks[i];
    EXPECT_EQ(b.id, "s0.b0.t" + std::to_string(i - 1));
    EXPECT_TRUE(b.hasRect) << b.id;
    EXPECT_GT(b.rect[2], 0.f);
    EXPECT_LE(b.rect[0] + b.rect[2], 1.001f);
    EXPECT_LE(b.rect[1] + b.rect[3], 1.001f);
    if (i > 1) EXPECT_GE(b.rect[1], snap->blocks[i - 1].rect[1]) << "top to bottom";
    all += snap->BlockText(static_cast<int>(i));
  }
  std::string squeezed;
  for (char c : all) {
    if (c != ' ') squeezed.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  }
  EXPECT_NE(squeezed.find("helloworld"), std::string::npos) << all;
  EXPECT_NE(squeezed.find("textlayer"), std::string::npos) << all;

  // Now the page shows its text; the image only in image mode.
  auto rows = reader::PlanRows(*snap, reader::PageDisplay::kText);
  EXPECT_FALSE(rows.front().page);
  EXPECT_EQ(rows.front().coverFirst, 0);
  EXPECT_TRUE(reader::PlanRows(*snap, reader::PageDisplay::kImage).front().page);
  reg.Release(id);
}

// Any OCR family on page 3 of the scanned book ("Chapter One"): set
// OCR_READER_FAMILY (ppocr, doctr, doc_vlm, nemotron_parse, paddleocr_vl) and
// OCR_READER_MODEL_DIR (an unpacked release pack). Prints the reader blocks.
TEST(OcrReaderPages, BookScanPageWithModelFromEnv) {
  const char* family = std::getenv("OCR_READER_FAMILY");
  const char* dir = std::getenv("OCR_READER_MODEL_DIR");
  if (!family || !dir) GTEST_SKIP() << "set OCR_READER_FAMILY and OCR_READER_MODEL_DIR";
  if (!pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "no PDFium";
  pdf::RasterOptions ro;
  ro.pages = {3};
  ro.dpi = 150;
  pdf::PdfSource src;
  src.path = std::string(SHERPA_TEST_SOURCE_DIR) + "/test/fixtures/pdf/book_scan.pdf";
  auto raster = pdf::RasterizePdfPages(src, ro);
  ASSERT_TRUE(raster.ok) << raster.error_code << " " << raster.error_message;
  auto backend = ocr::CreateOcrBackend(family);
  ocr::OcrLoadOptions opts;
  opts.num_threads = 4;
  backend->Load(dir, opts);
  ocr::OcrFrameView view;
  view.rgb = raster.frames[0].rgb.data();
  view.width = raster.frames[0].width;
  view.height = raster.frames[0].height;
  ocr::OcrResult r = backend->Recognize(view);
  backend->Release();
  const std::string fam(family);
  if (r.elements.empty() && (fam == "ppocr" || fam == "doctr" || fam == "paddleocr_vl")) {
    ocr::ArrangeLinesIntoParagraphs(&r, ocr::OcrReadingDirection::kLtr);
  }
  std::printf("[text] %s\n[raw] %.600s\n[elements] %zu [spans] %zu\n", r.text_utf8.c_str(),
              r.raw_utf8.c_str(), r.elements.size(), r.spans.size());
  r.frames.push_back({0, 0, txt_utf16_length(r.text_utf8), view.width, view.height});
  const ocr::OcrTextData data = ocr::MakeOcrTextData("img_off_book", family, r, nullptr);
  auto entry = std::make_shared<TxtOfflineEntry>();
  ASSERT_TRUE(entry->tryPopulate(r.text_utf8, {}, {}, {}, "", "", "", data.spans));
  ASSERT_TRUE(entry->trySetOcrLayout(data.layout));

  auto& reg = reader::ReaderRegistry::Instance();
  reader::ReaderError err;
  const std::string id = reg.CreatePages("img_off_book", {{"page:3", 0}}, "book", &err);
  ASSERT_FALSE(id.empty()) << err.message;
  int attached = 0;
  ASSERT_TRUE(reg.AttachPageText(id, entry, &attached, &err)) << err.message;
  auto snap = reg.Snapshot(id);
  for (size_t i = 1; i < snap->blocks.size(); ++i) {
    const auto& b = snap->blocks[i];
    std::printf("%s type=%d level=%d flags=%u rect=%d [%.2f %.2f %.2f %.2f] lines=%zu | %s\n",
                b.id.c_str(), static_cast<int>(b.type), b.headingLevel, b.flags, b.hasRect ? 1 : 0,
                b.rect[0], b.rect[1], b.rect[2], b.rect[3], b.lines.size(),
                snap->BlockText(static_cast<int>(i)).substr(0, 80).c_str());
  }
  EXPECT_GE(attached, 1) << r.text_utf8;
  reg.Release(id);
}

