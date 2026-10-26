#include "PdfFeatureGuard.h"
#include "PdfLazySession.h"
#include "PdfPageRasterizer.h"
#include "PdfTextLayerExtractor.h"
#include "PdfTypes.h"

#include <gtest/gtest.h>

#include <string>

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
  const uint8_t fake[] = {'%', 'P', 'D', 'F'};
  const auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(fake, sizeof(fake), {});
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.error_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_NE(r.error_message.find("sherpaOnnxEnablePdfium"), std::string::npos);
}

TEST(PdfRasterHost, DisabledBuildReturnsPdfiumDisabled) {
  if (sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium linked; disabled-path test skipped";
  }
  const uint8_t fake[] = {'%', 'P', 'D', 'F'};
  const auto r = sherpa_onnx::pdf::RasterizePdfPages(fake, sizeof(fake), {});
  EXPECT_FALSE(r.ok);
  EXPECT_EQ(r.error_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_TRUE(r.frames.empty());
}

TEST(PdfLazySessionHost, DisabledBuildOpenReturnsPdfiumDisabled) {
  if (sherpa_onnx::pdf::IsPdfiumCompiledIn()) {
    GTEST_SKIP() << "PDFium linked; disabled-path test skipped";
  }
  const uint8_t fake[] = {'%', 'P', 'D', 'F', '-', '1', '.', '4'};
  std::string err_code;
  std::string err_msg;
  auto session = sherpa_onnx::pdf::PdfLazySession::Open(
      fake, sizeof(fake), 144, 4096, &err_code, &err_msg);
  EXPECT_EQ(session, nullptr);
  EXPECT_EQ(err_code, sherpa_onnx::pdf::kErrDisabled);
  EXPECT_NE(err_msg.find("sherpaOnnxEnablePdfium"), std::string::npos);
}
