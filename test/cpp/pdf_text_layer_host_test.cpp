#include "PdfDocument.h"
#include "PdfFeatureGuard.h"
#include "PdfLazySession.h"
#include "PdfPageRasterizer.h"
#include "PdfTextLayerExtractor.h"
#include "PdfTypes.h"

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
