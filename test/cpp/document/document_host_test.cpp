#include "DocumentExtractor.h"
#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocSniff.h"
#include "../textbuffer/TxtUtf16.h"

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

#if defined(SHERPA_ONNX_HAS_LEXBOR) && SHERPA_ONNX_HAS_LEXBOR
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

namespace {
sherpa_onnx::document::HtmlExtract Html(const char* html) {
  return sherpa_onnx::document::ExtractHtmlText(
      reinterpret_cast<const uint8_t*>(html), std::strlen(html));
}
using sherpa_onnx::document::HtmlBlockKind;
}  // namespace

TEST(DocHtml, CollapsesWhitespaceInsideBlocks) {
  auto hx = Html(
      "<p>\n    The   quick\n\tbrown <em>fox</em>\n    jumps.\n  </p>");
  ASSERT_EQ(hx.blocks.size(), 1u);
  EXPECT_EQ(hx.blocks[0], "The quick brown fox jumps.");
}

TEST(DocHtml, LineBreakKeepsNewlineWithoutSurroundingSpaces) {
  auto hx = Html("<p>Roses are red, <br/>\n   violets are blue.</p>");
  ASSERT_EQ(hx.blocks.size(), 1u);
  EXPECT_EQ(hx.blocks[0], "Roses are red,\nviolets are blue.");
}

TEST(DocHtml, PreKeepsWhitespace) {
  auto hx = Html("<pre>a  b\n  c</pre><p>x   y</p>");
  ASSERT_EQ(hx.blocks.size(), 2u);
  EXPECT_EQ(hx.blocks[0], "a  b\n  c");
  EXPECT_EQ(hx.blocks[1], "x y");
}

TEST(DocHtml, HeadingLevelsAndKinds) {
  auto hx = Html("<h1>Title</h1><p>Body</p><h3>Sub</h3>");
  ASSERT_EQ(hx.items.size(), 3u);
  EXPECT_EQ(hx.items[0].kind, HtmlBlockKind::Heading);
  EXPECT_EQ(hx.items[0].level, 1);
  EXPECT_EQ(hx.items[1].kind, HtmlBlockKind::Paragraph);
  EXPECT_EQ(hx.items[2].level, 3);
  EXPECT_EQ(hx.text, "Title\n\nBody\n\nSub");
}

TEST(DocHtml, ImageInsideParagraphComesAfterIt) {
  auto hx = Html(
      "<p>Before <img src='../img/a.png' alt=' A map '/> after.</p>"
      "<img src='b.jpg'/><p>Next</p>");
  ASSERT_EQ(hx.items.size(), 4u);
  EXPECT_EQ(hx.items[0].kind, HtmlBlockKind::Paragraph);
  EXPECT_EQ(hx.items[0].text, "Before after.");
  EXPECT_EQ(hx.items[1].kind, HtmlBlockKind::Image);
  EXPECT_EQ(hx.items[1].image_src, "../img/a.png");
  EXPECT_TRUE(hx.items[1].has_alt);
  EXPECT_EQ(hx.items[1].alt, "A map");
  EXPECT_EQ(hx.items[2].image_src, "b.jpg");
  EXPECT_FALSE(hx.items[2].has_alt);
  EXPECT_EQ(hx.items[3].text, "Next");
  // Images never add text.
  EXPECT_EQ(hx.text, "Before after.\n\nNext");
}

TEST(DocHtml, SeparatorAndSvgImage) {
  auto hx = Html(
      "<p>One</p><hr/><svg xmlns='http://www.w3.org/2000/svg' "
      "xmlns:xlink='http://www.w3.org/1999/xlink'>"
      "<image xlink:href='cover.jpg'/></svg><p>Two</p>");
  ASSERT_EQ(hx.items.size(), 4u);
  EXPECT_EQ(hx.items[1].kind, HtmlBlockKind::Separator);
  EXPECT_EQ(hx.items[2].kind, HtmlBlockKind::Image);
  EXPECT_EQ(hx.items[2].image_src, "cover.jpg");
}

