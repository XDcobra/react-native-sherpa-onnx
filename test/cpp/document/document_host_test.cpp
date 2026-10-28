#include "DocumentExtractor.h"
#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocSniff.h"

#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <unistd.h>

namespace {

std::string FixturePath(const char* name) {
#ifndef SHERPA_TEST_SOURCE_DIR
#define SHERPA_TEST_SOURCE_DIR "."
#endif
  return std::string(SHERPA_TEST_SOURCE_DIR) + "/test/fixtures/document/" + name;
}

void RequireFixture(const std::string& path) {
  ASSERT_EQ(::access(path.c_str(), R_OK), 0) << "missing fixture " << path;
}

sherpa_onnx::document::DocumentSource Src(const std::string& path) {
  sherpa_onnx::document::DocumentSource s;
  s.path = path;
  return s;
}

std::string WriteTemp(const std::string& suffix, const std::vector<uint8_t>& bytes) {
  char tmpl[] = "/tmp/sherpa-doc-XXXXXX";
  const int fd = mkstemp(tmpl);
  EXPECT_GE(fd, 0);
  std::string out = std::string(tmpl) + suffix;
  close(fd);
  unlink(tmpl);
  std::ofstream f(out, std::ios::binary);
  f.write(reinterpret_cast<const char*>(bytes.data()),
          static_cast<std::streamsize>(bytes.size()));
  f.close();
  return out;
}

std::vector<uint8_t> ReadAll(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)),
                             std::istreambuf_iterator<char>());
}

void ExpectNorthWindMarkup(const sherpa_onnx::document::ExtractTextResult& text) {
  EXPECT_NE(text.text.find("North Wind"), std::string::npos);
  EXPECT_NE(text.text.find("take off his cloak"), std::string::npos);
  EXPECT_NE(text.text.find("Pride"), std::string::npos);
  EXPECT_NE(text.text.find("force and bluster"), std::string::npos);
  EXPECT_NE(text.text.find("wrapped his cloak tighter"), std::string::npos);
  EXPECT_NE(text.text.find("the Sun"), std::string::npos);
  EXPECT_EQ(text.text.find("kan"), std::string::npos);
  EXPECT_EQ(text.text.find("shouldNotAppear"), std::string::npos);
  EXPECT_EQ(text.text.find("alert"), std::string::npos);
}

void ExpectComicNoTextAndSortedPages(const std::string& path, const char* format) {
  auto src = Src(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_NO_TEXT");
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_message;
  EXPECT_EQ(images.format, format);
  ASSERT_EQ(images.frames.size(), 2u);
  EXPECT_EQ(images.frames[0].href, "page2.png");
  EXPECT_EQ(images.frames[0].page_number, 1);
  EXPECT_EQ(images.frames[1].href, "page10.png");
  EXPECT_EQ(images.frames[1].page_number, 2);
}

}  // namespace

TEST(DocPath, NaturalSortPage2BeforePage10) {
  EXPECT_LT(sherpa_onnx::document::NaturalCompare("page2.png", "page10.png"), 0);
  EXPECT_LT(sherpa_onnx::document::NaturalCompare("a/page2.png", "a/page10.png"),
            0);
}

TEST(DocHtml, DropsScriptAndAltDoesNotCount) {
  const char* html =
      "<html><head><title>T</title></head><body>"
      "<script>secret()</script><img alt='scan of page' src='x.png'/>"
      "</body></html>";
  auto hx = sherpa_onnx::document::ExtractHtmlText(
      reinterpret_cast<const uint8_t*>(html), std::strlen(html));
  EXPECT_TRUE(sherpa_onnx::document::HtmlIsImageOnly(hx));
}

TEST(DocHtml, BlocksAndRuby) {
  const char* html =
      "<p>Hello</p><h1>World</h1><p>Ruby <ruby><rb>漢</rb><rt>kan</rt></ruby></p>";
  auto hx = sherpa_onnx::document::ExtractHtmlText(
      reinterpret_cast<const uint8_t*>(html), std::strlen(html));
  ASSERT_GE(hx.blocks.size(), 2u);
  EXPECT_NE(hx.text.find("Hello"), std::string::npos);
  EXPECT_NE(hx.text.find("World"), std::string::npos);
  EXPECT_EQ(hx.text.find("kan"), std::string::npos);
}

