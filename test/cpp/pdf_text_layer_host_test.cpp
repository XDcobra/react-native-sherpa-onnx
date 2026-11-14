#include "PdfDocument.h"
#include "PdfFeatureGuard.h"
#include "PdfLazySession.h"
#include "PdfPageRasterizer.h"
#include "PdfStructureBuilder.h"
#include "PdfTextLayerExtractor.h"
#include "PdfTypes.h"
#include "textbuffer/TxtStructure.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <thread>
#include <vector>
#include <string>

#include <gtest/gtest.h>

namespace {

std::string FixturePath(const char* name) {
#ifndef SHERPA_TEST_SOURCE_DIR
#define SHERPA_TEST_SOURCE_DIR "."
#endif
  return std::string(SHERPA_TEST_SOURCE_DIR) + "/test/fixtures/pdf/" + name;
}

sherpa_onnx::pdf::PdfSource Src(const std::string& path) {
  sherpa_onnx::pdf::PdfSource s;
  s.path = path;
  s.fd = -1;
  return s;
}

}  // namespace

TEST(PdfTextLayerHost, ReportsCompiledInConsistentWithMacro) {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  EXPECT_TRUE(sherpa_onnx::pdf::IsPdfiumCompiledIn());
#else
  EXPECT_FALSE(sherpa_onnx::pdf::IsPdfiumCompiledIn());
#endif
}

TEST(PdfTextLayerHost, DisabledBuildReturnsPdfiumDisabled) {
  if (sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium linked; disabled-path test skipped";
  }
  const auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(Src("/tmp/unused.pdf"), {});
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.error_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_NE(r.error_message.find("sherpaOnnxEnablePdfium"), std::string::npos);
}

TEST(PdfRasterHost, DisabledBuildReturnsPdfiumDisabled) {
  if (sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium linked; disabled-path test skipped";
  }
  const auto r = sherpa_onnx::pdf::RasterizePdfPages(Src("/tmp/unused.pdf"), {});
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.error_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_TRUE(r.frames.empty());
}

TEST(PdfLazySessionHost, DisabledBuildOpenReturnsPdfiumDisabled) {
  if (sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium linked; disabled-path test skipped";
  }
  std::string err_code;
  std::string err_msg;
  auto session = sherpa_onnx::pdf::PdfLazySession::Open(
      Src("/tmp/unused.pdf"), 144, 4096, &err_code, &err_msg);
  EXPECT_EQ(session, nullptr);
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_NE(err_msg.find("sherpaOnnxEnablePdfium"), std::string::npos);
}

TEST(PdfDocumentHost, OpenPathAndFdWhenPdfiumLinked) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  const auto path = FixturePath("tiny-hello.pdf");
  ASSERT_EQ(::access(path.c_str(), R_OK), 0) << "missing fixture " << path;

  std::string err_code;
  std::string err_msg;
  auto from_path = sherpa_onnx::pdf::PdfDocument::OpenPath(
      path.c_str(), &err_code, &err_msg);
  ASSERT_TRUE(from_path.ok()) << err_code << " " << err_msg;
  EXPECT_GE(from_path.page_count(), 1);

  const int fd = ::open(path.c_str(), O_RDONLY);
  ASSERT_GE(fd, 0);
  err_code.clear();
  err_msg.clear();
  auto from_fd = sherpa_onnx::pdf::PdfDocument::OpenFd(fd, &err_code, &err_msg);
  ::close(fd);
  ASSERT_TRUE(from_fd.ok()) << err_code << " " << err_msg;
  EXPECT_EQ(from_fd.page_count(), from_path.page_count());

  const auto extracted =
      sherpa_onnx::pdf::ExtractPdfTextLayer(Src(path), {});
  ASSERT_TRUE(extracted.ok) << extracted.error_code << " "
                            << extracted.error_message;
  EXPECT_NE(extracted.text.find("Hello"), std::string::npos);
}