TEST(DocHtml, LooseTextBeforeBlockIsItsOwnParagraph) {
  auto hx = Html("<div>Intro text <p>Para</p> tail</div>");
  ASSERT_EQ(hx.blocks.size(), 3u);
  EXPECT_EQ(hx.blocks[0], "Intro text");
  EXPECT_EQ(hx.blocks[1], "Para");
  EXPECT_EQ(hx.blocks[2], "tail");
}
#else
TEST(DocHtml, DisabledWithoutLexbor) {
  const char* html = "<p>Hello</p>";
  auto hx = sherpa_onnx::document::ExtractHtmlText(
      reinterpret_cast<const uint8_t*>(html), std::strlen(html));
  EXPECT_EQ(hx.error_code, "ERR_DOC_LEXBOR_DISABLED");
  EXPECT_NE(hx.error_message.find("sherpaOnnxEnableLexbor"), std::string::npos);
}
#endif

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

#if !defined(SHERPA_ONNX_HAS_LEXBOR) || !SHERPA_ONNX_HAS_LEXBOR
TEST(DocumentExtract, EpubTextDisabledWithoutLexbor) {
  const auto path = FixturePath("mixed.epub");
  RequireFixture(path);
  auto t = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(t.ok);
  EXPECT_EQ(t.error_code, "ERR_DOC_LEXBOR_DISABLED");
  EXPECT_NE(t.error_message.find("sherpaOnnxEnableLexbor"), std::string::npos);
}
#else

#if defined(SHERPA_ONNX_HAS_LEXBOR) && SHERPA_ONNX_HAS_LEXBOR && defined(HAVE_LIBARCHIVE)
namespace {
std::string BlockText(const sherpa_onnx::document::ExtractTextResult& r,
                      const TxtStructBlock& b) {
  // Fixture text is ASCII, so UTF-16 offsets equal byte offsets.
  return r.text.substr(b.utf16Start, b.utf16End - b.utf16Start);
}
}  // namespace