TEST(DocumentExtract, PdfAndHtmlAreUnsupported) {
  const auto pdf = FixturePath("not-a-book.pdf");
  const auto html = FixturePath("not-a-book.html");
  RequireFixture(pdf);
  RequireFixture(html);
  auto t = sherpa_onnx::document::ExtractDocumentText(Src(pdf));
#ifndef HAVE_LIBARCHIVE
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
#else
  EXPECT_EQ(t.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
#endif
  t = sherpa_onnx::document::ExtractDocumentText(Src(html));
#ifndef HAVE_LIBARCHIVE
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
#else
  EXPECT_EQ(t.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
#endif
}

#ifndef HAVE_LIBARCHIVE
TEST(DocumentExtract, DisabledWithoutLibarchive) {
  auto t = sherpa_onnx::document::ExtractDocumentText(Src(FixturePath("mixed.epub")));
  EXPECT_FALSE(t.ok);
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
}
#else

TEST(DocumentExtract, MixedEpubTextAndImages) {
  const auto path = FixturePath("mixed.epub");
  RequireFixture(path);
  auto src = Src(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "epub");
  ASSERT_EQ(text.sections.size(), 3u);
  EXPECT_EQ(text.sections[0].kind, "text");
  EXPECT_EQ(text.sections[1].kind, "text");
  EXPECT_EQ(text.sections[2].kind, "image");
  EXPECT_EQ(text.image_only_sections.size(), 1u);
  EXPECT_EQ(text.image_only_sections[0].section_index, 2);
  ExpectNorthWindMarkup(text);
  EXPECT_NE(text.text.find("traveler's wrap"), std::string::npos);
  EXPECT_EQ(text.text.find("Should not appear"), std::string::npos);
  EXPECT_EQ(text.text.find("photograph"), std::string::npos);
  EXPECT_EQ(text.text.find("flourish"), std::string::npos);
  ASSERT_GE(text.spans.size(), 4u);
  EXPECT_EQ(text.spans[0].section_index, 0);
  EXPECT_EQ(text.spans[0].level, "block");

  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_code << " " << images.error_message;
  EXPECT_EQ(images.format, "epub");
  ASSERT_EQ(images.frames.size(), 1u);
  EXPECT_EQ(images.frames[0].section_index, 2);
  EXPECT_EQ(images.frames[0].rgb.width, 1);
  EXPECT_EQ(images.frames[0].rgb.height, 1);
}

TEST(DocumentExtract, TextOnlyEpubNoImages) {
  const auto path = FixturePath("text-only.epub");
  RequireFixture(path);
  auto src = Src(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_message;
  EXPECT_TRUE(text.image_only_sections.empty());
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  EXPECT_FALSE(images.ok);
  EXPECT_EQ(images.error_code, "ERR_DOC_NO_IMAGES");
}

TEST(DocumentExtract, DrmEncryptionXml) {
  const auto path = FixturePath("drm.epub");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_DRM");
}

TEST(DocumentExtract, FontOnlyEncryptionIsNotDrm) {
  const auto path = FixturePath("font-embed.epub");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
}

TEST(DocumentExtract, Fb2UncompressedAndZip) {
  const auto path = FixturePath("north-wind.fb2");
  RequireFixture(path);
  auto src = Src(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "fb2");
  ASSERT_EQ(text.sections.size(), 3u);
  EXPECT_EQ(text.sections[0].kind, "text");
  EXPECT_EQ(text.sections[1].kind, "text");
  EXPECT_EQ(text.sections[2].kind, "image");
  EXPECT_NE(text.text.find("North Wind"), std::string::npos);
  EXPECT_NE(text.text.find("Pride yields"), std::string::npos);
  EXPECT_NE(text.text.find("A fable"), std::string::npos);
  EXPECT_NE(text.text.find("the cloak stayed"), std::string::npos);
  EXPECT_NE(text.text.find("the cloak fell"), std::string::npos);
  EXPECT_EQ(text.text.find("VoiceLab"), std::string::npos);
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_message;
  ASSERT_EQ(images.frames.size(), 1u);
  EXPECT_EQ(images.frames[0].section_index, 2);

  const auto zpath = FixturePath("north-wind.fbz");
  RequireFixture(zpath);
  text = sherpa_onnx::document::ExtractDocumentText(Src(zpath));
  ASSERT_TRUE(text.ok) << text.error_message;
  EXPECT_EQ(text.format, "fb2");
}

TEST(DocumentExtract, CbzNaturalSortAndNoText) {
  const auto path = FixturePath("comic.cbz");
  RequireFixture(path);
  ExpectComicNoTextAndSortedPages(path, "cbz");
}

TEST(DocumentExtract, CbrRar3NaturalSortAndNoText) {
  const auto path = FixturePath("tiny-comic.cbr");
  RequireFixture(path);
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(Src(path), nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Cbr);
  ExpectComicNoTextAndSortedPages(path, "cbr");
}

TEST(DocumentExtract, CbrTruncatedIsOpenFailed) {
  const auto path = FixturePath("truncated.cbr");
  RequireFixture(path);
  auto src = Src(path);
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Cbr);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_OPEN_FAILED");
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  EXPECT_FALSE(images.ok);
  EXPECT_EQ(images.error_code, "ERR_DOC_OPEN_FAILED");
}

TEST(DocumentExtract, MobiUncompressedText) {
  const auto path = FixturePath("tiny.mobi");
  RequireFixture(path);
  auto src = Src(path);
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Mobi);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "mobi");
  ASSERT_EQ(text.sections.size(), 3u);
  EXPECT_EQ(text.sections[0].kind, "text");
  EXPECT_EQ(text.sections[1].kind, "text");
  EXPECT_EQ(text.sections[2].kind, "image");
  ASSERT_EQ(text.image_only_sections.size(), 1u);
  EXPECT_EQ(text.image_only_sections[0].section_index, 2);
  ExpectNorthWindMarkup(text);
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_message;
  ASSERT_EQ(images.frames.size(), 1u);
  EXPECT_EQ(images.frames[0].section_index, 2);
  EXPECT_EQ(images.format, "mobi");
}