TEST(PdfDocumentHost, EncryptedPasswordWhenPdfiumLinked) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  const auto path = FixturePath("hello-encrypted.pdf");
  ASSERT_EQ(::access(path.c_str(), R_OK), 0) << "missing fixture " << path;

  std::string err_code;
  std::string err_msg;
  auto missing = sherpa_onnx::pdf::PdfDocument::OpenPath(
      path.c_str(), &err_code, &err_msg);
  EXPECT_FALSE(missing.ok());
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrEncrypted);

  err_code.clear();
  err_msg.clear();
  auto wrong = sherpa_onnx::pdf::PdfDocument::OpenPath(
      path.c_str(), &err_code, &err_msg, "nope");
  EXPECT_FALSE(wrong.ok());
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrEncrypted);

  err_code.clear();
  err_msg.clear();
  auto ok_doc = sherpa_onnx::pdf::PdfDocument::OpenPath(
      path.c_str(), &err_code, &err_msg, "secret");
  ASSERT_TRUE(ok_doc.ok()) << err_code << " " << err_msg;
  EXPECT_GE(ok_doc.page_count(), 1);

  const int fd = ::open(path.c_str(), O_RDONLY);
  ASSERT_GE(fd, 0);
  err_code.clear();
  err_msg.clear();
  auto from_fd = sherpa_onnx::pdf::PdfDocument::OpenFd(
      fd, &err_code, &err_msg, "secret");
  ::close(fd);
  ASSERT_TRUE(from_fd.ok()) << err_code << " " << err_msg;

  sherpa_onnx::pdf::ExtractOptions opts;
  opts.password = "secret";
  const auto extracted =
      sherpa_onnx::pdf::ExtractPdfTextLayer(Src(path), opts);
  ASSERT_TRUE(extracted.ok) << extracted.error_code << " "
                            << extracted.error_message;
  EXPECT_NE(extracted.text.find("Hello"), std::string::npos);

  const auto denied = sherpa_onnx::pdf::ExtractPdfTextLayer(Src(path), {});
  EXPECT_FALSE(denied.ok);
  EXPECT_EQ(denied.error_code, sherpa_onnx::pdf::kErrEncrypted);
}

TEST(PdfDocumentHost, TruncatedAndGarbageOpenFailedWhenPdfiumLinked) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  const auto truncated = FixturePath("truncated.pdf");
  const auto garbage = FixturePath("garbage.bin");
  ASSERT_EQ(::access(truncated.c_str(), R_OK), 0);
  ASSERT_EQ(::access(garbage.c_str(), R_OK), 0);

  std::string err_code;
  std::string err_msg;
  auto a = sherpa_onnx::pdf::PdfDocument::OpenPath(
      truncated.c_str(), &err_code, &err_msg);
  EXPECT_FALSE(a.ok());
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrOpenFailed);

  err_code.clear();
  err_msg.clear();
  auto b = sherpa_onnx::pdf::PdfDocument::OpenPath(
      garbage.c_str(), &err_code, &err_msg);
  EXPECT_FALSE(b.ok());
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrOpenFailed);
}

// ---- book.pdf (gen_pdf_fixtures.py): real text layer + raster with PDFium ----

TEST(PdfBookHost, TextLayerPagesSpansAndQuads) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  const auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(Src(FixturePath("book.pdf")), {});
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  EXPECT_EQ(r.page_count, 6);
  EXPECT_EQ(r.pages_with_text, 5);  // page 6 is an image only
  for (const char* s : {"A Short Test Book", "Chapter One", "The Beginning", "Chapter Two",
                        "first column", "second column"}) {
    EXPECT_NE(r.text.find(s), std::string::npos) << s;
  }
  ASSERT_FALSE(r.spans.empty());
  int prev_page = 0;
  int prev_end = 0;
  for (const auto& s : r.spans) {
    EXPECT_GE(s.page_number, 1);
    EXPECT_LE(s.page_number, 5);
    EXPECT_GE(s.page_number, prev_page) << "spans are in page order";
    EXPECT_EQ(s.frame_index, s.page_number - 1);
    EXPECT_FLOAT_EQ(s.page_width, 595.f);
    EXPECT_FLOAT_EQ(s.page_height, 842.f);
    EXPECT_LT(s.utf16_start, s.utf16_end);
    EXPECT_GE(s.utf16_start, prev_end);
    for (int i = 0; i < 8; i += 2) {
      EXPECT_GE(s.quad[i], -1.f);
      EXPECT_LE(s.quad[i], 596.f);
      EXPECT_GE(s.quad[i + 1], -1.f);
      EXPECT_LE(s.quad[i + 1], 843.f);
    }
    prev_page = s.page_number;
    prev_end = s.utf16_end;
  }
}

TEST(PdfBookHost, SelectedPagesOnly) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  sherpa_onnx::pdf::ExtractOptions opts;
  opts.pages = {4};
  const auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(Src(FixturePath("book.pdf")), opts);
  ASSERT_TRUE(r.ok) << r.error_code;
  EXPECT_NE(r.text.find("Chapter Two"), std::string::npos);
  EXPECT_EQ(r.text.find("Chapter One"), std::string::npos);
  for (const auto& s : r.spans) EXPECT_EQ(s.page_number, 4);
}

