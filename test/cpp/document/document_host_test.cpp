#include "DocumentExtractor.h"
#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocSniff.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <unistd.h>

namespace {

// 1×1 PNG (RGB).
const uint8_t kTinyPng[] = {
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};

uint32_t Crc32(const uint8_t* data, size_t n) {
  uint32_t c = 0xffffffffu;
  for (size_t i = 0; i < n; ++i) {
    c ^= data[i];
    for (int k = 0; k < 8; ++k) {
      c = (c & 1) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
    }
  }
  return c ^ 0xffffffffu;
}

void Put16(std::vector<uint8_t>* o, uint16_t v) {
  o->push_back(static_cast<uint8_t>(v));
  o->push_back(static_cast<uint8_t>(v >> 8));
}
void Put32(std::vector<uint8_t>* o, uint32_t v) {
  o->push_back(static_cast<uint8_t>(v));
  o->push_back(static_cast<uint8_t>(v >> 8));
  o->push_back(static_cast<uint8_t>(v >> 16));
  o->push_back(static_cast<uint8_t>(v >> 24));
}

struct ZipEntry {
  std::string name;
  std::vector<uint8_t> data;
};

ZipEntry E(const char* name, const std::string& body) {
  ZipEntry z;
  z.name = name;
  z.data.assign(body.begin(), body.end());
  return z;
}
ZipEntry E(const char* name, const uint8_t* p, size_t n) {
  ZipEntry z;
  z.name = name;
  z.data.assign(p, p + n);
  return z;
}

std::vector<uint8_t> MakeStoreZip(const std::vector<ZipEntry>& entries) {
  std::vector<uint8_t> out;
  struct Meta {
    std::string name;
    uint32_t crc;
    uint32_t size;
    uint32_t local_off;
  };
  std::vector<Meta> metas;
  for (const auto& e : entries) {
    Meta m;
    m.name = e.name;
    m.crc = Crc32(e.data.data(), e.data.size());
    m.size = static_cast<uint32_t>(e.data.size());
    m.local_off = static_cast<uint32_t>(out.size());
    out.insert(out.end(), {'P', 'K', 0x03, 0x04});
    Put16(&out, 20);
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put32(&out, m.crc);
    Put32(&out, m.size);
    Put32(&out, m.size);
    Put16(&out, static_cast<uint16_t>(m.name.size()));
    Put16(&out, 0);
    out.insert(out.end(), m.name.begin(), m.name.end());
    out.insert(out.end(), e.data.begin(), e.data.end());
    metas.push_back(std::move(m));
  }
  const uint32_t cd_off = static_cast<uint32_t>(out.size());
  for (const auto& m : metas) {
    out.insert(out.end(), {'P', 'K', 0x01, 0x02});
    Put16(&out, 20);
    Put16(&out, 20);
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put32(&out, m.crc);
    Put32(&out, m.size);
    Put32(&out, m.size);
    Put16(&out, static_cast<uint16_t>(m.name.size()));
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put16(&out, 0);
    Put32(&out, 0);
    Put32(&out, m.local_off);
    out.insert(out.end(), m.name.begin(), m.name.end());
  }
  const uint32_t cd_sz = static_cast<uint32_t>(out.size()) - cd_off;
  out.insert(out.end(), {'P', 'K', 0x05, 0x06});
  Put16(&out, 0);
  Put16(&out, 0);
  Put16(&out, static_cast<uint16_t>(metas.size()));
  Put16(&out, static_cast<uint16_t>(metas.size()));
  Put32(&out, cd_sz);
  Put32(&out, cd_off);
  Put16(&out, 0);
  return out;
}

const std::vector<ZipEntry>& ComicEntries() {
  static const std::vector<ZipEntry> kEntries = {
      E("ComicInfo.xml", std::string("<ComicInfo/>")),
      E("page10.png", kTinyPng, sizeof(kTinyPng)),
      E("page2.png", kTinyPng, sizeof(kTinyPng)),
      E(".hidden.png", kTinyPng, sizeof(kTinyPng)),
  };
  return kEntries;
}

void ExpectComicNoTextAndSortedPages(const std::string& path,
                                     const char* format) {
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
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

std::string CommittedCbrPath() {
#ifndef SHERPA_TEST_SOURCE_DIR
#define SHERPA_TEST_SOURCE_DIR "."
#endif
  return std::string(SHERPA_TEST_SOURCE_DIR) +
         "/test/fixtures/document/tiny-comic.cbr";
}

std::string WriteTemp(const std::string& suffix, const std::vector<uint8_t>& bytes) {
  char path[] = "/tmp/sherpa-doc-XXXXXX";
  const int fd = mkstemp(path);
  EXPECT_GE(fd, 0);
  std::string out = std::string(path) + suffix;
  close(fd);
  unlink(path);
  std::ofstream f(out, std::ios::binary);
  f.write(reinterpret_cast<const char*>(bytes.data()),
          static_cast<std::streamsize>(bytes.size()));
  f.close();
  return out;
}

const char* kContainer = R"(<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
)";

std::string MixedOpf() {
  return R"(<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:test</dc:identifier>
    <dc:title>Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="skip" href="skip.xhtml" media-type="application/xhtml+xml"/>
    <item id="scan" href="scan.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="img.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="skip" linear="no"/>
    <itemref idref="scan"/>
  </spine>
</package>
)";
}