TEST(DocumentStructure, EpubSectionsBlocksTitlesAndMetadata) {
  const auto path = FixturePath("structure.epub");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  const TxtStructure& st = *r.structure;
  EXPECT_EQ(st.version, 1);
  EXPECT_EQ(st.title, "The Reader Fixture");
  EXPECT_EQ(st.creator, "Ada Example");
  EXPECT_EQ(st.language, "en");

  // nav.xhtml is linear="no" and gets no index.
  ASSERT_EQ(st.sections.size(), 3u);
  EXPECT_EQ(st.sections[0].href, "OEBPS/text/ch1.xhtml");
  EXPECT_EQ(st.sections[0].title, "Chapter One");  // nav toc, first entry, collapsed
  EXPECT_EQ(st.sections[0].titleSource, "toc");
  EXPECT_EQ(st.sections[1].kind, "image");
  EXPECT_EQ(st.sections[1].title, "The Plate");
  EXPECT_EQ(st.sections[2].title, "A section without a TOC entry");
  EXPECT_EQ(st.sections[2].titleSource, "heading");

  // Section 0: h1, h2, p, p, img (after its paragraph), hr, pre, p.
  const auto& s0 = st.sections[0];
  ASSERT_EQ(s0.blockCount, 8);
  const auto b = [&](int i) { return st.blocks[s0.firstBlock + i]; };
  EXPECT_EQ(b(0).type, TxtBlockType::Heading);
  EXPECT_EQ(b(0).headingLevel, 1);
  EXPECT_EQ(BlockText(r, b(0)), "Chapter One");
  EXPECT_EQ(b(1).headingLevel, 2);
  EXPECT_EQ(BlockText(r, b(2)),
            "It was a bright cold day, and the clocks were striking thirteen.");
  EXPECT_EQ(BlockText(r, b(3)), "A map: drawn by hand.");
  EXPECT_EQ(b(4).type, TxtBlockType::Image);
  EXPECT_EQ(b(4).imageHref, "OEBPS/images/map.png");
  EXPECT_EQ(b(4).alt, "Map of the island");
  EXPECT_EQ(b(4).utf16Start, b(4).utf16End);
  EXPECT_EQ(b(5).type, TxtBlockType::Separator);
  EXPECT_EQ(BlockText(r, b(6)), "keep   this\n  spacing");
  EXPECT_EQ(BlockText(r, b(7)), "Roses are red,\nviolets are blue.");
  for (int i = 0; i < s0.blockCount; ++i) {
    EXPECT_EQ(b(i).blockIndex, i);
    EXPECT_EQ(b(i).sectionIndex, 0);
  }
  EXPECT_EQ(s0.utf16Start, b(0).utf16Start);
  EXPECT_EQ(s0.utf16End, b(7).utf16End);

  // Raw image spine item: one image block, empty text range.
  const auto& s1 = st.sections[1];
  ASSERT_EQ(s1.blockCount, 1);
  EXPECT_EQ(st.blocks[s1.firstBlock].imageHref, "OEBPS/images/plate.png");
  EXPECT_EQ(s1.utf16Start, s1.utf16End);

  // figure/figcaption are not block tags: img, then the caption as loose text.
  const auto& s2 = st.sections[2];
  ASSERT_EQ(s2.blockCount, 4);
  EXPECT_EQ(st.blocks[s2.firstBlock + 2].type, TxtBlockType::Image);
  EXPECT_TRUE(st.blocks[s2.firstBlock + 2].hasAlt);
  EXPECT_EQ(st.blocks[s2.firstBlock + 2].alt, "");
  EXPECT_EQ(BlockText(r, st.blocks[s2.firstBlock + 3]), "Same map again");

  // Text blocks are exactly the markup spans.
  int text_blocks = 0;
  for (const auto& blk : st.blocks) {
    if (blk.type == TxtBlockType::Paragraph || blk.type == TxtBlockType::Heading) ++text_blocks;
  }
  EXPECT_EQ(text_blocks, static_cast<int>(r.spans.size()));
}

TEST(DocumentStructure, Epub2NcxTitles) {
  const auto path = FixturePath("structure-ncx.epub");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  ASSERT_EQ(r.structure->sections.size(), 2u);
  EXPECT_EQ(r.structure->sections[0].title, "Opening");  // nested point does not override
  EXPECT_EQ(r.structure->sections[1].title, "Closing");
}

TEST(DocumentStructure, LongEpubBlockCount) {
  const auto path = FixturePath("long.epub");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  ASSERT_EQ(r.structure->sections.size(), 40u);
  // Per chapter: heading + 150 paragraphs + 3 figures.
  EXPECT_EQ(r.structure->blocks.size(), 40u * 154u);
  EXPECT_EQ(r.structure->sections[39].title, "Chapter 40");
}

TEST(DocumentStructure, AllImagesScopeCollectsInlineImagesOncePerPath) {
  const auto path = FixturePath("structure.epub");
  RequireFixture(path);
  sherpa_onnx::document::ExtractOptions opt;
  opt.all_images = true;
  auto r = sherpa_onnx::document::ExtractDocumentImages(Src(path), opt);
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  // map.png appears twice (ch1, ch2) → one frame; plate.png is a spine item.
  ASSERT_EQ(r.frames.size(), 2u);
  EXPECT_EQ(r.frames[0].href, "OEBPS/images/map.png");
  EXPECT_EQ(r.frames[0].section_index, 0);
  EXPECT_EQ(r.frames[1].href, "OEBPS/images/plate.png");
  EXPECT_EQ(r.frames[1].section_index, 1);

  // Default scope: only image-only sections (here the plate).
  auto def = sherpa_onnx::document::ExtractDocumentImages(Src(path));
  ASSERT_TRUE(def.ok) << def.error_code;
  ASSERT_EQ(def.frames.size(), 1u);
  EXPECT_EQ(def.frames[0].href, "OEBPS/images/plate.png");
}