TEST(PdfBookHost, ImageOnlyPageHasNoTextLayer) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  sherpa_onnx::pdf::ExtractOptions opts;
  opts.pages = {6};
  const auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(Src(FixturePath("book.pdf")), opts);
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.error_code, sherpa_onnx::pdf::kErrNoTextLayer);
}

TEST(PdfBookHost, RasterPageSizeFollowsDpiAndMaxSide) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  sherpa_onnx::pdf::RasterOptions opts;
  opts.pages = {1, 6};
  opts.dpi = 72;  // 1 px per point
  const auto r = sherpa_onnx::pdf::RasterizePdfPages(Src(FixturePath("book.pdf")), opts);
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  EXPECT_EQ(r.page_count, 6);
  ASSERT_EQ(r.frames.size(), 2u);
  EXPECT_EQ(r.frames[0].width, 595);
  EXPECT_EQ(r.frames[0].height, 842);
  EXPECT_EQ(r.frames[0].pageNumber, 1);
  EXPECT_EQ(r.frames[1].pageNumber, 6);
  // Page 6 shows the plate: the centre pixel is not white.
  const auto& f = r.frames[1];
  const size_t c = (static_cast<size_t>(f.height / 2) * f.width + f.width / 2) * 3;
  ASSERT_LT(c + 2, f.rgb.size());
  EXPECT_LT(static_cast<int>(f.rgb[c]) + f.rgb[c + 1] + f.rgb[c + 2], 3 * 250);

  opts.pages = {1};
  opts.dpi = 144;
  opts.max_side = 400;
  const auto capped = sherpa_onnx::pdf::RasterizePdfPages(Src(FixturePath("book.pdf")), opts);
  ASSERT_TRUE(capped.ok);
  ASSERT_EQ(capped.frames.size(), 1u);
  EXPECT_EQ(std::max(capped.frames[0].width, capped.frames[0].height), 400);
}

TEST(PdfBookHost, ParallelExtractAndRasterAreSerialized) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium not linked";
  }
  // PDFium has global state; without the process-wide lock this races.
  std::atomic<int> failures{0};
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t) {
    threads.emplace_back([t, &failures]() {
      for (int i = 0; i < 6; ++i) {
        if ((t + i) % 2 == 0) {
          const auto r =
              sherpa_onnx::pdf::ExtractPdfTextLayer(Src(FixturePath("book.pdf")), {});
          if (!r.ok || r.text.find("Chapter Two") == std::string::npos) ++failures;
        } else {
          sherpa_onnx::pdf::RasterOptions o;
          o.pages = {1 + (i % 6)};
          o.dpi = 36;
          const auto r = sherpa_onnx::pdf::RasterizePdfPages(Src(FixturePath("book.pdf")), o);
          if (!r.ok || r.frames.size() != 1) ++failures;
        }
      }
    });
  }
  for (auto& th : threads) th.join();
  EXPECT_EQ(failures.load(), 0);
}

// ---- layout "paragraphs": reading structure from the text layer ----------

namespace {

using sherpa_onnx::pdf::PdfLine;
using sherpa_onnx::pdf::PdfPageText;

std::string BlockText(const std::string& text, const TxtStructBlock& b) {
  // Fixture text is ASCII: UTF-16 offsets are byte offsets.
  return text.substr(static_cast<size_t>(b.utf16Start),
                     static_cast<size_t>(b.utf16End - b.utf16Start));
}

const TxtStructBlock* FindBlock(const sherpa_onnx::pdf::PdfTextLayerResult& r,
                                const std::string& prefix) {
  for (const auto& b : r.structure->blocks) {
    if (BlockText(r.text, b).rfind(prefix, 0) == 0) return &b;
  }
  return nullptr;
}

sherpa_onnx::pdf::PdfTextLayerResult ExtractBookParagraphs(std::vector<int> pages = {}) {
  sherpa_onnx::pdf::ExtractOptions opts;
  opts.layout = sherpa_onnx::pdf::PdfTextLayout::kParagraphs;
  opts.pages = std::move(pages);
  return sherpa_onnx::pdf::ExtractPdfTextLayer(Src(FixturePath("book.pdf")), opts);
}

}  // namespace