const char* kCh1 = R"(<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<p>Hello</p>
<h1>World</h1>
<script>alert(1)</script>
<p>Ruby <ruby><rb>漢</rb><rt>kan</rt></ruby></p>
</body></html>
)";

const char* kSkip = R"(<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Should not appear</p></body></html>
)";

const char* kScan = R"(<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<img src="img.png" alt="photograph of a scanned page" title="scan" aria-label="page"/>
</body></html>
)";

std::vector<ZipEntry> MixedEpubEntries() {
  return {
      E("mimetype", std::string("application/epub+zip")),
      E("META-INF/container.xml", kContainer),
      E("OEBPS/content.opf", MixedOpf()),
      E("OEBPS/ch1.xhtml", kCh1),
      E("OEBPS/skip.xhtml", kSkip),
      E("OEBPS/scan.xhtml", kScan),
      E("OEBPS/img.png", kTinyPng, sizeof(kTinyPng)),
  };
}

std::string Base64(const uint8_t* p, size_t n) {
  static const char* t =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = p[i] << 16;
    if (i + 1 < n) v |= p[i + 1] << 8;
    if (i + 2 < n) v |= p[i + 2];
    o.push_back(t[(v >> 18) & 63]);
    o.push_back(t[(v >> 12) & 63]);
    o.push_back(i + 1 < n ? t[(v >> 6) & 63] : '=');
    o.push_back(i + 2 < n ? t[v & 63] : '=');
  }
  return o;
}

