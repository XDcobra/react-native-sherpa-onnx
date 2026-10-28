#include "PdfDocument.h"
#include "PdfFeatureGuard.h"
#include "PdfLazySession.h"
#include "PdfPageRasterizer.h"
#include "PdfTextLayerExtractor.h"
#include "PdfTypes.h"

#include <fcntl.h>
#include <unistd.h>

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