TEST(PdfBookParagraphs, SectionsPerPageWithLabelsAndPageBlocks) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs();
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  const TxtStructure& st = *r.structure;
  EXPECT_EQ(st.format, "pdf");
  EXPECT_EQ(st.version, sherpa_onnx::pdf::kPdfStructureVersion);
  EXPECT_EQ(st.title, "A Short Test Book");
  EXPECT_EQ(st.creator, "Ada Example");
  EXPECT_EQ(st.language, "en-GB");
  EXPECT_EQ(r.page_count, 6);
  EXPECT_EQ(r.pages_with_text, 5);
  ASSERT_EQ(st.sections.size(), 6u);
  const char* labels[] = {"i", "ii", "1", "2", "3", "4"};
  for (int i = 0; i < 6; ++i) {
    const TxtStructSection& sec = st.sections[static_cast<size_t>(i)];
    EXPECT_EQ(sec.sectionIndex, i);
    EXPECT_EQ(sec.kind, "page");
    EXPECT_EQ(sec.href, "page:" + std::to_string(i + 1));
    EXPECT_EQ(sec.label, labels[i]);
    ASSERT_GE(sec.blockCount, 1);
    const TxtStructBlock& page = st.blocks[static_cast<size_t>(sec.firstBlock)];
    EXPECT_EQ(page.type, TxtBlockType::Page);
    EXPECT_EQ(page.blockIndex, 0);
    EXPECT_EQ(page.frameIndex, i);
    EXPECT_EQ(page.utf16Start, page.utf16End);
  }
  // The image-only plate is a page without text.
  EXPECT_EQ(st.sections[5].blockCount, 1);
  EXPECT_EQ(st.sections[5].title, "Plates");
  EXPECT_EQ(st.sections[5].titleSource, "toc");
}

TEST(PdfBookParagraphs, ParagraphsHeadingsAndFurniture) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs();
  ASSERT_TRUE(r.ok && r.structure);

  const TxtStructBlock* title = FindBlock(r, "A Short Test Book");
  ASSERT_TRUE(title);
  EXPECT_EQ(title->type, TxtBlockType::Heading);
  EXPECT_EQ(title->headingLevel, 1);
  EXPECT_EQ(title->sectionIndex, 0);
  const TxtStructBlock* chapter = FindBlock(r, "Chapter One");
  ASSERT_TRUE(chapter);
  EXPECT_EQ(chapter->type, TxtBlockType::Heading);
  EXPECT_EQ(chapter->headingLevel, 2);
  const TxtStructBlock* preface = FindBlock(r, "Preface");
  ASSERT_TRUE(preface);
  EXPECT_EQ(preface->headingLevel, 2) << "18 pt and 20 pt share a level";
  const TxtStructBlock* sub = FindBlock(r, "The Beginning");
  ASSERT_TRUE(sub);
  EXPECT_EQ(sub->headingLevel, 3);

  // Wrapped lines form one paragraph; the hyphenated word is rejoined.
  const TxtStructBlock* keeper = FindBlock(r, "The keeper had seen");
  ASSERT_TRUE(keeper);
  EXPECT_EQ(keeper->type, TxtBlockType::Paragraph);
  const std::string kt = BlockText(r.text, *keeper);
  EXPECT_NE(kt.find("an example of how little"), std::string::npos) << kt;
  EXPECT_EQ(kt.find('\n'), std::string::npos);
  EXPECT_EQ(r.text.find("exam-"), std::string::npos);
  const TxtStructBlock* storm = FindBlock(r, "On the third night");
  ASSERT_TRUE(storm);
  EXPECT_NE(BlockText(r.text, *storm).find("stove. He climbed down"), std::string::npos);
  EXPECT_TRUE(BlockText(r.text, *storm).find("coat and the") != std::string::npos)
      << "the paragraph runs to the end of the page";

  // Running header and page numbers (pages 3–5) are kept, flagged as furniture.
  int furniture = 0;
  for (const auto& b : r.structure->blocks) {
    if (!(b.flags & kTxtBlockFurniture)) continue;
    ++furniture;
    const std::string t = BlockText(r.text, b);
    EXPECT_TRUE(t == "A Short Test Book" || t == "1" || t == "2" || t == "3") << t;
    EXPECT_GE(b.sectionIndex, 2);
  }
  EXPECT_EQ(furniture, 6);
  EXPECT_FALSE(title->flags & kTxtBlockFurniture) << "the title page has no running header";

  // Rectangles are normalized to the page.
  ASSERT_TRUE(chapter->hasRect);
  EXPECT_NEAR(chapter->rect[0], 72.f / 595.f, 0.01f);
  EXPECT_GT(chapter->rect[2], 0.f);
  EXPECT_LT(chapter->rect[1] + chapter->rect[3], 0.2f);
}