TEST(DocumentStructure, MobiCarriesStructureMetadataAndImages) {
  const auto path = FixturePath("structure.mobi");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  const auto& st = *r.structure;
  EXPECT_EQ(st.format, "mobi");
  EXPECT_EQ(st.title, "A Mobi Structure Book");  // EXTH 503 wins over the full name
  EXPECT_EQ(st.creator, "Ada Example");
  EXPECT_EQ(st.language, "en");
  ASSERT_EQ(st.sections.size(), 3u);
  EXPECT_EQ(st.sections[0].title, "The Lighthouse");
  EXPECT_EQ(st.sections[0].titleSource, "heading");
  EXPECT_EQ(st.sections[2].kind, "image");
  // Section 0: heading, paragraph, separator, paragraph, image (after its paragraph).
  std::vector<TxtBlockType> types;
  for (int k = 0; k < st.sections[0].blockCount; ++k) {
    types.push_back(st.blocks[st.sections[0].firstBlock + k].type);
  }
  EXPECT_EQ(types, (std::vector<TxtBlockType>{TxtBlockType::Heading, TxtBlockType::Paragraph,
                                              TxtBlockType::Separator, TxtBlockType::Paragraph,
                                              TxtBlockType::Image}));
  const auto& inline_img = st.blocks[st.sections[0].firstBlock + 4];
  EXPECT_EQ(inline_img.imageHref, "recindex:2");
  EXPECT_EQ(inline_img.alt, "map of the bay");
  const auto& plate = st.blocks[st.sections[2].firstBlock];
  EXPECT_EQ(plate.imageHref, "recindex:1");

  // scope 'all': every referenced image once, in reading order.
  sherpa_onnx::document::ExtractOptions all;
  all.all_images = true;
  auto images = sherpa_onnx::document::ExtractDocumentImages(Src(path), all);
  ASSERT_TRUE(images.ok) << images.error_code << " " << images.error_message;
  ASSERT_EQ(images.frames.size(), 2u);
  EXPECT_EQ(images.frames[0].href, "recindex:2");
  EXPECT_EQ(images.frames[0].section_index, 0);
  EXPECT_EQ(images.frames[1].href, "recindex:1");
  EXPECT_EQ(images.frames[1].section_index, 2);
  // Default scope: only the image-only part.
  auto def = sherpa_onnx::document::ExtractDocumentImages(Src(path));
  ASSERT_TRUE(def.ok);
  ASSERT_EQ(def.frames.size(), 1u);
  EXPECT_EQ(def.frames[0].href, "recindex:1");
}

TEST(DocumentStructure, Azw3KindleEmbedImagesAndFullNameTitle) {
  const auto path = FixturePath("structure.azw3");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  EXPECT_EQ(r.structure->title, "An AZW3 Structure Book");
  bool saw_inline = false;
  for (const auto& b : r.structure->blocks) {
    if (b.type == TxtBlockType::Image && b.imageHref == "recindex:2") saw_inline = true;
  }
  EXPECT_TRUE(saw_inline) << "kindle:embed:0002 resolves to image record 2";
  // The image-only part decodes its own record (not always record 1).
  auto def = sherpa_onnx::document::ExtractDocumentImages(Src(path));
  ASSERT_TRUE(def.ok) << def.error_code << " " << def.error_message;
  ASSERT_EQ(def.frames.size(), 1u);
  EXPECT_EQ(def.frames[0].href, "recindex:1");
}