std::string Fb2WithImage() {
  return std::string(R"(<?xml version="1.0"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <body>
    <section id="s1"><p>Alpha</p><p>Beta</p></section>
    <section id="s2"><image l:href="#pic"/></section>
  </body>
  <binary id="pic" content-type="image/png">)") +
         Base64(kTinyPng, sizeof(kTinyPng)) +
         "</binary></FictionBook>";
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
  const auto pdf = WriteTemp(".pdf", {'%', 'P', 'D', 'F', '-', '1', '.', '4'});
  sherpa_onnx::document::DocumentSource src;
  src.path = pdf;
  auto t = sherpa_onnx::document::ExtractDocumentText(src);
#ifndef HAVE_LIBARCHIVE
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
#else
  EXPECT_EQ(t.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
#endif
  unlink(pdf.c_str());

  const auto html = WriteTemp(".html", std::vector<uint8_t>(
      {'<', 'h', 't', 'm', 'l', '>', '<', '/', 'h', 't', 'm', 'l', '>'}));
  src.path = html;
  t = sherpa_onnx::document::ExtractDocumentText(src);
#ifndef HAVE_LIBARCHIVE
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
#else
  EXPECT_EQ(t.error_code, "ERR_DOC_UNSUPPORTED_FORMAT");
#endif
  unlink(html.c_str());
}

#ifndef HAVE_LIBARCHIVE
TEST(DocumentExtract, DisabledWithoutLibarchive) {
  sherpa_onnx::document::DocumentSource src;
  src.path = "/tmp/nope.epub";
  auto t = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(t.ok);
  EXPECT_EQ(t.error_code, "ERR_DOC_ARCHIVE_DISABLED");
}
#else

TEST(DocumentExtract, MixedEpubTextAndImages) {
  const auto zip = MakeStoreZip(MixedEpubEntries());
  const auto path = WriteTemp(".epub", zip);
  sherpa_onnx::document::DocumentSource src;
  src.path = path;

  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "epub");
  ASSERT_EQ(text.sections.size(), 2u);
  EXPECT_EQ(text.sections[0].kind, "text");
  EXPECT_EQ(text.sections[1].kind, "image");
  EXPECT_EQ(text.image_only_sections.size(), 1u);
  EXPECT_EQ(text.image_only_sections[0].section_index, 1);
  EXPECT_NE(text.text.find("Hello"), std::string::npos);
  EXPECT_NE(text.text.find("World"), std::string::npos);
  EXPECT_EQ(text.text.find("Should not appear"), std::string::npos);
  EXPECT_EQ(text.text.find("photograph"), std::string::npos);
  EXPECT_EQ(text.text.find("alert"), std::string::npos);
  ASSERT_GE(text.spans.size(), 2u);
  EXPECT_EQ(text.spans[0].section_index, 0);
  EXPECT_EQ(text.spans[0].level, "block");

  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_code << " " << images.error_message;
  EXPECT_EQ(images.format, "epub");
  ASSERT_EQ(images.frames.size(), 1u);
  EXPECT_EQ(images.frames[0].section_index, 1);
  EXPECT_EQ(images.frames[0].rgb.width, 1);
  EXPECT_EQ(images.frames[0].rgb.height, 1);
  unlink(path.c_str());
}

TEST(DocumentExtract, TextOnlyEpubNoImages) {
  std::vector<ZipEntry> entries = {
      E("mimetype", std::string("application/epub+zip")),
      E("META-INF/container.xml", kContainer),
      E("OEBPS/content.opf", R"(<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">x</dc:identifier><dc:title>t</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>)"),
      E("OEBPS/ch1.xhtml", "<html><body><p>Only text</p></body></html>"),
  };
  const auto path = WriteTemp(".epub", MakeStoreZip(entries));
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_message;
  EXPECT_TRUE(text.image_only_sections.empty());
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  EXPECT_FALSE(images.ok);
  EXPECT_EQ(images.error_code, "ERR_DOC_NO_IMAGES");
  unlink(path.c_str());
}

TEST(DocumentExtract, DrmEncryptionXml) {
  std::vector<ZipEntry> entries = MixedEpubEntries();
  entries.push_back(E("META-INF/encryption.xml", R"(<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>)"));
  const auto path = WriteTemp(".epub", MakeStoreZip(entries));
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_DRM");
  unlink(path.c_str());
}