TEST(PdfBookParagraphs, TwoColumnsKeepTheirOrder) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs({5});
  ASSERT_TRUE(r.ok && r.structure);
  ASSERT_EQ(r.structure->sections.size(), 1u);
  EXPECT_EQ(r.structure->sections[0].sectionIndex, 4);
  const TxtStructBlock* left = FindBlock(r, "The first column");
  const TxtStructBlock* right = FindBlock(r, "The second column");
  ASSERT_TRUE(left && right);
  EXPECT_LT(left->blockIndex, right->blockIndex);
  EXPECT_NE(BlockText(r.text, *left).find("tell the columns apart."), std::string::npos)
      << "the left column is one paragraph";
  EXPECT_LT(left->rect[0], 0.5f);
  EXPECT_GT(right->rect[0], 0.5f);
}

TEST(PdfBookParagraphs, ContentsFromTheOutline) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs();
  ASSERT_TRUE(r.ok && r.structure);
  const auto& toc = r.structure->toc;
  ASSERT_EQ(toc.size(), 5u);
  struct Want {
    const char* title;
    int level;
    int section;
    const char* block_prefix;  // nullptr = the page block
  } want[] = {{"Preface", 1, 1, "Preface"},
              {"Chapter One", 1, 2, "Chapter One"},
              {"The Beginning", 2, 2, "The Beginning"},
              {"Chapter Two", 1, 3, "Chapter Two"},
              {"Plates", 1, 5, nullptr}};
  for (size_t i = 0; i < toc.size(); ++i) {
    EXPECT_EQ(toc[i].title, want[i].title);
    EXPECT_EQ(toc[i].level, want[i].level) << want[i].title;
    EXPECT_EQ(toc[i].sectionIndex, want[i].section) << want[i].title;
    if (want[i].block_prefix) {
      const TxtStructBlock* b = FindBlock(r, want[i].block_prefix);
      ASSERT_TRUE(b);
      EXPECT_EQ(toc[i].blockIndex, b->blockIndex) << want[i].title;
    } else {
      EXPECT_EQ(toc[i].blockIndex, 0);
    }
  }
}

TEST(PdfBookParagraphs, SpansAreLinesInsideTheirBlocks) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs();
  ASSERT_TRUE(r.ok && r.structure);
  ASSERT_FALSE(r.spans.empty());
  int prev_end = 0;
  for (const auto& s : r.spans) {
    EXPECT_EQ(s.level, "line");
    EXPECT_LT(s.utf16_start, s.utf16_end);
    EXPECT_GE(s.utf16_start, prev_end);
    EXPECT_EQ(s.frame_index, s.page_number - 1);
    bool inside = false;
    for (const auto& b : r.structure->blocks) {
      if (b.sectionIndex == s.page_number - 1 && b.utf16Start <= s.utf16_start &&
          s.utf16_end <= b.utf16End) {
        inside = true;
      }
    }
    EXPECT_TRUE(inside) << s.utf16_start;
    prev_end = s.utf16_end;
  }
}

TEST(PdfBookParagraphs, ScanOnlyPagesStillGiveSections) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const auto r = ExtractBookParagraphs({6});
  ASSERT_TRUE(r.ok) << "no ERR_PDF_NO_TEXT_LAYER in the paragraphs layout";
  EXPECT_EQ(r.pages_with_text, 0);
  EXPECT_TRUE(r.text.empty());
  ASSERT_TRUE(r.structure);
  ASSERT_EQ(r.structure->sections.size(), 1u);
  EXPECT_EQ(r.structure->sections[0].blockCount, 1);
  EXPECT_EQ(r.structure->blocks[0].type, TxtBlockType::Page);
  EXPECT_EQ(r.structure->blocks[0].frameIndex, 5);
}

// ---- BuildPdfReadingText on hand-made geometry (no PDFium) ---------------

namespace {

PdfLine Line(const std::string& text, float x0, float y0, float x1, float size = 10) {
  PdfLine l;
  l.text = text;
  l.x0 = x0;
  l.y0 = y0;
  l.x1 = x1;
  l.y1 = y0 + size * 1.15f;
  l.font_size = size;
  return l;
}

PdfPageText OnePage(std::vector<PdfLine> lines, int number = 1) {
  PdfPageText p;
  p.page_number = number;
  p.width = 500;
  p.height = 700;
  p.lines = std::move(lines);
  return p;
}

/** Byte offset of a UTF-16 offset in UTF-8 text (BMP only, as in these tests). */
size_t ByteAt(const std::string& s, int utf16) {
  size_t i = 0;
  for (int u = 0; u < utf16 && i < s.size(); ++u) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    i += c < 0x80 ? 1 : c < 0xE0 ? 2 : 3;
  }
  return i;
}

