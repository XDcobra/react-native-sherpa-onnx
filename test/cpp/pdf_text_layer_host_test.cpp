#include "PdfFeatureGuard.h"
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