TEST(DocumentExtract, FontOnlyEncryptionIsNotDrm) {
  std::vector<ZipEntry> entries = MixedEpubEntries();
  entries.push_back(E("META-INF/encryption.xml", R"(<?xml version="1.0"?>
<encryption>
  <EncryptedData>
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <CipherData><CipherReference URI="OEBPS/fonts/Body.otf"/></CipherData>
  </EncryptedData>
</encryption>)"));
  entries.push_back(E("OEBPS/fonts/Body.otf", std::string("not-a-real-font")));
  const auto path = WriteTemp(".epub", MakeStoreZip(entries));
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  unlink(path.c_str());
}

TEST(DocumentExtract, Fb2UncompressedAndZip) {
  const auto xml = Fb2WithImage();
  const auto path = WriteTemp(".fb2", std::vector<uint8_t>(xml.begin(), xml.end()));
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
  EXPECT_EQ(text.format, "fb2");
  ASSERT_EQ(text.sections.size(), 2u);
  EXPECT_EQ(text.sections[0].kind, "text");
  EXPECT_EQ(text.sections[1].kind, "image");
  EXPECT_NE(text.text.find("Alpha"), std::string::npos);
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  ASSERT_TRUE(images.ok) << images.error_message;
  ASSERT_EQ(images.frames.size(), 1u);
  EXPECT_EQ(images.frames[0].section_index, 1);
  unlink(path.c_str());

  const auto zpath = WriteTemp(".fbz", MakeStoreZip({E("book.fb2", xml)}));
  src.path = zpath;
  text = sherpa_onnx::document::ExtractDocumentText(src);
  ASSERT_TRUE(text.ok) << text.error_message;
  EXPECT_EQ(text.format, "fb2");
  unlink(zpath.c_str());
}

TEST(DocumentExtract, CbzNaturalSortAndNoText) {
  const auto path = WriteTemp(".cbz", MakeStoreZip(ComicEntries()));
  ExpectComicNoTextAndSortedPages(path, "cbz");
  unlink(path.c_str());
}

TEST(DocumentExtract, CbrRar3NaturalSortAndNoText) {
  // Committed store-only RAR3 comic. Tests only read it — no RAR writer on CI.
  const auto path = CommittedCbrPath();
  ASSERT_EQ(::access(path.c_str(), R_OK), 0) << "missing fixture " << path;
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Cbr);
  ExpectComicNoTextAndSortedPages(path, "cbr");
}

TEST(DocumentExtract, CbrTruncatedIsOpenFailed) {
  const uint8_t rar3[] = {'R', 'a', 'r', '!', 0x1a, 0x07, 0x00, 0x00};
  const auto path = WriteTemp(".cbr", std::vector<uint8_t>(rar3, rar3 + sizeof(rar3)));
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  EXPECT_EQ(sherpa_onnx::document::SniffFormat(src, nullptr, nullptr, nullptr),
            sherpa_onnx::document::DocFormat::Cbr);
  auto text = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_OPEN_FAILED");
  auto images = sherpa_onnx::document::ExtractDocumentImages(src);
  EXPECT_FALSE(images.ok);
  EXPECT_EQ(images.error_code, "ERR_DOC_OPEN_FAILED");
  unlink(path.c_str());
}

TEST(DocumentExtract, GarbageIsUnsupportedOrOpenFailed) {
  const auto path = WriteTemp(".bin", {0x00, 0x01, 0x02, 0x03, 0xff});
  sherpa_onnx::document::DocumentSource src;
  src.path = path;
  auto t = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(t.ok);
  EXPECT_TRUE(t.error_code == "ERR_DOC_UNSUPPORTED_FORMAT" ||
              t.error_code == "ERR_DOC_OPEN_FAILED");
  unlink(path.c_str());
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
    sherpa_onnx::document::DocumentSource src;
    src.path = path;
    auto t = sherpa_onnx::document::ExtractDocumentText(src);
    auto im = sherpa_onnx::document::ExtractDocumentImages(src);
    EXPECT_FALSE(t.ok);
    EXPECT_FALSE(im.ok);
    unlink(path.c_str());
  }
  auto zip = MakeStoreZip(MixedEpubEntries());
  zip.resize(zip.size() / 3);
  const auto truncated = WriteTemp(".epub", zip);
  sherpa_onnx::document::DocumentSource src;
  src.path = truncated;
  auto t = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_FALSE(t.ok);
  unlink(truncated.c_str());
}

#endif  // HAVE_LIBARCHIVE