std::vector<std::string> Blocks(const sherpa_onnx::pdf::PdfReadingText& r) {
  std::vector<std::string> out;
  for (const auto& b : r.structure->blocks) {
    if (b.type == TxtBlockType::Page) continue;
    const size_t a = ByteAt(r.text, b.utf16Start);
    out.push_back(std::string(txt_block_type_name(b.type)) + ":" +
                  r.text.substr(a, ByteAt(r.text, b.utf16End) - a));
  }
  return out;
}

}  // namespace

TEST(PdfStructureBuilder, IndentAndGapStartParagraphs) {
  // Body lines span 50..450; leading 14 for 10 pt text.
  const auto r = sherpa_onnx::pdf::BuildPdfReadingText(
      {OnePage({Line("one two three four five six seven eight nine ten", 50, 100, 450),
                Line("eleven twelve.", 50, 114, 120),
                Line("New paragraph by indent, running to the edge of", 70, 128, 450),
                Line("the column and on.", 50, 142, 140),
                Line("After a gap the next paragraph starts here and", 50, 180, 450),
                Line("ends.", 50, 194, 80)})},
      {});
  EXPECT_EQ(Blocks(r), (std::vector<std::string>{
                           "paragraph:one two three four five six seven eight nine ten eleven "
                           "twelve.",
                           "paragraph:New paragraph by indent, running to the edge of the column "
                           "and on.",
                           "paragraph:After a gap the next paragraph starts here and ends."}));
}

TEST(PdfStructureBuilder, ShortLineEndsParagraphWhenNextWordWouldFit) {
  const auto r = sherpa_onnx::pdf::BuildPdfReadingText(
      {OnePage({Line("A line that runs all the way to the right margin of", 50, 100, 450),
                Line("the page. Short end.", 50, 114, 200),
                Line("Next starts flush left without indent but the previous", 50, 128, 450),
                Line("line ended early, so this is new.", 50, 142, 300)})},
      {});
  ASSERT_EQ(Blocks(r).size(), 2u) << r.text;
}

TEST(PdfStructureBuilder, CjkJoinsWithoutSpaceAndHeadingLinesMerge) {
  const auto r = sherpa_onnx::pdf::BuildPdfReadingText(
      {OnePage({Line("A Heading That", 50, 40, 300, 20), Line("Wraps", 50, 63, 120, 20),
                Line("\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E\xE3\x81\xAE", 50, 100, 450),
                Line("\xE6\x96\x87\xE7\xAB\xA0\xE3\x80\x82", 50, 114, 110)})},
      {});
  const auto blocks = Blocks(r);
  ASSERT_EQ(blocks.size(), 2u) << r.text;
  EXPECT_EQ(blocks[0], "heading:A Heading That Wraps");
  EXPECT_EQ(blocks[1],
            "paragraph:\xE6\x97\xA5\xE6\x9C\xAC\xE8\xAA\x9E\xE3\x81\xAE\xE6\x96\x87\xE7\xAB\xA0"
            "\xE3\x80\x82");
  ASSERT_EQ(r.structure->toc.size(), 1u) << "no outline: the headings are the contents";
  EXPECT_EQ(r.structure->toc[0].title, "A Heading That Wraps");
  EXPECT_EQ(r.structure->toc[0].blockIndex, 1);
}

TEST(PdfStructureBuilder, PageNumberAloneIsFurnitureAndSectionRangeCoversIt) {
  const auto r = sherpa_onnx::pdf::BuildPdfReadingText(
      {OnePage({Line("Body text of a single page.", 50, 300, 300), Line("- 7 -", 240, 660, 260)})},
      {});
  ASSERT_EQ(r.structure->blocks.size(), 3u);
  EXPECT_FALSE(r.structure->blocks[1].flags & kTxtBlockFurniture);
  EXPECT_TRUE(r.structure->blocks[2].flags & kTxtBlockFurniture);
  EXPECT_EQ(r.structure->sections[0].utf16End, r.structure->blocks[2].utf16End);
  EXPECT_EQ(r.pages_with_text, 1);
}