TEST(DocumentExtract, MobiPalmDocCompressionAsciiHtml) {
  const auto path = FixturePath("palmdoc.mobi");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_NE(text.text.find("PalmDOC chapter"), std::string::npos);
  EXPECT_NE(text.text.find("cloak came off"), std::string::npos);
}

TEST(DocumentExtract, MobiDrmIsRejected) {
  const auto path = FixturePath("drm.mobi");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_DRM");
}

TEST(DocumentExtract, MobiAzw4IsUnsupported) {
  const auto path = FixturePath("print-replica.azw4");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
}

TEST(DocumentExtract, MobiAudioIsUnsupported) {
  const auto path = FixturePath("audio.mobi");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
}

TEST(DocumentExtract, MobiDictionaryExthIsUnsupported) {
  const auto path = FixturePath("dictionary.mobi");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
}

TEST(DocumentExtract, MobiKf8FdstSplitsFlows) {
  const auto path = FixturePath("fdst.azw3");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.sections.size(), 2u);
  EXPECT_NE(text.text.find("Alpha flow"), std::string::npos);
  EXPECT_NE(text.text.find("first KF8 flow"), std::string::npos);
  EXPECT_NE(text.text.find("Beta flow"), std::string::npos);
  EXPECT_NE(text.text.find("FDST boundary"), std::string::npos);
}

TEST(DocumentExtract, MobiKf8SkelFragReconstructsHtml) {
  const auto path = FixturePath("kf8-skel.azw3");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_NE(text.text.find("KF8 chapter"), std::string::npos);
  EXPECT_NE(text.text.find("skeleton is hollow"), std::string::npos);
}

TEST(DocumentExtract, TextReadPalmDoc) {
  const auto path = FixturePath("palmdoc.pdb");
  RequireFixture(path);
  auto src = Src(path);
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Mobi);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_NE(text.text.find("Palm text"), std::string::npos);
}

TEST(DocumentExtract, CommittedAzw3Kf8Version) {
  const auto path = FixturePath("tiny.azw3");
  RequireFixture(path);
  auto src = Src(path);
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Mobi);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "mobi");
  ASSERT_EQ(text.sections.size(), 2u);
  ExpectNorthWindMarkup(text);
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  EXPECT_FALSE(images.ok);
  EXPECT_EQ(images.error_code, "ERR_DOC_NO_IMAGES");
}

TEST(DocumentExtract, GarbageIsUnsupportedOrOpenFailed) {
  const auto path = FixturePath("garbage.bin");
  RequireFixture(path);
  auto t = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(t.ok);
  EXPECT_TRUE(t.error_code == "ERR_DOC_UNSUPPORTED_FORMAT" ||
              t.error_code == "ERR_DOC_OPEN_FAILED");
}

TEST(DocumentExtract, FuzzMalformedInputsDoNotCrash) {
  for (int i = 0; i < 48; ++i) {
    std::vector<uint8_t> b(static_cast<size_t>(i * 19 + 7));
    for (size_t j = 0; j < b.size(); ++j) {
      b[j] = static_cast<uint8_t>(i * 37 + j * 19);
    }
    if (i % 5 == 0 && b.size() >= 4) {
      b[0] = 0x50;
      b[1] = 0x4B;
      b[2] = 0x03;
      b[3] = 0x04;
    }
    const auto path = WriteTemp(".bin", b);
    auto src = Src(path);
    auto t = sherpa_onnx::document::ExtractDocumentText(src);
    auto im = sherpa_onnx::document::ExtractDocumentImages(src);
    EXPECT_FALSE(t.ok);
    EXPECT_FALSE(im.ok);
    unlink(path.c_str());
  }
  auto zip = ReadAll(FixturePath("mixed.epub"));
  ASSERT_FALSE(zip.empty());
  zip.resize(zip.size() / 3);
  const auto truncated = WriteTemp(".epub", zip);
  auto t = sherpa_onnx::document::ExtractDocumentText(Src(truncated));
  EXPECT_FALSE(t.ok);
  unlink(truncated.c_str());
}

#endif  // HAVE_LIBARCHIVE