TEST(DocumentStructure, Fb2TitlesSectionsImagesAndMetadata) {
  const auto path = FixturePath("structure.fb2");
  RequireFixture(path);
  auto r = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  ASSERT_TRUE(r.structure);
  const auto& st = *r.structure;
  EXPECT_EQ(st.format, "fb2");
  EXPECT_EQ(st.title, "The Lighthouse Keeper");
  EXPECT_EQ(st.creator, "Ada B. Example");
  EXPECT_EQ(st.language, "en");
  // Body lead-in, ch1 (with nested ch1-1), plate, notes section.
  ASSERT_EQ(st.sections.size(), 4u);
  EXPECT_EQ(st.sections[0].href, "body-0");
  EXPECT_EQ(st.sections[0].title, "The Lighthouse Keeper A Story");
  EXPECT_EQ(st.sections[1].href, "ch1");
  EXPECT_EQ(st.sections[1].title, "Chapter One The Bay");
  EXPECT_EQ(st.sections[1].titleSource, "toc");
  EXPECT_EQ(st.sections[2].kind, "image");
  EXPECT_EQ(st.sections[3].href, "n1");

  auto text_of = [&](const TxtStructBlock& b) {
    return txt_utf16_slice(r.text, b.utf16Start, b.utf16End - b.utf16Start);
  };
  std::vector<std::string> got;
  for (int k = 0; k < st.sections[1].blockCount; ++k) {
    const auto& b = st.blocks[st.sections[1].firstBlock + k];
    std::string line = txt_block_type_name(b.type);
    if (b.type == TxtBlockType::Heading) line += std::to_string(b.headingLevel);
    if (b.type == TxtBlockType::Image) line += " " + b.imageHref;
    if (b.utf16End > b.utf16Start) line += " " + text_of(b);
    got.push_back(line);
  }
  EXPECT_EQ(got, (std::vector<std::string>{
                     "heading1 Chapter One\nThe Bay",
                     "heading2 Evening",
                     "paragraph The keeper counted the ships every evening.",
                     "paragraph A map of the bay hung by the door.",
                     "image map",
                     "separator",
                     "heading2 The Boat",
                     "paragraph On the third night a small boat drifted in.",
                     "heading3 Harbour Song",
                     "paragraph The tide comes in,\nthe tide goes out.",
                     "paragraph Ships",
                     "paragraph 12",
                 }));

  sherpa_onnx::document::ExtractOptions all;
  all.all_images = true;
  auto images = sherpa_onnx::document::ExtractDocumentImages(Src(path), all);
  ASSERT_TRUE(images.ok) << images.error_code;
  ASSERT_EQ(images.frames.size(), 2u);
  EXPECT_EQ(images.frames[0].href, "map");
  EXPECT_EQ(images.frames[0].section_index, 1);
  EXPECT_EQ(images.frames[1].href, "plate");
  auto def = sherpa_onnx::document::ExtractDocumentImages(Src(path));
  ASSERT_TRUE(def.ok);
  ASSERT_EQ(def.frames.size(), 1u);
  EXPECT_EQ(def.frames[0].href, "plate");
}
#endif

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

TEST(DocumentExtract, FontOnlyEncryptionIsNotDrm) {
  const auto path = FixturePath("font-embed.epub");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  ASSERT_TRUE(text.ok) << text.error_code << " " << text.error_message;
}

#endif  // SHERPA_ONNX_HAS_LEXBOR

TEST(DocumentExtract, DrmEncryptionXml) {
  const auto path = FixturePath("drm.epub");
  RequireFixture(path);
  auto text = sherpa_onnx::document::ExtractDocumentText(Src(path));
  EXPECT_FALSE(text.ok);
  EXPECT_EQ(text.error_code, "ERR_DOC_DRM");
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

#if defined(SHERPA_ONNX_HAS_LEXBOR) && SHERPA_ONNX_HAS_LEXBOR
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
#endif  // SHERPA_ONNX_HAS_LEXBOR

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

#if defined(SHERPA_ONNX_HAS_LEXBOR) && SHERPA_ONNX_HAS_LEXBOR
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
#endif  // SHERPA_ONNX_HAS_LEXBOR

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
