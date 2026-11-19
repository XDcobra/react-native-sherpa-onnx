#include "DocumentExtractor.h"
#include "PdfFeatureGuard.h"
#include "PdfTextLayerExtractor.h"

#include "ReaderFileHash.h"
#include "ReaderHighlights.h"
#include "ReaderJson.h"
#include "ReaderLayout.h"
#include "ReaderMarkers.h"
#include "ReaderOcrText.h"
#include "ReaderRegistry.h"
#include "ReaderSentences.h"
#include "ReaderSidecar.h"
#include "ReaderTextHash.h"
#include "ReaderTextSlice.h"
#include "ReaderTracker.h"

#include "crypto/sha256.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <unistd.h>

using namespace sherpa_onnx::reader;

namespace {

#ifndef SHERPA_TEST_SOURCE_DIR
#define SHERPA_TEST_SOURCE_DIR "."
#endif

std::string RepoPath(const std::string& rel) { return std::string(SHERPA_TEST_SOURCE_DIR) + "/" + rel; }

/** Extracts a fixture EPUB into a standalone populated text entry. */
std::shared_ptr<TxtOfflineEntry> LoadEntry(const char* fixture,
                                           sherpa_onnx::document::ExtractTextResult* out = nullptr) {
  sherpa_onnx::document::DocumentSource src;
  src.path = RepoPath(std::string("test/fixtures/document/") + fixture);
  auto r = sherpa_onnx::document::ExtractDocumentText(src);
  EXPECT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  auto entry = std::make_shared<TxtOfflineEntry>();
  entry->bufferId = "txt_off_test";
  EXPECT_TRUE(entry->tryPopulate(r.text, {}, {}, {}, "", "", ""));
  EXPECT_TRUE(entry->trySetStructure(r.structure));
  if (out) *out = r;
  return entry;
}

std::string CreateDoc(const char* fixture, std::vector<std::string> frames = {}) {
  ReaderError err;
  const std::string id =
      ReaderRegistry::Instance().Create(LoadEntry(fixture), "img_off_test", frames, "key", &err);
  EXPECT_FALSE(id.empty()) << err.code << " " << err.message;
  return id;
}

}  // namespace

// ---- textHash v1 --------------------------------------------------------

TEST(ReaderTextHash, NormalizationRules) {
  EXPECT_EQ(NormalizeForHashV1("  It’s   a “test”… \n"), "It's a \"test\"...");
  EXPECT_EQ(NormalizeForHashV1("co­op​er⁠ate﻿"), "cooperate");
  EXPECT_EQ(NormalizeForHashV1("a—b–c−d"), "a-b-c-d");
  EXPECT_EQ(NormalizeForHashV1("«Quote» `x´"), "\"Quote\" 'x'");
  EXPECT_EQ(NormalizeForHashV1("Case Stays"), "Case Stays");  // no case folding
  EXPECT_EQ(NormalizeForHashV1("e\xCC\x81"), "e\xCC\x81");  // no NFC
  EXPECT_EQ(NormalizeForHashV1("bad\xFF" "byte"), "bad\xEF\xBF\xBD" "byte");  // U+FFFD
  EXPECT_EQ(NormalizeForHashV1("   "), "");
}

TEST(ReaderTextHash, KnownVectors) {
  // Shared with the reference implementation in docs/reader.md.
  EXPECT_EQ(ShortSha256Hex("abc"), "ba7816bf8f01cfea");
  EXPECT_EQ(TextHashV1("It’s   a  test…"), TextHashV1("It's a test..."));
  EXPECT_EQ(TextHashV1(""), ShortSha256Hex(""));
  EXPECT_EQ(ImageHashV1("OEBPS/a.png"), ShortSha256Hex("\x1Fimage:OEBPS/a.png"));
  EXPECT_EQ(SeparatorHashV1().size(), 16u);
  EXPECT_NE(TextHashV1("Hello"), TextHashV1("hello"));
}

// ---- ReaderDocument -----------------------------------------------------

TEST(ReaderDocument, IdsTextAndFramesFromStructure) {
  const std::string id = CreateDoc("structure.epub", {"OEBPS/images/map.png", "OEBPS/images/plate.png"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);
  EXPECT_EQ(snap->revision, 1);
  EXPECT_EQ(snap->title, "The Reader Fixture");
  ASSERT_EQ(snap->sections.size(), 3u);
  EXPECT_EQ(snap->sections[0].id, "s0");
  EXPECT_EQ(snap->sections[1].id, "s1");
  EXPECT_EQ(snap->blocks[0].id, "s0.b0");
  EXPECT_EQ(snap->BlockText(0), "Chapter One");
  const int img = snap->BlockIndex("s0.b4");
  ASSERT_GE(img, 0);
  EXPECT_EQ(snap->blocks[img].type, ReaderBlockType::Image);
  EXPECT_EQ(snap->blocks[img].imageFrame, 0);
  EXPECT_EQ(snap->blocks[snap->BlockIndex("s1.b0")].imageFrame, 1);
  EXPECT_EQ(snap->BlockText(snap->BlockIndex("s0.b7")), "Roses are red,\nviolets are blue.");
  EXPECT_EQ(snap->blocks[2].textHash, TextHashV1(snap->BlockText(2)));
  EXPECT_TRUE(ReaderRegistry::Instance().Release(id));
  EXPECT_FALSE(ReaderRegistry::Instance().Snapshot(id));
}

TEST(ReaderDocument, RequiresStructure) {
  auto entry = std::make_shared<TxtOfflineEntry>();
  ASSERT_TRUE(entry->tryPopulate("plain", {}, {}, {}, "", "", ""));
  ReaderError err;
  EXPECT_TRUE(ReaderRegistry::Instance().Create(entry, "", {}, "k", &err).empty());
  EXPECT_EQ(err.code, kErrReaderNoStructure);
}

TEST(ReaderDocument, AppSectionsInsertRemoveAndRevision) {
  const std::string id = CreateDoc("structure.epub");
  auto& reg = ReaderRegistry::Instance();
  ReaderAppSectionInput in;
  in.after = "s0";
  in.id = "app:guide";
  in.title = "Another way";
  in.blocks = {{"title", ReaderBlockType::Heading, "Another way", 2},
               {"p1", ReaderBlockType::Paragraph, "A new road opens.", 0}};
  ReaderError err;
  ASSERT_TRUE(reg.InsertSection(id, in, &err)) << err.message;
  auto snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 2);
  ASSERT_EQ(snap->sections.size(), 4u);
  EXPECT_EQ(snap->sections[1].id, "app:guide");
  EXPECT_EQ(snap->sections[1].titleSource, "app");
  const int p1 = snap->BlockIndex("app:guide.p1");
  ASSERT_GE(p1, 0);
  EXPECT_EQ(p1, snap->sections[0].blockCount + 1);
  EXPECT_EQ(snap->BlockText(p1), "A new road opens.");
  EXPECT_EQ(snap->blocks[p1].section, 1);
  // File IDs do not move.
  EXPECT_EQ(snap->blocks[snap->BlockIndex("s1.b0")].type, ReaderBlockType::Image);

  // Errors: duplicate, bad key, unknown anchor, file section removal.
  EXPECT_FALSE(reg.InsertSection(id, in, &err));
  ReaderAppSectionInput bad = in;
  bad.id = "app:ok";
  bad.blocks = {{"bad key", ReaderBlockType::Paragraph, "x", 0}};
  EXPECT_FALSE(reg.InsertSection(id, bad, &err));
  bad.blocks = {{"k", ReaderBlockType::Paragraph, "x", 0}};
  bad.after = "s99";
  EXPECT_FALSE(reg.InsertSection(id, bad, &err));
  EXPECT_FALSE(reg.RemoveSection(id, "s0", &err));

  ASSERT_TRUE(reg.RemoveSection(id, "app:guide", &err));
  snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 3);
  EXPECT_EQ(snap->sections.size(), 3u);
  EXPECT_LT(snap->BlockIndex("app:guide.p1"), 0);
  reg.Release(id);
}

TEST(ReaderDocument, RemapByHashPicksNearestMatch) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const int target = snap->BlockIndex("s0.b3");
  EXPECT_EQ(RemapBlockByHash(*snap, snap->blocks[target].textHash, 0), target);
  EXPECT_EQ(RemapBlockByHash(*snap, "0000000000000000", 0), -1);
  ReaderRegistry::Instance().Release(id);
}

/**
 * Golden: id, type, level and textHash of every block of structure.epub.
 * A change here means the decomposition changed: bump the structure version
 * (docs/reader.md) and regenerate with SHERPA_UPDATE_GOLDEN=1.
 */
TEST(ReaderDocument, StructureV1Golden) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  std::ostringstream got;
  got << "# reader structure v" << kStructureVersion << ", textHash v" << kTextHashVersion
      << ": id type level textHash\n";
  for (const auto& b : snap->blocks) {
    got << b.id << ' ' << ReaderBlockTypeName(b.type) << ' ' << b.headingLevel << ' '
        << b.textHash << '\n';
  }
  ReaderRegistry::Instance().Release(id);
  const std::string path = RepoPath("test/fixtures/reader/structure.reader-v1.txt");
  if (std::getenv("SHERPA_UPDATE_GOLDEN")) {
    std::ofstream(path) << got.str();
  }
  std::ifstream f(path);
  ASSERT_TRUE(f.good()) << "missing golden " << path << " (run with SHERPA_UPDATE_GOLDEN=1)";
  std::stringstream want;
  want << f.rdbuf();
  EXPECT_EQ(got.str(), want.str());
}

namespace {

/** Golden lines for a fixture: id type level textHash imageHref (per format, versioned). */
void ExpectGolden(const char* fixture, const char* golden, const std::vector<std::string>& frames) {
  const std::string id = CreateDoc(fixture, frames);
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);
  std::ostringstream got;
  got << "# " << snap->format << " structure v" << snap->structureVersion << ", textHash v"
      << kTextHashVersion << ": id type level textHash imageHref frame\n";
  got << "# title=" << snap->title << " creator=" << snap->creator
      << " language=" << snap->language << "\n";
  for (const auto& b : snap->blocks) {
    got << b.id << ' ' << ReaderBlockTypeName(b.type) << ' ' << b.headingLevel << ' '
        << b.textHash;
    if (!b.imageHref.empty()) got << ' ' << b.imageHref << ' ' << b.imageFrame;
    got << '\n';
  }
  ReaderRegistry::Instance().Release(id);
  const std::string path = RepoPath(std::string("test/fixtures/reader/") + golden);
  if (std::getenv("SHERPA_UPDATE_GOLDEN")) {
    std::ofstream(path) << got.str();
  }
  std::ifstream f(path);
  ASSERT_TRUE(f.good()) << "missing golden " << path << " (run with SHERPA_UPDATE_GOLDEN=1)";
  std::stringstream want;
  want << f.rdbuf();
  EXPECT_EQ(got.str(), want.str());
}

}  // namespace

namespace {

std::string Sha256Hex16(const std::string& bytes) {
  sherpa_onnx::crypto::Sha256Context ctx;
  sherpa_onnx::crypto::sha256_init(&ctx);
  sherpa_onnx::crypto::sha256_update(&ctx, reinterpret_cast<const uint8_t*>(bytes.data()),
                                     bytes.size());
  uint8_t digest[32];
  sherpa_onnx::crypto::sha256_final(&ctx, digest);
  static const char* kHex = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < 8; ++i) {
    out.push_back(kHex[digest[i] >> 4]);
    out.push_back(kHex[digest[i] & 15]);
  }
  return out;
}

}  // namespace

/**
 * Text identity: the text buffer and every block's ID, type, level, textHash and
 * UTF-16 range, hashed per book. Recorded before inline styles were extracted, so
 * style runs provably leave the text, IDs, hashes and offsets untouched.
 */
TEST(ReaderDocument, TextIdentityGolden) {
  const char* kBooks[] = {
      "structure.epub", "structure-ncx.epub", "mixed.epub", "long.epub", "styles.epub",
      "structure.fb2", "north-wind.fb2", "styles.fb2", "structure.mobi", "structure.azw3",
      "tiny.mobi", "tiny.azw3", "fdst.azw3", "kf8-skel.azw3",
      "../../../example/ios/sherpa_models/test_edocs/frankenstein.epub",
  };
  std::ostringstream got;
  got << "# text identity, structure v" << kStructureVersion << ", textHash v" << kTextHashVersion
      << ": book blocks textSha blocksSha\n";
  for (const char* book : kBooks) {
    auto entry = LoadEntry(book);
    ReaderError err;
    const std::string id = ReaderRegistry::Instance().Create(entry, "img_off_test", {}, "key", &err);
    ASSERT_FALSE(id.empty()) << book << ": " << err.code << " " << err.message;
    auto snap = ReaderRegistry::Instance().Snapshot(id);
    std::ostringstream lines;
    for (int i = 0; i < static_cast<int>(snap->blocks.size()); ++i) {
      const auto& b = snap->blocks[i];
      lines << b.id << ' ' << ReaderBlockTypeName(b.type) << ' ' << b.headingLevel << ' '
            << b.textHash << ' ' << b.utf16Start << ' ' << b.utf16End << ' '
            << snap->BlockLength(i) << ' ' << snap->BlockText(i) << '\n';
    }
    std::string name = book;
    name = name.substr(name.rfind('/') + 1);
    got << name << ' ' << snap->blocks.size() << ' ' << Sha256Hex16(entry->text) << ' '
        << Sha256Hex16(lines.str()) << '\n';
    ReaderRegistry::Instance().Release(id);
  }
  const std::string path = RepoPath("test/fixtures/reader/text-identity.reader-v1.txt");
  if (std::getenv("SHERPA_UPDATE_GOLDEN")) {
    std::ofstream(path) << got.str();
  }
  std::ifstream f(path);
  ASSERT_TRUE(f.good()) << "missing golden " << path << " (run with SHERPA_UPDATE_GOLDEN=1)";
  std::stringstream want;
  want << f.rdbuf();
  EXPECT_EQ(got.str(), want.str());
}

namespace {

/** "text|[start,end)ib ..." per text block: the styled substrings with their flags. */
std::string StyleDump(const char* fixture) {
  const std::string id = CreateDoc(fixture);
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  std::ostringstream out;
  for (int i = 0; i < static_cast<int>(snap->blocks.size()); ++i) {
    const auto& b = snap->blocks[i];
    if (b.type != ReaderBlockType::Paragraph && b.type != ReaderBlockType::Heading) continue;
    out << b.id << ':';
    const std::string text = snap->BlockText(i);
    int last = 0;
    for (const auto& r : b.styles) {
      EXPECT_LE(last, r.start) << b.id << " runs sorted, not overlapping";
      EXPECT_LT(r.start, r.end) << b.id;
      EXPECT_LE(r.end, snap->BlockLength(i)) << b.id;
      last = r.end;
      out << " [" << txt_utf16_slice(text, r.start, r.end - r.start) << ']' << ((r.flags & kTxtStyleItalic) ? "i" : "") << ((r.flags & kTxtStyleBold) ? "b" : "");
    }
    out << '\n';
  }
  ReaderRegistry::Instance().Release(id);
  return out.str();
}

}  // namespace

// Nested and overlapping tags, a <br> inside a run, collapsed / trimmed whitespace,
// a tag around whole blocks, inline style="", a styled link, cite and pre.
TEST(ReaderStyles, EpubItalicBoldRunsOnTheFinalText) {
  EXPECT_EQ(StyleDump("styles.epub"),
            "s0.b0: [North]i\n"
            "s0.b1: [italic]i [bold]b\n"
            "s0.b2: [Italic with ]i [bold inside]ib [ it]i [bold ]b [and both]ib [ italic]i\n"
            "s0.b3: [Leading space ]i\n"
            "s0.b4: [First line\nsecond line]i [bold after a break]b\n"
            "s0.b5: [na\xC3\xAFve \xF0\x9F\x98\x80 smile]i\n"
            "s0.b6: [One italic paragraph.]i\n"
            "s0.b7: [Another ]i [one]ib [.]i\n"
            "s0.b8: [Inline italic]i [inline bold]b [not ]i\n"
            "s0.b9: [linked]i [cited title]i\n"
            "s0.b10: [this]i\n");
  // UTF-16 offsets: "Caf\u00e9 " is 5 units, the emoji 2.
  const std::string id = CreateDoc("styles.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const ReaderBlock& cafe = snap->blocks[snap->BlockIndex("s0.b5")];
  ASSERT_EQ(cafe.styles.size(), 1u);
  EXPECT_EQ(cafe.styles[0].start, 5);
  EXPECT_EQ(cafe.styles[0].end, 19);
  // JSON: only with text, flags as booleans.
  const int i = snap->BlockIndex("s0.b1");
  EXPECT_NE(BlocksJson(*snap, i, 1, true).find(
                "\"styles\":[{\"start\":6,\"end\":12,\"italic\":true},"
                "{\"start\":17,\"end\":21,\"bold\":true}]"),
            std::string::npos);
  EXPECT_EQ(BlocksJson(*snap, i, 1, false).find("styles"), std::string::npos);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderStyles, Fb2EmphasisAndStrong) {
  EXPECT_EQ(StyleDump("styles.fb2"),
            "s0.b0: [North]i [Wind]b\n"
            "s0.b1: [italic]i [bold ]b [both]ib\n"
            "s0.b2: [Leading space ]i\n"
            "s0.b3: [link]i\n"
            "s0.b4: [The tide]i [goes out.]b\n");
}

TEST(ReaderStyles, PlainFormatsAndAppBlocksHaveNone) {
  const std::string id = CreateDoc("structure.epub");
  ReaderAppSectionInput app;
  app.after = "s0";
  app.id = "app:guide";
  app.blocks.push_back({"intro", ReaderBlockType::Paragraph, "Plain app text.", 0});
  ReaderError err;
  ASSERT_TRUE(ReaderRegistry::Instance().InsertSection(id, app, &err)) << err.message;
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  int styled = 0;
  for (const auto& b : snap->blocks) styled += b.styles.empty() ? 0 : 1;
  EXPECT_EQ(styled, 1);  // "<em>striking</em>" in s0.b2
  EXPECT_TRUE(snap->blocks[snap->BlockIndex("app:guide.intro")].styles.empty());
  ReaderRegistry::Instance().Release(id);
}

namespace {

/** book.pdf, layout "paragraphs", as a populated text entry. */
std::shared_ptr<TxtOfflineEntry> LoadPdfEntry() {
  sherpa_onnx::pdf::PdfSource src;
  src.path = RepoPath("test/fixtures/pdf/book.pdf");
  sherpa_onnx::pdf::ExtractOptions opts;
  opts.layout = sherpa_onnx::pdf::PdfTextLayout::kParagraphs;
  auto r = sherpa_onnx::pdf::ExtractPdfTextLayer(src, opts);
  EXPECT_TRUE(r.ok) << r.error_code << " " << r.error_message;
  // Spans as PopulateTextFromPdf stores them (line quads with the page size).
  std::vector<TxtSpatialSpan> spans;
  for (const auto& ps : r.spans) {
    TxtSpatialSpan t;
    t.utf16Start = ps.utf16_start;
    t.utf16End = ps.utf16_end;
    t.level = ps.level;
    t.frameIndex = ps.frame_index;
    for (int i = 0; i < 8; ++i) t.quad[i] = ps.quad[i];
    t.origin = "textLayer";
    t.hasPageWidth = t.hasPageHeight = true;
    t.pageWidth = ps.page_width;
    t.pageHeight = ps.page_height;
    spans.push_back(t);
  }
  auto entry = std::make_shared<TxtOfflineEntry>();
  entry->bufferId = "txt_off_pdf";
  EXPECT_TRUE(entry->tryPopulate(r.text, {}, {}, {}, "", "", "", spans));
  EXPECT_TRUE(entry->trySetStructure(r.structure));
  return entry;
}

std::string CreatePdfDoc() {
  ReaderError err;
  const std::string id =
      ReaderRegistry::Instance().Create(LoadPdfEntry(), "img_pdf_pages", {}, "book", &err);
  EXPECT_FALSE(id.empty()) << err.code << " " << err.message;
  return id;
}

}  // namespace

/** Golden for book.pdf: sections with labels, blocks with flags, frames and rects. */
TEST(ReaderDocument, PdfStructureGolden) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);
  std::ostringstream got;
  got << "# " << snap->format << " structure v" << snap->structureVersion << ", textHash v"
      << kTextHashVersion << ": id type level flags textHash frame rect\n";
  got << "# title=" << snap->title << " creator=" << snap->creator
      << " language=" << snap->language << "\n";
  char rect[64];
  for (const auto& sec : snap->sections) {
    got << "# " << sec.id << " kind=" << sec.kind << " label=" << sec.label
        << " title=" << sec.title << " (" << sec.titleSource << ")\n";
    for (int k = 0; k < sec.blockCount; ++k) {
      const auto& b = snap->blocks[sec.firstBlock + k];
      got << b.id << ' ' << ReaderBlockTypeName(b.type) << ' ' << b.headingLevel << ' '
          << b.flags << ' ' << b.textHash << ' ' << b.imageFrame;
      if (b.hasRect) {
        std::snprintf(rect, sizeof(rect), " %.3f,%.3f,%.3f,%.3f", b.rect[0], b.rect[1],
                      b.rect[2], b.rect[3]);
        got << rect;
      }
      got << '\n';
    }
  }
  for (const auto& t : snap->toc) got << "toc " << t.level << ' ' << t.blockId << ' ' << t.title << '\n';
  ReaderRegistry::Instance().Release(id);
  const std::string path = RepoPath("test/fixtures/reader/book.pdf.reader-v1.txt");
  if (std::getenv("SHERPA_UPDATE_GOLDEN")) {
    std::ofstream(path) << got.str();
  }
  std::ifstream f(path);
  ASSERT_TRUE(f.good()) << "missing golden " << path << " (run with SHERPA_UPDATE_GOLDEN=1)";
  std::stringstream want;
  want << f.rdbuf();
  EXPECT_EQ(got.str(), want.str());
}

TEST(ReaderDocument, PdfPagesTocAndSummary) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);
  EXPECT_EQ(snap->format, "pdf");
  ASSERT_EQ(snap->sections.size(), 6u);
  for (int i = 0; i < 6; ++i) {
    const auto& page = snap->blocks[snap->sections[i].firstBlock];
    EXPECT_EQ(page.id, "s" + std::to_string(i) + ".b0");
    EXPECT_EQ(page.type, ReaderBlockType::Page);
    EXPECT_EQ(page.imageFrame, i) << "frame of the lazy page buffer";
  }
  EXPECT_EQ(snap->BlockText(snap->BlockIndex("s2.b3")), "Chapter One");
  EXPECT_TRUE(snap->blocks[snap->BlockIndex("s2.b1")].flags & kBlockFurniture);
  ASSERT_EQ(snap->toc.size(), 5u);
  EXPECT_EQ(snap->toc[1].blockId, "s2.b3");
  EXPECT_EQ(snap->toc[4].blockId, "s5.b0");
  const std::string json = SnapshotSummaryJson(*snap);
  EXPECT_NE(json.find("\"label\":\"ii\""), std::string::npos) << json;
  EXPECT_NE(json.find("\"kind\":\"page\""), std::string::npos) << json;
  ReaderRegistry::Instance().Release(id);
}

// ---- Rows per page display (ReaderLayout) ----------------------------------

namespace {

std::string RowsText(const ReaderSnapshot& snap, const std::vector<ReaderRow>& rows, int section) {
  std::string out;
  for (const auto& r : rows) {
    if (snap.blocks[r.block].section != section) continue;
    if (!out.empty()) out += ' ';
    out += snap.blocks[r.block].id.substr(snap.blocks[r.block].id.find('.') + 1);
    out += '[' + std::to_string(r.coverFirst - snap.sections[section].firstBlock) + '-' +
           std::to_string(r.coverLast - snap.sections[section].firstBlock) + ']';
    if (r.page) out += 'P';
  }
  return out;
}

}  // namespace

TEST(ReaderLayout, PdfRowsPerDisplayMode) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);

  // Text: the page image only for the plate (no text), running header and
  // page number hidden but covered by the first row of the page.
  auto text = PlanRows(*snap, PageDisplay::kText);
  EXPECT_EQ(RowsText(*snap, text, 2), "b3[0-3] b4[4-4] b5[5-5] b6[6-6] b7[7-7]");
  EXPECT_EQ(RowsText(*snap, text, 0), "b1[0-1] b2[2-2]");
  EXPECT_EQ(RowsText(*snap, text, 5), "b0[0-0]P");

  // Image: one full-width page per page, standing for all its blocks.
  auto image = PlanRows(*snap, PageDisplay::kImage);
  ASSERT_EQ(image.size(), 6u);
  EXPECT_EQ(RowsText(*snap, image, 2), "b0[0-7]P");

  // Image and text: the page, then its text; furniture joins the page row.
  auto both = PlanRows(*snap, PageDisplay::kImageAndText);
  EXPECT_EQ(RowsText(*snap, both, 2), "b0[0-2]P b3[3-3] b4[4-4] b5[5-5] b6[6-6] b7[7-7]");

  // Every block is covered exactly once, in order.
  for (const auto* rows : {&text, &image, &both}) {
    int next = 0;
    for (const auto& r : *rows) {
      EXPECT_EQ(r.coverFirst, next);
      EXPECT_LE(r.coverFirst, r.block);
      EXPECT_LE(r.block, r.coverLast);
      next = r.coverLast + 1;
    }
    EXPECT_EQ(next, static_cast<int>(snap->blocks.size()));
  }

  // Hidden blocks find the row that stands for them.
  const int header = snap->BlockIndex("s2.b1");
  const int heading = snap->BlockIndex("s2.b3");
  EXPECT_EQ(text[RowOfBlock(text, header)].block, heading);
  EXPECT_EQ(image[RowOfBlock(image, heading)].block, snap->BlockIndex("s2.b0"));
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderLayout, VisibleBlocksOnAPageImageFollowTheirRectangles) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  auto rows = PlanRows(*snap, PageDisplay::kImage);
  const ReaderRow& page3 = rows[RowOfBlock(rows, snap->BlockIndex("s2.b0"))];
  int first = -1;
  int last = -1;
  // Top 80 % of the page on screen: the page itself through the last paragraph.
  ASSERT_TRUE(RowVisibleBlocks(*snap, page3, 0, 800, 1000, 800, &first, &last));
  EXPECT_EQ(snap->blocks[first].id, "s2.b0");
  EXPECT_EQ(snap->blocks[last].id, "s2.b7");
  // Scrolled into the page: the heading is off screen, the page top too.
  ASSERT_TRUE(RowVisibleBlocks(*snap, page3, 250, 1050, 1000, 800, &first, &last));
  EXPECT_EQ(snap->blocks[first].id, "s2.b2") << "the page number at the bottom";
  EXPECT_EQ(snap->blocks[last].id, "s2.b7");
  // Only empty space of the page on screen (between the text and the footer):
  // the page itself counts.
  ASSERT_TRUE(RowVisibleBlocks(*snap, page3, 500, 900, 1000, 400, &first, &last));
  EXPECT_EQ(snap->blocks[first].id, "s2.b0");
  EXPECT_EQ(first, last);
  // A sliver of the page: nothing.
  EXPECT_FALSE(RowVisibleBlocks(*snap, page3, 990, 1000, 1000, 400, &first, &last));
  // Offsets for scrollTo.
  EXPECT_NEAR(BlockOffsetInRow(*snap, page3, snap->BlockIndex("s2.b5"), 1000), 196, 2);
  EXPECT_EQ(BlockOffsetInRow(*snap, page3, snap->BlockIndex("s2.b0"), 1000), 0);

  // Plain rows: the half rule over the whole row, covering hidden blocks.
  auto text = PlanRows(*snap, PageDisplay::kText);
  const ReaderRow& heading = text[RowOfBlock(text, snap->BlockIndex("s2.b3"))];
  ASSERT_TRUE(RowVisibleBlocks(*snap, heading, 0, 40, 40, 800, &first, &last));
  EXPECT_EQ(snap->blocks[first].id, "s2.b0");
  EXPECT_EQ(snap->blocks[last].id, "s2.b3");
  EXPECT_FALSE(RowVisibleBlocks(*snap, heading, 30, 40, 40, 800, &first, &last));
  // The shown rule (visible range): any part counts, a sliver of the page too.
  ASSERT_TRUE(RowVisibleBlocks(*snap, heading, 30, 40, 40, 800, &first, &last, VisibleRule::kShown));
  EXPECT_EQ(snap->blocks[last].id, "s2.b3");
  EXPECT_FALSE(RowVisibleBlocks(*snap, heading, 39.5f, 40, 40, 800, &first, &last, VisibleRule::kShown));
  ASSERT_TRUE(RowVisibleBlocks(*snap, page3, 990, 1000, 1000, 400, &first, &last, VisibleRule::kShown));
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderDocument, PageDocumentOneSectionPerFrame) {
  ReaderError err;
  std::vector<ReaderRegistry::PageInput> pages(3);
  pages[0].href = "001.jpg";
  pages[0].pageNumber = 1;
  pages[1].href = "002.jpg";
  pages[1].pageNumber = 2;
  // pages[2]: no href → page:3
  const std::string id =
      ReaderRegistry::Instance().CreatePages("img_off_pages", pages, "comic", &err);
  ASSERT_FALSE(id.empty()) << err.message;
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  EXPECT_EQ(snap->format, "pages");
  EXPECT_EQ(snap->structureVersion, 1);
  ASSERT_EQ(snap->sections.size(), 3u);
  ASSERT_EQ(snap->blocks.size(), 3u);
  EXPECT_EQ(snap->sections[1].kind, "page");
  EXPECT_EQ(snap->sections[1].label, "2");
  EXPECT_EQ(snap->sections[2].href, "page:3");
  EXPECT_EQ(snap->blocks[2].id, "s2.b0");
  EXPECT_EQ(snap->blocks[2].type, ReaderBlockType::Page);
  EXPECT_EQ(snap->blocks[2].imageFrame, 2);
  EXPECT_EQ(snap->blocks[0].textHash, ImageHashV1("001.jpg")) << "stable per archive path";
  // Without text, every mode shows the page images.
  for (auto mode : {PageDisplay::kText, PageDisplay::kImage, PageDisplay::kImageAndText}) {
    auto rows = PlanRows(*snap, mode);
    ASSERT_EQ(rows.size(), 3u);
    for (const auto& r : rows) EXPECT_TRUE(r.page);
  }
  const std::string json = SnapshotSummaryJson(*snap);
  EXPECT_NE(json.find("\"format\":\"pages\""), std::string::npos) << json;
  ReaderRegistry::Instance().Release(id);

  EXPECT_TRUE(ReaderRegistry::Instance().CreatePages("img_off_x", {}, "k", &err).empty());
  EXPECT_EQ(err.code, kErrReaderInvalidArgument);
}

// ---- OCR text on pages (attachReaderPageText) ------------------------------

namespace {

TxtSpatialSpan LineSpan(int start, int end, int frame, float x0, float y0, float x1, float y1) {
  TxtSpatialSpan s;
  s.utf16Start = start;
  s.utf16End = end;
  s.level = "line";
  s.frameIndex = frame;
  const float q[8] = {x0, y0, x1, y0, x1, y1, x0, y1};
  for (int i = 0; i < 8; ++i) s.quad[i] = q[i];
  s.origin = "ocr";
  return s;
}

/**
 * Two 1000x1400 frames of `img_off_ocr`. Frame 0: a title, a paragraph of two
 * lines and a page number at the bottom; frame 1: one paragraph.
 */
std::shared_ptr<TxtOfflineEntry> OcrEntry(const std::string& imageBufferId, bool withFrame1 = true) {
  const std::string text = withFrame1
      ? "The Harbour\n\nShips came in at night and\nleft before dawn.\n\n12\n\nSecond page."
      : "The Harbour\n\nShips came in at night and\nleft before dawn.\n\n12";
  std::vector<TxtSpatialSpan> spans = {
      LineSpan(0, 11, 0, 100, 100, 600, 160),
      LineSpan(13, 39, 0, 100, 300, 900, 340),
      LineSpan(40, 57, 0, 100, 350, 500, 390),
      LineSpan(59, 61, 0, 480, 1340, 520, 1370),
  };
  if (withFrame1) spans.push_back(LineSpan(63, 75, 1, 100, 100, 400, 140));
  auto entry = std::make_shared<TxtOfflineEntry>();
  EXPECT_TRUE(entry->tryPopulate(text, {}, {}, {}, "", "", "", spans));
  auto layout = std::make_shared<TxtOcrLayout>();
  layout->family = "ppocr";
  layout->imageBufferId = imageBufferId;
  layout->frames.push_back({0, 0, 61, 1000, 1400});
  if (withFrame1) layout->frames.push_back({1, 63, 75, 1000, 1400});
  TxtOcrElement title;
  title.kind = "title";
  title.frameIndex = 0;
  title.hasUtf16 = true;
  title.utf16Start = 0;
  title.utf16End = 11;
  layout->elements.push_back(title);
  EXPECT_TRUE(entry->trySetOcrLayout(layout));
  return entry;
}

std::string CreateTwoPages(const std::string& imageBufferId) {
  ReaderError err;
  std::vector<ReaderRegistry::PageInput> pages(2);
  const std::string id = ReaderRegistry::Instance().CreatePages(imageBufferId, pages, "scan", &err);
  EXPECT_FALSE(id.empty()) << err.message;
  return id;
}

}  // namespace

TEST(ReaderOcrText, BlocksFromParagraphsElementsAndLines) {
  auto entry = OcrEntry("img_off_ocr");
  const auto frames = BuildOcrFrameBlocks(*entry, *entry->getOcrLayout());
  ASSERT_EQ(frames.size(), 2u);
  ASSERT_EQ(frames[0].blocks.size(), 3u);
  const auto& title = frames[0].blocks[0];
  EXPECT_EQ(title.type, ReaderBlockType::Heading);
  EXPECT_EQ(title.headingLevel, 1);
  EXPECT_EQ(title.utf16Start, 0);
  EXPECT_EQ(title.utf16End, 11);
  const auto& para = frames[0].blocks[1];
  EXPECT_EQ(para.type, ReaderBlockType::Paragraph);
  EXPECT_EQ(para.utf16Start, 13);
  EXPECT_EQ(para.utf16End, 57);
  ASSERT_TRUE(para.hasRect);
  EXPECT_NEAR(para.rect[0], 0.1f, 1e-4);
  EXPECT_NEAR(para.rect[1], 300.f / 1400, 1e-4);
  EXPECT_NEAR(para.rect[2], 0.8f, 1e-4) << "union of both lines";
  EXPECT_NEAR(para.rect[3], 90.f / 1400, 1e-4);
  EXPECT_TRUE(frames[0].blocks[2].flags & kBlockFurniture) << "page number at the bottom";
  EXPECT_EQ(frames[1].frameIndex, 1);
  ASSERT_EQ(frames[1].blocks.size(), 1u);
}

TEST(ReaderOcrText, AttachAddsChildBlocksAndReplacesThem) {
  const std::string id = CreateTwoPages("img_off_ocr");
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  int attached = 0;
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_ocr"), &attached, &err)) << err.message;
  EXPECT_EQ(attached, 4);
  auto snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 2);
  ASSERT_EQ(snap->blocks.size(), 6u);
  EXPECT_EQ(snap->blocks[1].id, "s0.b0.t0");
  EXPECT_EQ(snap->BlockText(1), "The Harbour");
  EXPECT_EQ(snap->blocks[1].type, ReaderBlockType::Heading);
  EXPECT_EQ(snap->BlockText(2), "Ships came in at night and\nleft before dawn.");
  EXPECT_EQ(snap->blocks[2].textHash, TextHashV1(snap->BlockText(2)));
  EXPECT_FALSE(snap->blocks[2].fromFile);
  EXPECT_EQ(snap->blocks[5].id, "s1.b0.t0");
  EXPECT_EQ(snap->sections[0].blockCount, 4);
  EXPECT_EQ(snap->sections[0].title, "The Harbour");
  EXPECT_EQ(snap->sections[0].titleSource, "heading");
  EXPECT_EQ(snap->blocks[snap->BlockIndex("s1.b0.t0")].section, 1);

  // Text mode now shows the text, page image hidden; the page number is hidden too.
  auto rows = PlanRows(*snap, PageDisplay::kText);
  std::vector<std::string> shown;
  for (const auto& r : rows) shown.push_back(snap->blocks[r.block].id);
  EXPECT_EQ(shown, (std::vector<std::string>{"s0.b0.t0", "s0.b0.t1", "s1.b0.t0"}));
  // Image mode keeps one page per page.
  EXPECT_EQ(PlanRows(*snap, PageDisplay::kImage).size(), 2u);
  const std::string pages = PagesJson(*snap);
  EXPECT_NE(pages.find("\"hasText\":true"), std::string::npos) << pages;
  EXPECT_EQ(pages.find("\"hasText\":false"), std::string::npos) << pages;

  // Recognizing page 0 again replaces its children; page 1 keeps its text.
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_ocr", false), &attached, &err));
  snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 3);
  EXPECT_EQ(snap->blocks.size(), 6u);
  EXPECT_GE(snap->BlockIndex("s1.b0.t0"), 0);
  reg.Release(id);
}

TEST(ReaderOcrText, AttachRejectsOtherBuffersAndPlainText) {
  const std::string id = CreateTwoPages("img_off_mine");
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  EXPECT_FALSE(reg.AttachPageText(id, OcrEntry("img_off_other"), nullptr, &err));
  EXPECT_EQ(err.code, kErrReaderInvalidArgument);
  auto plain = std::make_shared<TxtOfflineEntry>();
  ASSERT_TRUE(plain->tryPopulate("plain", {}, {}, {}, "", "", ""));
  EXPECT_FALSE(reg.AttachPageText(id, plain, nullptr, &err));
  EXPECT_EQ(err.code, kErrReaderInvalidArgument);
  EXPECT_EQ(reg.Snapshot(id)->revision, 1);
  const std::string pages = PagesJson(*reg.Snapshot(id));
  EXPECT_NE(pages.find("\"imageBufferId\":\"img_off_mine\""), std::string::npos) << pages;
  EXPECT_NE(pages.find("{\"sectionId\":\"s1\",\"blockId\":\"s1.b0\",\"frame\":1,\"hasText\":false}"),
            std::string::npos)
      << pages;
  reg.Release(id);
}

// ---- Text slices for reading aloud ----------------------------------------

TEST(ReaderTextSlice, FromAnOffsetAcrossBlocksAndBack) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ReaderTextSlice slice;
  ASSERT_TRUE(BuildTextSlice(*snap, 0, 3, -1, 0, &slice));
  EXPECT_EQ(slice.text.rfind("pter One\n\n", 0), 0u) << slice.text.substr(0, 40);
  ASSERT_GE(slice.entries.size(), 2u);
  EXPECT_EQ(slice.entries[0].blockId, "s0.b0");
  EXPECT_EQ(slice.entries[0].blockOffset, 3);
  EXPECT_EQ(slice.entries[0].length, 8);
  EXPECT_EQ(slice.entries[1].sliceStart, 10);
  // A range inside the first block, and one across the blank line.
  int a = -1, ao = 0, z = -1, zo = 0;
  ASSERT_TRUE(MapSliceRange(slice, *snap, 0, 4, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[a].id, "s0.b0");
  EXPECT_EQ(ao, 3);
  EXPECT_EQ(zo, 7);
  ASSERT_TRUE(MapSliceRange(slice, *snap, 5, 14, &a, &ao, &z, &zo));
  EXPECT_EQ(ao, 8);
  EXPECT_EQ(snap->blocks[z].id, slice.entries[1].blockId);
  EXPECT_EQ(zo, 4);
  EXPECT_FALSE(MapSliceRange(slice, *snap, 8, 10, &a, &ao, &z, &zo)) << "only the blank line";
  // maxLength stops before a block that would not fit; the first block always fits.
  ReaderTextSlice small;
  ASSERT_TRUE(BuildTextSlice(*snap, 0, 0, -1, 5, &small));
  EXPECT_EQ(small.entries.size(), 1u);
  EXPECT_EQ(small.text, "Chapter One");
  // toBlock is inclusive.
  ReaderTextSlice two;
  ASSERT_TRUE(BuildTextSlice(*snap, 0, 0, 1, 0, &two));
  EXPECT_EQ(two.entries.size(), 2u);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderTextSlice, PdfSliceSkipsFurnitureAndPages) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ReaderTextSlice slice;
  // From page 3's page block across to page 4.
  ASSERT_TRUE(BuildTextSlice(*snap, snap->BlockIndex("s2.b0"), 0, snap->BlockIndex("s3.b3"), 0,
                             &slice));
  EXPECT_EQ(slice.entries.front().blockId, "s2.b3") << "page image and running header skipped";
  EXPECT_EQ(slice.entries.back().blockId, "s3.b3") << "page 4's header and number skipped";
  for (const auto& e : slice.entries) EXPECT_NE(e.blockId, "s3.b1");
  EXPECT_NE(slice.text.find("coat and the\n\nrain came in sideways"), std::string::npos)
      << "a paragraph across the page break reads on";
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderTextSlice, OcrBlocksAreReadAndSlicesGoWithTheDocument) {
  const std::string id = CreateTwoPages("img_off_ocr");
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_ocr"), nullptr, &err));
  auto snap = reg.Snapshot(id);
  auto slice = std::make_shared<ReaderTextSlice>();
  ASSERT_TRUE(BuildTextSlice(*snap, 0, 0, -1, 0, slice.get()));
  EXPECT_EQ(slice->text,
            "The Harbour\n\nShips came in at night and\nleft before dawn.\n\nSecond page.")
      << "the page number is not read";
  reg.AddSlice("txt_off_slice", slice);
  EXPECT_TRUE(reg.Slice("txt_off_slice"));
  reg.Release(id);
  EXPECT_FALSE(reg.Slice("txt_off_slice")) << "released with its document";
}

// ---- Highlights on page images -------------------------------------------

TEST(ReaderHighlightRects, PdfLinesAndPartsOfALine) {
  if (!sherpa_onnx::pdf::IsPdfiumCompiledIn()) GTEST_SKIP() << "PDFium not linked";
  const std::string id = CreatePdfDoc();
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const int para = snap->BlockIndex("s2.b5");
  const auto& b = snap->blocks[para];
  ASSERT_EQ(b.lines.size(), 3u) << "three lines on the page";
  EXPECT_EQ(b.lines[0].start, 0);
  EXPECT_EQ(b.lines.back().end, snap->BlockLength(para));
  const auto all = TextRangeRects(*snap, para, 0, snap->BlockLength(para));
  ASSERT_EQ(all.size(), 3u);
  for (const auto& r : all) {
    EXPECT_GE(r.y, b.rect[1] - 1e-3f);
    EXPECT_LE(r.y + r.h, b.rect[1] + b.rect[3] + 1e-3f);
  }
  // The first word: the left part of the first line.
  const auto word = TextRangeRects(*snap, para, 0, 3);
  ASSERT_EQ(word.size(), 1u);
  EXPECT_NEAR(word[0].x, all[0].x, 1e-4);
  EXPECT_LT(word[0].w, all[0].w / 5);
  EXPECT_FLOAT_EQ(word[0].y, all[0].y);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderHighlightRects, OcrLinesThenBlockThenPage) {
  const std::string id = CreateTwoPages("img_off_ocr");
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_ocr"), nullptr, &err));
  auto snap = reg.Snapshot(id);
  const int para = snap->BlockIndex("s0.b0.t1");  // two recognized lines
  ASSERT_EQ(snap->blocks[para].lines.size(), 2u);
  // "left" starts the second line: its rect starts at the line's left edge.
  const auto left = TextRangeRects(*snap, para, 27, 31);
  ASSERT_EQ(left.size(), 1u);
  EXPECT_NEAR(left[0].x, 0.1f, 1e-4);
  EXPECT_NEAR(left[0].y, 350.f / 1400, 1e-4);
  // A block without line boxes: its rectangle; without a rectangle: the page.
  ReaderSnapshot copy = *snap;
  copy.blocks[para].lines.clear();
  const auto block = TextRangeRects(copy, para, 0, 5);
  ASSERT_EQ(block.size(), 1u);
  EXPECT_NEAR(block[0].w, 0.8f, 1e-4);
  copy.blocks[para].hasRect = false;
  const auto page = TextRangeRects(copy, para, 0, 5);
  ASSERT_EQ(page.size(), 1u);
  EXPECT_EQ(page[0].w, 1.f);
  reg.Release(id);
}

// ---- Sidecar: save and load recognized pages ------------------------------

TEST(ReaderSidecar, RoundTripRestoresTheSameBlocks) {
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  const std::string id = CreateTwoPages("img_off_side");
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_side"), nullptr, &err));
  auto snap = reg.Snapshot(id);
  const SidecarContent saved = CollectRecognition(*snap, "ppocrv6-tiny");
  ASSERT_EQ(saved.pages.size(), 2u);
  EXPECT_EQ(saved.pages[0].family, "ppocr");
  const std::vector<uint8_t> bytes = EncodeSidecar(saved);

  // A fresh document of the same file (same documentKey) gets the text back.
  const std::string other = CreateTwoPages("img_off_side2");
  SidecarContent loaded;
  std::string error;
  ASSERT_TRUE(DecodeSidecar(bytes.data(), bytes.size(), &loaded, &error)) << error;
  int pages = 0;
  ASSERT_TRUE(reg.AttachRecognition(other, loaded, "ppocrv6-tiny", &pages, &err)) << err.message;
  EXPECT_EQ(pages, 2);
  auto restored = reg.Snapshot(other);
  EXPECT_EQ(restored->revision, 2);
  ASSERT_EQ(restored->blocks.size(), snap->blocks.size());
  for (size_t i = 0; i < snap->blocks.size(); ++i) {
    const auto& a = snap->blocks[i];
    const auto& b = restored->blocks[i];
    EXPECT_EQ(a.id, b.id);
    EXPECT_EQ(a.type, b.type);
    EXPECT_EQ(a.flags, b.flags);
    EXPECT_EQ(a.textHash, b.textHash);
    EXPECT_EQ(snap->BlockText(static_cast<int>(i)), restored->BlockText(static_cast<int>(i)));
    EXPECT_EQ(a.lines.size(), b.lines.size());
    if (a.hasRect) EXPECT_FLOAT_EQ(a.rect[1], b.rect[1]);
  }
  EXPECT_EQ(restored->sections[0].title, "The Harbour");
  reg.Release(id);
  reg.Release(other);
}

TEST(ReaderSidecar, RejectsOtherDocumentsModelsAndBrokenFiles) {
  auto& reg = ReaderRegistry::Instance();
  ReaderError err;
  const std::string id = CreateTwoPages("img_off_side3");
  ASSERT_TRUE(reg.AttachPageText(id, OcrEntry("img_off_side3"), nullptr, &err));
  SidecarContent saved = CollectRecognition(*reg.Snapshot(id), "model-a");
  auto bytes = EncodeSidecar(saved);
  SidecarContent loaded;
  std::string error;
  ASSERT_TRUE(DecodeSidecar(bytes.data(), bytes.size(), &loaded, &error));

  EXPECT_FALSE(reg.AttachRecognition(id, loaded, "model-b", nullptr, &err));
  EXPECT_EQ(err.code, kErrReaderSidecarMismatch);
  SidecarContent otherKey = loaded;
  otherKey.documentKey = "another-file";
  EXPECT_FALSE(reg.AttachRecognition(id, otherKey, "", nullptr, &err));
  EXPECT_EQ(err.code, kErrReaderSidecarMismatch);
  SidecarContent otherPage = loaded;
  otherPage.pages[0].parentBlockId = "s9.b0";
  EXPECT_FALSE(reg.AttachRecognition(id, otherPage, "", nullptr, &err));
  EXPECT_EQ(err.code, kErrReaderSidecarMismatch);
  EXPECT_EQ(reg.Snapshot(id)->revision, 2) << "nothing attached on a mismatch";

  // Truncated, wrong magic, empty.
  EXPECT_FALSE(DecodeSidecar(bytes.data(), bytes.size() - 3, &loaded, &error));
  auto bad = bytes;
  bad[0] = 'X';
  EXPECT_FALSE(DecodeSidecar(bad.data(), bad.size(), &loaded, &error));
  EXPECT_FALSE(DecodeSidecar(nullptr, 0, &loaded, &error));
  reg.Release(id);
}

TEST(ReaderLayout, NonPageSectionsKeepOneRowPerBlock) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  for (auto mode : {PageDisplay::kText, PageDisplay::kImage, PageDisplay::kImageAndText}) {
    auto rows = PlanRows(*snap, mode);
    ASSERT_EQ(rows.size(), snap->blocks.size());
    for (size_t i = 0; i < rows.size(); ++i) {
      EXPECT_EQ(rows[i].block, static_cast<int>(i));
      EXPECT_FALSE(rows[i].page);
    }
  }
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderDocument, MobiStructureGolden) {
  ExpectGolden("structure.mobi", "structure.mobi.reader-v1.txt", {"recindex:2", "recindex:1"});
}

TEST(ReaderDocument, Fb2StructureGolden) {
  ExpectGolden("structure.fb2", "structure.fb2.reader-v1.txt", {"map", "plate"});
}

TEST(ReaderDocument, Azw3StructureGolden) {
  ExpectGolden("structure.azw3", "structure.azw3.reader-v1.txt", {"recindex:2", "recindex:1"});
}

// ---- Tracker ------------------------------------------------------------

namespace {
using Kind = TrackerEvent::Kind;

int Count(const std::vector<TrackerEvent>& ev, Kind k) {
  int n = 0;
  for (const auto& e : ev) n += e.kind == k ? 1 : 0;
  return n;
}

const TrackerEvent* Find(const std::vector<TrackerEvent>& ev, Kind k) {
  for (const auto& e : ev) {
    if (e.kind == k) return &e;
  }
  return nullptr;
}
}  // namespace

TEST(ReaderTracker, ReadingForwardAdvancesFurthestAndSectionEnds) {
  // Sections end at blocks 9, 19, 29.
  ReaderTracker t({9, 19, 29}, 20);
  auto ev = t.Sample(0, 4, ScrollPhase::Layout);
  ASSERT_TRUE(Find(ev, Kind::Furthest));
  EXPECT_EQ(Find(ev, Kind::Furthest)->block, 4);
  ev = t.Sample(3, 8, ScrollPhase::Drag);
  EXPECT_EQ(Find(ev, Kind::Furthest)->block, 8);
  ev = t.Sample(6, 11, ScrollPhase::Drag);
  ASSERT_TRUE(Find(ev, Kind::SectionEnd));
  EXPECT_EQ(Find(ev, Kind::SectionEnd)->section, 0);
  // Still visible: no second section end.
  ev = t.Sample(7, 12, ScrollPhase::Idle);
  EXPECT_EQ(Count(ev, Kind::SectionEnd), 0);
  EXPECT_TRUE(Find(ev, Kind::VisibleRange)->settled);
  EXPECT_EQ(t.Frontier(), 12);
}

TEST(ReaderTracker, ShortFlingIsReadingLongFlingIsJump) {
  ReaderTracker t({}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  t.Sample(10, 14, ScrollPhase::Momentum);
  auto ev = t.Sample(12, 16, ScrollPhase::Idle);
  EXPECT_EQ(Count(ev, Kind::Jump), 0);
  EXPECT_EQ(t.Frontier(), 16);

  t.Sample(40, 44, ScrollPhase::Momentum);
  t.Sample(80, 84, ScrollPhase::Momentum);
  ev = t.Sample(90, 94, ScrollPhase::Idle);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "fling");
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 90 - 12);
  EXPECT_EQ(t.Frontier(), 16);  // jumps do not move the frontier
}

TEST(ReaderTracker, FarDragSampleAndScrollToAreJumps) {
  ReaderTracker t({}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  auto ev = t.Sample(50, 54, ScrollPhase::Drag);  // e.g. rows re-measured mid-drag
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "scroll");
  ev = t.Sample(5, 9, ScrollPhase::Programmatic);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "scrollTo");
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 5 - 50);
  // Back at the frontier: reading continues it.
  EXPECT_EQ(t.Frontier(), 9);
}

TEST(ReaderTracker, SlowIndicatorDragIsOneJumpFromItsStart) {
  // A slow drag of the scroll indicator moves a few blocks per sample, so as
  // finger scrolling it would read chapter after chapter.
  ReaderTracker t({9, 19, 29, 39, 49}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  auto ev = t.Sample(1, 5, ScrollPhase::Drag);  // a little reading first
  EXPECT_EQ(t.Frontier(), 5);
  int visible = 0;
  for (int f = 3; f <= 45; f += 3) {
    ev = t.Sample(f, f + 4, ScrollPhase::Scrub);
    EXPECT_EQ(Count(ev, Kind::Jump), 0);
    EXPECT_EQ(Count(ev, Kind::Furthest), 0);
    EXPECT_EQ(Count(ev, Kind::SectionEnd), 0);
    visible += Count(ev, Kind::VisibleRange);
  }
  EXPECT_GT(visible, 0);  // the visible range still follows the drag
  ev = t.Sample(46, 50, ScrollPhase::Scrub);  // the indicator glides out
  ev = t.Sample(47, 51, ScrollPhase::Idle);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Count(ev, Kind::Jump), 1);
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "drag");
  EXPECT_EQ(Find(ev, Kind::Jump)->from, 1);  // where the drag started
  EXPECT_EQ(Find(ev, Kind::Jump)->to, 47);
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 46);
  EXPECT_EQ(Count(ev, Kind::SectionEnd), 0);
  EXPECT_EQ(t.Frontier(), 5);  // not read until the app accepts it
  // Finger scrolling from the landing point is reading again, but the frontier
  // stays until the app sets it.
  ev = t.Sample(48, 52, ScrollPhase::Drag);
  EXPECT_EQ(Count(ev, Kind::Jump), 0);
  EXPECT_EQ(t.Frontier(), 5);
}

TEST(ReaderTracker, IndicatorDragIsAJumpWhateverTheDistance) {
  ReaderTracker t({}, 20);
  t.Sample(10, 14, ScrollPhase::Layout);
  t.Sample(11, 15, ScrollPhase::Scrub);
  auto ev = t.Sample(12, 16, ScrollPhase::Idle);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "drag");
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 2);
  // Within the read stretch: the landing continues the frontier like scrollTo.
  EXPECT_EQ(t.Frontier(), 16);
  // Back to the start position: nothing moved, no jump.
  t.Sample(30, 34, ScrollPhase::Scrub);
  t.Sample(30, 34, ScrollPhase::Layout);  // rows re-measured mid-drag
  ev = t.Sample(12, 16, ScrollPhase::Idle);
  EXPECT_EQ(Count(ev, Kind::Jump), 0);
  // Backwards is a jump too.
  t.Sample(5, 9, ScrollPhase::Scrub);
  ev = t.Sample(2, 6, ScrollPhase::Idle);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 2 - 12);
}

TEST(ReaderTracker, IndicatorDragEndsBeforeAScrollTo) {
  ReaderTracker t({}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  t.Sample(40, 44, ScrollPhase::Scrub);
  auto ev = t.Sample(70, 74, ScrollPhase::Programmatic);
  ASSERT_EQ(Count(ev, Kind::Jump), 2);
  EXPECT_EQ(ev[ev.size() - 2].cause, "drag");
  EXPECT_EQ(ev[ev.size() - 2].to, 40);
  EXPECT_EQ(ev.back().cause, "scrollTo");
  EXPECT_EQ(ev.back().from, 40);
}

TEST(ReaderTracker, ReadingAfterAJumpDoesNotMoveFrontierUntilAppConfirms) {
  ReaderTracker t({}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  t.Sample(60, 64, ScrollPhase::Programmatic);
  auto ev = t.Sample(62, 67, ScrollPhase::Drag);
  EXPECT_EQ(Count(ev, Kind::Furthest), 0);
  EXPECT_EQ(t.Frontier(), 4);
  // App confirms the jump: frontier set by the app, reading continues from it.
  t.SetFrontier(64);
  ev = t.Sample(64, 69, ScrollPhase::Drag);
  ASSERT_TRUE(Find(ev, Kind::Furthest));
  EXPECT_EQ(Find(ev, Kind::Furthest)->block, 69);
}

TEST(ReaderTracker, FrontierFromAppAndReadingBack) {
  ReaderTracker t({}, 20);
  t.SetFrontier(30);
  auto ev = t.Sample(25, 29, ScrollPhase::Layout);  // restored just before the frontier
  EXPECT_EQ(Count(ev, Kind::Furthest), 0);
  ev = t.Sample(28, 33, ScrollPhase::Drag);
  EXPECT_EQ(Find(ev, Kind::Furthest)->block, 33);
  ev = t.Sample(20, 24, ScrollPhase::Drag);  // reading back
  EXPECT_EQ(Count(ev, Kind::Furthest), 0);
  EXPECT_EQ(t.Frontier(), 33);
}

TEST(ReaderTracker, VisibleRangeReportsShownBlocksProgressUsesReadBlocks) {
  ReaderTracker t({9}, 20);
  // Blocks 2..6 at least half on screen; 1 (top) and 7 (bottom) only partly.
  auto ev = t.Sample(2, 6, ScrollPhase::Layout, 1, 7);
  ASSERT_TRUE(Find(ev, Kind::VisibleRange));
  EXPECT_EQ(Find(ev, Kind::VisibleRange)->first, 1);
  EXPECT_EQ(Find(ev, Kind::VisibleRange)->last, 7);
  EXPECT_EQ(t.Frontier(), 6) << "a partly shown block is not read";
  // Only the shown range changes: a visible-range event, no progress.
  ev = t.Sample(2, 6, ScrollPhase::Drag, 2, 8);
  ASSERT_TRUE(Find(ev, Kind::VisibleRange));
  EXPECT_EQ(Find(ev, Kind::VisibleRange)->last, 8);
  EXPECT_EQ(Count(ev, Kind::Furthest), 0);
  EXPECT_EQ(Count(ev, Kind::SectionEnd), 0);
  // The section's last block only peeks in: no section end until it is read.
  ev = t.Sample(4, 8, ScrollPhase::Drag, 3, 9);
  EXPECT_EQ(Count(ev, Kind::SectionEnd), 0);
  ev = t.Sample(5, 9, ScrollPhase::Drag, 4, 10);
  EXPECT_EQ(Count(ev, Kind::SectionEnd), 1);
  // Nothing half on screen (one tall block scrolled past): the shown range stands in.
  ev = t.Sample(-1, -1, ScrollPhase::Drag, 10, 10);
  ASSERT_TRUE(Find(ev, Kind::VisibleRange));
  EXPECT_EQ(Find(ev, Kind::VisibleRange)->first, 10);
}

// ---- Bridge helpers -------------------------------------------------------

TEST(ReaderJson, SummaryAndBlocks) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const std::string summary = SnapshotSummaryJson(*snap);
  EXPECT_NE(summary.find("\"id\":\"" + id + "\""), std::string::npos);
  EXPECT_NE(summary.find("\"structureVersion\":1"), std::string::npos);
  EXPECT_NE(summary.find("\"title\":\"Chapter One\""), std::string::npos);
  EXPECT_NE(summary.find("\"firstBlockId\":\"s0.b0\""), std::string::npos);
  EXPECT_NE(summary.find("\"lastBlockId\":\"s0.b7\""), std::string::npos);
  const int roses = snap->BlockIndex("s0.b7");
  const std::string blocks = BlocksJson(*snap, roses, 1, true);
  EXPECT_NE(blocks.find("\"text\":\"Roses are red,\\nviolets are blue.\""), std::string::npos);
  const std::string img = BlocksJson(*snap, snap->BlockIndex("s0.b4"), 1, true);
  EXPECT_NE(img.find("\"imageHref\":\"OEBPS/images/map.png\""), std::string::npos);
  EXPECT_EQ(img.find("\"text\""), std::string::npos);
  EXPECT_EQ(BlocksJson(*snap, 9999, 5, false), "[]");
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderFileHash, MatchesFixtureSha256) {
  sherpa_onnx::fileio::SeekableSource src;
  src.path = RepoPath("test/fixtures/document/structure.epub");
  std::string hex;
  std::string err;
  ASSERT_TRUE(Sha256HexOfSource(src, &hex, &err)) << err;
  EXPECT_EQ(hex.size(), 64u);
  const char* expected = std::getenv("STRUCTURE_EPUB_SHA256");
  if (expected) EXPECT_EQ(hex, expected);
  src.path = "/nonexistent/file.epub";
  EXPECT_FALSE(Sha256HexOfSource(src, &hex, &err));
}

// ---- Text ranges, highlights, follow ------------------------------------

TEST(ReaderDocument, MapTextRangeSnapsOverGapsAndSkipsImages) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const ReaderBlock& b0 = snap->blocks[snap->BlockIndex("s0.b0")];  // "Chapter One"
  const ReaderBlock& b1 = snap->blocks[snap->BlockIndex("s0.b1")];
  int a, ao, z, zo;
  // Inside one block.
  ASSERT_TRUE(snap->MapTextRange(b0.utf16Start + 2, b0.utf16Start + 7, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[a].id, "s0.b0");
  EXPECT_EQ(ao, 2);
  EXPECT_EQ(z, a);
  EXPECT_EQ(zo, 7);
  // Start in the "\n\n" gap snaps forward; end in the gap snaps back.
  ASSERT_TRUE(snap->MapTextRange(b0.utf16End + 1, b1.utf16Start + 3, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[a].id, "s0.b1");
  EXPECT_EQ(ao, 0);
  ASSERT_TRUE(snap->MapTextRange(b0.utf16Start, b0.utf16End + 1, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[z].id, "s0.b0");
  EXPECT_EQ(zo, b0.utf16End - b0.utf16Start);
  // Range only inside a gap: nothing.
  EXPECT_FALSE(snap->MapTextRange(b0.utf16End, b0.utf16End + 2, &a, &ao, &z, &zo));
  // Across the image s0.b4: ends land on text blocks.
  const ReaderBlock& b3 = snap->blocks[snap->BlockIndex("s0.b3")];
  const ReaderBlock& b6 = snap->blocks[snap->BlockIndex("s0.b6")];
  ASSERT_TRUE(snap->MapTextRange(b3.utf16Start, b6.utf16Start + 1, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[a].id, "s0.b3");
  EXPECT_EQ(snap->blocks[z].id, "s0.b6");
  EXPECT_EQ(zo, 1);

  const std::string json =
      TextRangesJson(*snap, {b0.utf16Start, b0.utf16End}, {b0.utf16Start + 4, b0.utf16End + 2});
  EXPECT_EQ(json,
            "[{\"from\":{\"sectionId\":\"s0\",\"blockId\":\"s0.b0\",\"offset\":0},"
            "\"to\":{\"sectionId\":\"s0\",\"blockId\":\"s0.b0\",\"offset\":4}},null]");
  const std::string blocks = BlocksJson(*snap, 0, 1, false);
  EXPECT_NE(blocks.find("\"textRange\":{\"start\":" + std::to_string(b0.utf16Start) + ",\"end\":" +
                        std::to_string(b0.utf16End) + "}"),
            std::string::npos);
  EXPECT_EQ(BlocksJson(*snap, snap->BlockIndex("s0.b4"), 1, false).find("textRange"), std::string::npos);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderDocument, MapTextRangeIgnoresAppSections) {
  const std::string id = CreateDoc("structure.epub");
  auto& reg = ReaderRegistry::Instance();
  ReaderAppSectionInput in;
  in.after = "s0";
  in.id = "app:x";
  in.blocks = {{"p", ReaderBlockType::Paragraph, "App text", 0}};
  ReaderError err;
  ASSERT_TRUE(reg.InsertSection(id, in, &err));
  auto snap = reg.Snapshot(id);
  const ReaderBlock& last0 = snap->blocks[snap->BlockIndex("s0.b7")];
  const ReaderBlock& s2b0 = snap->blocks[snap->BlockIndex("s2.b0")];
  int a, ao, z, zo;
  ASSERT_TRUE(snap->MapTextRange(last0.utf16Start, s2b0.utf16End, &a, &ao, &z, &zo));
  EXPECT_EQ(snap->blocks[a].id, "s0.b7");
  EXPECT_EQ(snap->blocks[z].id, "s2.b0");
  EXPECT_EQ(snap->BlockLength(snap->BlockIndex("app:x.p")), 8);
  reg.Release(id);
}

TEST(ReaderHighlights, ResolvesAcrossBlocksOverlapsAndFollow) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  std::vector<HighlightInput> in(4);
  in[0].id = "sentence";  // s0.b3 offset 2 .. s0.b6 offset 3, crossing the image and separator
  in[0].fromBlockId = "s0.b3";
  in[0].fromOffset = 2;
  in[0].toBlockId = "s0.b6";
  in[0].toOffset = 3;
  in[1].id = "word";
  in[1].fromBlockId = "s0.b3";
  in[1].fromOffset = 4;
  in[1].toBlockId = "s0.b3";
  in[1].toOffset = 8;
  in[1].style = HighlightStyle::Underline;
  in[1].color = 0xFF112233;
  in[1].hasColor = true;
  in[1].follow = true;
  in[2].id = "whole";  // offsets omitted: whole block
  in[2].fromBlockId = "s0.b0";
  in[2].toBlockId = "s0.b0";
  in[2].toOffset = 999;  // clamped
  in[3].id = "bad";
  in[3].fromBlockId = "s9.b9";
  in[3].toBlockId = "s0.b0";
  auto r = ResolveHighlights(*snap, in);
  ASSERT_EQ(r.invalidIds.size(), 1u);
  EXPECT_EQ(r.invalidIds[0], "bad");
  const int b3 = snap->BlockIndex("s0.b3");
  ASSERT_EQ(r.byBlock[b3].size(), 2u);
  EXPECT_EQ(r.byBlock[b3][0].start, 2);
  EXPECT_EQ(r.byBlock[b3][0].end, snap->BlockLength(b3));
  EXPECT_EQ(r.byBlock[b3][1].style, HighlightStyle::Underline);
  EXPECT_EQ(r.byBlock[b3][1].color, 0xFF112233u);
  EXPECT_EQ(r.byBlock.count(snap->BlockIndex("s0.b4")), 0u);  // image
  EXPECT_EQ(r.byBlock.count(snap->BlockIndex("s0.b5")), 0u);  // separator
  ASSERT_EQ(r.byBlock[snap->BlockIndex("s0.b6")].size(), 1u);
  EXPECT_EQ(r.byBlock[snap->BlockIndex("s0.b6")][0].end, 3);
  EXPECT_EQ(r.byBlock[0][0].start, 0);
  EXPECT_EQ(r.byBlock[0][0].end, 11);  // "Chapter One"
  EXPECT_EQ(r.followBlock, b3);
  EXPECT_EQ(r.followOffset, 4);
  EXPECT_EQ(r.followEndOffset, 8);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderHighlights, OffsetsNeverSplitSurrogatePairs) {
  const std::string id = CreateDoc("structure.epub");
  auto& reg = ReaderRegistry::Instance();
  ReaderAppSectionInput in;
  in.after = "s0";
  in.id = "app:emoji";
  in.blocks = {{"p", ReaderBlockType::Paragraph, "a\xF0\x9F\x98\x80" "b", 0}};  // a 😀 b = 4 units
  ReaderError err;
  ASSERT_TRUE(reg.InsertSection(id, in, &err));
  auto snap = reg.Snapshot(id);
  HighlightInput h;
  h.id = "h";
  h.fromBlockId = h.toBlockId = "app:emoji.p";
  h.fromOffset = 2;  // inside the pair → moves back to 1
  h.toOffset = 4;
  auto r = ResolveHighlights(*snap, {h});
  const int p = snap->BlockIndex("app:emoji.p");
  ASSERT_EQ(r.byBlock[p].size(), 1u);
  EXPECT_EQ(r.byBlock[p][0].start, 1);
  EXPECT_EQ(r.byBlock[p][0].end, 4);
  reg.Release(id);
}

TEST(ReaderTracker, FollowReadsContinuouslyAndOnlyFarMovesJump) {
  ReaderTracker t({9, 19, 29}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  auto ev = t.Sample(3, 9, ScrollPhase::Follow);
  EXPECT_EQ(Count(ev, Kind::Jump), 0);
  ASSERT_TRUE(Find(ev, Kind::SectionEnd));
  EXPECT_EQ(t.Frontier(), 9);
  ev = t.Sample(8, 13, ScrollPhase::Follow);
  EXPECT_EQ(Count(ev, Kind::Jump), 0);
  EXPECT_EQ(t.Frontier(), 13);
  // Read-aloud restarted far ahead: a jump, frontier stays.
  ev = t.Sample(60, 64, ScrollPhase::Follow);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "follow");
  EXPECT_EQ(t.Frontier(), 13);
}

// ---- Block text references, formats and page blocks ---------------------

namespace {

/** A hand-built structure: section 0 = page block + two text blocks. */
std::shared_ptr<TxtOfflineEntry> HandBuiltEntry(const std::string& format, int version) {
  // UTF-16: "Ä 😀 x" = 6 units (😀 is a surrogate pair), "\n\n", "Größe" = 5.
  const std::string text = "\xC3\x84 \xF0\x9F\x98\x80 x\n\nGr\xC3\xB6\xC3\x9F" "e";
  auto st = std::make_shared<TxtStructure>();
  st->format = format;
  st->version = version;
  TxtStructSection sec;
  sec.sectionIndex = 0;
  sec.kind = "page";
  sec.firstBlock = 0;
  sec.blockCount = 3;
  TxtStructBlock page;
  page.type = TxtBlockType::Page;
  page.blockIndex = 0;
  page.imageHref = "page:1";
  page.frameIndex = 4;
  TxtStructBlock a;
  a.type = TxtBlockType::Paragraph;
  a.blockIndex = 1;
  a.utf16Start = 0;
  a.utf16End = 6;
  a.flags = kTxtBlockFurniture;
  a.hasRect = true;
  a.rect[0] = 0.1f;
  a.rect[1] = 0.05f;
  a.rect[2] = 0.8f;
  a.rect[3] = 0.02f;
  TxtStructBlock b;
  b.type = TxtBlockType::Heading;
  b.headingLevel = 2;
  b.blockIndex = 2;
  b.utf16Start = 8;
  b.utf16End = 13;
  st->blocks = {page, a, b};
  st->sections = {sec};
  auto entry = std::make_shared<TxtOfflineEntry>();
  entry->bufferId = "txt_off_hand";
  EXPECT_TRUE(entry->tryPopulate(text, {}, {}, {}, "", "", ""));
  EXPECT_TRUE(entry->trySetStructure(st));
  return entry;
}

}  // namespace

TEST(ReaderBlockText, ByteRangesFollowUtf16Offsets) {
  ReaderError err;
  const std::string id = ReaderRegistry::Instance().Create(HandBuiltEntry("pdf", 1),
                                                           "img_off_pages", {}, "k", &err);
  ASSERT_FALSE(id.empty()) << err.code << " " << err.message;
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_TRUE(snap);
  EXPECT_EQ(snap->format, "pdf");
  EXPECT_EQ(snap->structureVersion, 1);
  ASSERT_EQ(snap->blocks.size(), 3u);

  const ReaderBlock& page = snap->blocks[0];
  EXPECT_EQ(page.type, ReaderBlockType::Page);
  EXPECT_EQ(page.id, "s0.b0");
  EXPECT_EQ(page.imageFrame, 4) << "direct frame index wins over href matching";
  EXPECT_EQ(page.textHash, ImageHashV1("page:1"));
  EXPECT_EQ(snap->BlockText(0), "");

  EXPECT_EQ(snap->BlockText(1), "\xC3\x84 \xF0\x9F\x98\x80 x");
  EXPECT_EQ(snap->BlockLength(1), 6);
  EXPECT_EQ(snap->blocks[1].flags, kBlockFurniture);
  EXPECT_TRUE(snap->blocks[1].hasRect);
  EXPECT_FLOAT_EQ(snap->blocks[1].rect[2], 0.8f);
  EXPECT_EQ(snap->BlockText(2), "Gr\xC3\xB6\xC3\x9F" "e");
  EXPECT_EQ(snap->BlockLength(2), 5);
  EXPECT_EQ(snap->blocks[2].textHash, TextHashV1("Gr\xC3\xB6\xC3\x9F" "e"));
  // Only text blocks are indexed for offset mapping.
  ASSERT_EQ(snap->textBlocks.size(), 2u);

  const std::string json = SnapshotSummaryJson(*snap);
  EXPECT_NE(json.find("\"format\":\"pdf\""), std::string::npos) << json;
  const std::string blocks = BlocksJson(*snap, 0, 3, true);
  EXPECT_NE(blocks.find("\"type\":\"page\""), std::string::npos) << blocks;
  EXPECT_NE(blocks.find("\"furniture\":true"), std::string::npos) << blocks;
  EXPECT_NE(blocks.find("\"rect\":[0.1000,0.0500,0.8000,0.0200]"), std::string::npos) << blocks;
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderBlockText, PerFormatVersionGate) {
  ReaderError err;
  EXPECT_TRUE(ReaderRegistry::Instance()
                  .Create(HandBuiltEntry("pdf", 2), "", {}, "k", &err)
                  .empty());
  EXPECT_EQ(err.code, kErrReaderUnsupportedStructure);
  err = {};
  EXPECT_TRUE(ReaderRegistry::Instance()
                  .Create(HandBuiltEntry("djvu", 1), "", {}, "k", &err)
                  .empty());
  EXPECT_EQ(err.code, kErrReaderUnsupportedStructure);
  EXPECT_EQ(SupportedStructureVersion("epub"), kStructureVersion);
  EXPECT_EQ(SupportedStructureVersion("fb2"), 1);
  EXPECT_EQ(SupportedStructureVersion(""), 0);
}

// ---- Contents ------------------------------------------------------------

TEST(ReaderToc, EpubNavAtSectionGranularity) {
  const std::string id = CreateDoc("structure.epub");
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const std::string json = TocJson(*snap);
  // First entry per file; the second ch1 entry and the landmarks nav are ignored.
  EXPECT_NE(json.find("{\"title\":\"Chapter One\",\"level\":1,\"sectionId\":\"s0\",\"blockId\":\"s0.b0\"}"),
            std::string::npos)
      << json;
  EXPECT_EQ(json.find("Ignored second entry"), std::string::npos) << json;
  EXPECT_EQ(json.find("Landmark"), std::string::npos) << json;
  EXPECT_NE(json.find("\"title\":\"The Plate\""), std::string::npos) << json;
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderToc, Fb2NestedTitlesPointAtTheirHeadings) {
  const std::string id = CreateDoc("structure.fb2", {"map", "plate"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  ASSERT_EQ(snap->toc.size(), 2u) << TocJson(*snap);
  EXPECT_EQ(snap->toc[0].title, "Chapter One The Bay");
  EXPECT_EQ(snap->toc[0].level, 1);
  EXPECT_EQ(snap->toc[0].blockId, "s1.b0");
  EXPECT_EQ(snap->toc[1].title, "The Boat");
  EXPECT_EQ(snap->toc[1].level, 2);
  EXPECT_EQ(snap->toc[1].blockId, "s1.b6");
  // An app section shifts flat indices; entries keep their block IDs.
  ReaderAppSectionInput in;
  in.after = "s0";
  in.id = "app:guide";
  in.blocks = {{"p", ReaderBlockType::Paragraph, "Guide", 0}};
  ReaderError err;
  ASSERT_TRUE(ReaderRegistry::Instance().InsertSection(id, in, &err)) << err.message;
  snap = ReaderRegistry::Instance().Snapshot(id);
  EXPECT_NE(TocJson(*snap).find("\"blockId\":\"s1.b6\""), std::string::npos);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderToc, FallsBackToSectionTitles) {
  const std::string id = CreateDoc("structure.mobi", {"recindex:2", "recindex:1"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  EXPECT_TRUE(snap->toc.empty());
  EXPECT_EQ(TocJson(*snap),
            "[{\"title\":\"The Lighthouse\",\"level\":1,\"sectionId\":\"s0\",\"blockId\":\"s0.b0\"},"
            "{\"title\":\"The Storm\",\"level\":1,\"sectionId\":\"s1\",\"blockId\":\"s1.b0\"}]");
  ReaderRegistry::Instance().Release(id);
}

// ---- Sentences ------------------------------------------------------------

namespace {

/** The sentences of `text` as strings (ASCII test input: UTF-16 = bytes). */
std::vector<std::string> Sentences(const std::string& text) {
  std::vector<std::string> out;
  for (const auto& r : SplitSentences(text)) out.push_back(text.substr(r.start, r.end - r.start));
  return out;
}

/** Like Sentences, for UTF-8 input (maps the UTF-16 ranges back to bytes). */
std::vector<std::string> SentencesUtf8(const std::string& text) {
  std::vector<size_t> byteAt;  // UTF-16 offset -> byte offset
  for (size_t i = 0; i < text.size();) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    const size_t adv = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
    byteAt.push_back(i);
    if (adv == 4) byteAt.push_back(i);
    i += adv;
  }
  byteAt.push_back(text.size());
  std::vector<std::string> out;
  for (const auto& r : SplitSentences(text)) {
    out.push_back(text.substr(byteAt[r.start], byteAt[r.end] - byteAt[r.start]));
  }
  return out;
}

/** A document with one app section holding `texts` as paragraphs `app:t.p0`, `app:t.p1`, … */
std::string DocWithParagraphs(const std::vector<std::string>& texts) {
  const std::string id = CreateDoc("structure.epub");
  ReaderAppSectionInput in;
  in.after = "s0";
  in.id = "app:t";
  for (size_t i = 0; i < texts.size(); ++i) {
    in.blocks.push_back({"p" + std::to_string(i), ReaderBlockType::Paragraph, texts[i], 0});
  }
  ReaderError err;
  EXPECT_TRUE(ReaderRegistry::Instance().InsertSection(id, in, &err)) << err.message;
  return id;
}

}  // namespace

TEST(ReaderSentences, SplitsOnTheSegmentationBoundaries) {
  using V = std::vector<std::string>;
  EXPECT_EQ(Sentences("One. Two! Three? Four"), (V{"One.", "Two!", "Three?", "Four"}));
  EXPECT_EQ(Sentences("Note: this; that."), (V{"Note:", "this;", "that."}));
  EXPECT_EQ(Sentences("  Leading and trailing.   "), (V{"Leading and trailing."}));
  EXPECT_EQ(Sentences("Line one\nLine two"), (V{"Line one", "Line two"}));
  EXPECT_EQ(Sentences(""), V{});
  EXPECT_EQ(Sentences(" \n\t "), V{});
}

TEST(ReaderSentences, KeepsRunsQuotesAndInnerMarks) {
  using V = std::vector<std::string>;
  EXPECT_EQ(Sentences("Really?! Yes... Fine."), (V{"Really?!", "Yes...", "Fine."}));
  EXPECT_EQ(Sentences("\"Go.\" He went. (Aside.) Done"), (V{"\"Go.\"", "He went.", "(Aside.)", "Done"}));
  // ASCII marks need whitespace (or the end) after them.
  EXPECT_EQ(Sentences("Pi is 3.14 and it is 10:30 now. Next"), (V{"Pi is 3.14 and it is 10:30 now.", "Next"}));
  // Curly closing quote (3 UTF-8 bytes, 1 UTF-16 unit).
  const std::string t = "\xE2\x80\x9CHi.\xE2\x80\x9D Then.";  // “Hi.” Then.
  const auto r = SplitSentences(t);
  ASSERT_EQ(r.size(), 2u);
  EXPECT_EQ(r[0].start, 0);
  EXPECT_EQ(r[0].end, 5);  // “Hi.”
  EXPECT_EQ(r[1].start, 6);
  EXPECT_EQ(r[1].end, 11);
}

TEST(ReaderSentences, CjkMarksEndWithoutSpaceAndOffsetsAreUtf16) {
  // 你好。再见！ = 6 code points; the stops end sentences without a space.
  const auto r = SplitSentences("\xE4\xBD\xA0\xE5\xA5\xBD\xE3\x80\x82\xE5\x86\x8D\xE8\xA7\x81\xEF\xBC\x81");
  ASSERT_EQ(r.size(), 2u);
  EXPECT_EQ(r[0].start, 0);
  EXPECT_EQ(r[0].end, 3);
  EXPECT_EQ(r[1].start, 3);
  EXPECT_EQ(r[1].end, 6);
  // An emoji is two UTF-16 units.
  const auto e = SplitSentences("a\xF0\x9F\x98\x80. b");
  ASSERT_EQ(e.size(), 2u);
  EXPECT_EQ(e[0].end, 4);
  EXPECT_EQ(e[1].start, 5);
}

TEST(ReaderSentences, EnglishAbbreviationsAndInitials) {
  using V = std::vector<std::string>;
  EXPECT_EQ(Sentences("Mr. and Mrs. Smith met Dr. Jones. They talked."),
            (V{"Mr. and Mrs. Smith met Dr. Jones.", "They talked."}));
  EXPECT_EQ(Sentences("Prof. Ms. Capt. Col. Gen. Lt. Rev. Hon. Messrs. St. Mt. Everest. Next"),
            (V{"Prof. Ms. Capt. Col. Gen. Lt. Rev. Hon. Messrs. St. Mt. Everest.", "Next"}));
  EXPECT_EQ(Sentences("Fruit, e.g. apples, i.e. red ones, cf. Smith vs. Jones. Done"),
            (V{"Fruit, e.g. apples, i.e. red ones, cf. Smith vs. Jones.", "Done"}));
  EXPECT_EQ(Sentences("See Fig. 3 and No. 5 in Vol. 2. Done"), (V{"See Fig. 3 and No. 5 in Vol. 2.", "Done"}));
  EXPECT_EQ(Sentences("By J. R. R. Tolkien and A. Smith. Then"),
            (V{"By J. R. R. Tolkien and A. Smith.", "Then"}));
  // Real sentence ends after abbreviation-like words.
  EXPECT_EQ(Sentences("He said No. Then he left."), (V{"He said No.", "Then he left."}));
  EXPECT_EQ(Sentences("Pears, plums etc. The end."), (V{"Pears, plums etc.", "The end."}));
  EXPECT_EQ(Sentences("Pears etc. and more."), (V{"Pears etc. and more."}));
  EXPECT_EQ(Sentences("So did I. Then we left."), (V{"So did I.", "Then we left."}));
  EXPECT_EQ(Sentences("King Jr. was there. Smith Jr. He left."),
            (V{"King Jr. was there.", "Smith Jr.", "He left."}));
  EXPECT_EQ(Sentences("Call the Dr."), (V{"Call the Dr."}));            // end of text
  EXPECT_EQ(Sentences("Ask Mr.\nNext line"), (V{"Ask Mr.", "Next line"}));  // line break
  EXPECT_EQ(Sentences("Ask Mr.\" Then"), (V{"Ask Mr.\"", "Then"}));     // closing quote
  EXPECT_EQ(Sentences("Wait... Mr. X"), (V{"Wait...", "Mr. X"}));       // run of marks
  EXPECT_EQ(Sentences("A tumor. Then"), (V{"A tumor.", "Then"}));       // `Mr` only as a word
  EXPECT_EQ(Sentences("mr. smith"), (V{"mr.", "smith"}));               // titles match exactly
}

TEST(ReaderSentences, GermanAbbreviationsAndOrdinals) {
  using V = std::vector<std::string>;
  EXPECT_EQ(SentencesUtf8("Obst, z.B. \xC3\x84pfel, d.h. rote, u.a. Birnen usw. sind gut. Ja"),
            (V{"Obst, z.B. \xC3\x84pfel, d.h. rote, u.a.", "Birnen usw. sind gut.", "Ja"}));
  EXPECT_EQ(SentencesUtf8("Hr. M\xC3\xBCller und Fr. Meier, Hrn. Kurz, Dr. Prof. Lang. Ende"),
            (V{"Hr. M\xC3\xBCller und Fr. Meier, Hrn. Kurz, Dr. Prof. Lang.", "Ende"}));
  EXPECT_EQ(SentencesUtf8("Vgl. Kapitel 3, bzw. Teil 2, ca. 5 Seiten, ggf. mehr, evtl. Text, inkl. Bild, "
                      "bzgl. Stil. Fertig"),
            (V{"Vgl. Kapitel 3, bzw. Teil 2, ca. 5 Seiten, ggf. mehr, evtl. Text, inkl. Bild, bzgl. Stil.",
               "Fertig"}));
  EXPECT_EQ(SentencesUtf8("Siehe S. 12, Bd. 2, Nr. 7 in der Hauptstr. 5. Gut"),
            (V{"Siehe S. 12, Bd. 2, Nr. 7 in der Hauptstr.", "5.", "Gut"}));
  EXPECT_EQ(SentencesUtf8("Im 19. Jh. war es so. Im 19. Jahrhundert auch."),
            (V{"Im 19. Jh. war es so.", "Im 19. Jahrhundert auch."}));
  EXPECT_EQ(SentencesUtf8("Am 1. Januar und am 3. M\xC3\xA4rz kam er zum 2. und 3. Mal. Dann"),
            (V{"Am 1. Januar und am 3. M\xC3\xA4rz kam er zum 2. und 3.", "Mal.", "Dann"}));
  // Real sentence ends after numbers and abbreviation-like words.
  EXPECT_EQ(SentencesUtf8("Es kostet 5. Danach ging er."), (V{"Es kostet 5.", "Danach ging er."}));
  EXPECT_EQ(SentencesUtf8("Im Jahr 1999. Dann"), (V{"Im Jahr 1999.", "Dann"}));
  EXPECT_EQ(SentencesUtf8("Und so weiter usw. Dann kam er."), (V{"Und so weiter usw.", "Dann kam er."}));
  EXPECT_EQ(SentencesUtf8("Er wohnt in der Str. Am Abend"), (V{"Er wohnt in der Str.", "Am Abend"}));
  EXPECT_EQ(SentencesUtf8("Das war z.B."), (V{"Das war z.B."}));
}

TEST(ReaderSentences, SnapKeepsAbbreviationsInTheSentence) {
  //                                   0         1         2
  //                                   012345678901234567890123456
  const std::string id = DocWithParagraphs({"Mr. Smith came. He left."});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const auto r = EnclosingSentences(*snap, snap->BlockIndex("app:t.p0"), 5, 6);
  EXPECT_EQ(r.start, 0);
  EXPECT_EQ(r.end, 15);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderSentences, SnapRangeWidensToSentencesOrTheBlock) {
  //                                   0         1         2
  //                                   0123456789012345678901234567
  const std::string id = DocWithParagraphs({"First one. Second one. Third."});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const int p = snap->BlockIndex("app:t.p0");
  auto snapTo = [&](int s, int e, SelectionSnap m) {
    const auto r = SnapRange(*snap, p, s, e, m);
    return std::make_pair(r.start, r.end);
  };
  using P = std::pair<int, int>;
  EXPECT_EQ(snapTo(2, 4, SelectionSnap::Sentence), (P{0, 10}));     // inside "First one."
  EXPECT_EQ(snapTo(8, 13, SelectionSnap::Sentence), (P{0, 22}));    // across two sentences
  EXPECT_EQ(snapTo(10, 11, SelectionSnap::Sentence), (P{11, 22}));  // the gap: next sentence
  EXPECT_EQ(snapTo(5, 11, SelectionSnap::Sentence), (P{0, 10}));    // ends in the gap
  EXPECT_EQ(snapTo(14, 14, SelectionSnap::Sentence), (P{11, 22}));  // a caret
  EXPECT_EQ(snapTo(3, 999, SelectionSnap::Sentence), (P{0, 29}));   // clamped
  EXPECT_EQ(snapTo(2, 4, SelectionSnap::Block), (P{0, 29}));
  EXPECT_EQ(snapTo(2, 4, SelectionSnap::None), (P{2, 4}));
  EXPECT_EQ(SelectionSnapFromName("sentence"), SelectionSnap::Sentence);
  EXPECT_EQ(SelectionSnapFromName("block"), SelectionSnap::Block);
  EXPECT_EQ(SelectionSnapFromName("other"), SelectionSnap::None);
  const auto enc = EnclosingSentences(*snap, p, 12, 13);
  EXPECT_EQ(enc.start, 11);
  EXPECT_EQ(enc.end, 22);
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderSentences, JsonPerBlockAndUnknownIds) {
  const std::string id = DocWithParagraphs({"A b. C d.", "Single"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  std::string json;
  std::string unknown;
  ASSERT_TRUE(SentencesJson(*snap, {"app:t.p0", "app:t.p1", "s0.b4"}, &json, &unknown));
  // s0.b4 is an image: no sentences.
  EXPECT_EQ(json,
            "[{\"blockId\":\"app:t.p0\",\"index\":0,\"start\":0,\"end\":4},"
            "{\"blockId\":\"app:t.p0\",\"index\":1,\"start\":5,\"end\":9},"
            "{\"blockId\":\"app:t.p1\",\"index\":0,\"start\":0,\"end\":6}]");
  EXPECT_FALSE(SentencesJson(*snap, {"app:t.p0", "s9.b9"}, &json, &unknown));
  EXPECT_EQ(unknown, "s9.b9");
  EXPECT_TRUE(BlockSentences(*snap, snap->BlockIndex("s0.b5")).empty());  // separator
  ReaderRegistry::Instance().Release(id);
}

// ---- Margin markers ---------------------------------------------------------

TEST(ReaderMarkers, AnchorsAtTheBlockOrTheRangeEnd) {
  const std::string id = DocWithParagraphs({"First one. Second one.", "a\xF0\x9F\x98\x80" "b"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  const int p0 = snap->BlockIndex("app:t.p0");
  const int p1 = snap->BlockIndex("app:t.p1");
  std::vector<MarkerInput> in(7);
  in[0] = {"block", "app:t.p0", -1, -1};
  in[1] = {"range", "app:t.p0", 11, 22};
  in[2] = {"clamped", "app:t.p0", 5, 999};
  in[3] = {"startOnly", "app:t.p0", 3, -1};
  in[4] = {"surrogate", "app:t.p1", 0, 3};  // last char = low surrogate (2) → its pair start (1)
  in[5] = {"image", "s0.b4", 0, 4};          // image: block anchor
  in[6] = {"bad", "s9.b9", -1, -1};
  const auto r = ResolveMarkers(*snap, in);
  ASSERT_EQ(r.invalidIds.size(), 1u);
  EXPECT_EQ(r.invalidIds[0], "bad");
  const auto& a = r.byBlock.at(p0);
  ASSERT_EQ(a.size(), 4u);
  EXPECT_EQ(a[0].input, 0);
  EXPECT_EQ(a[0].offset, -1);
  EXPECT_EQ(a[1].offset, 21);
  EXPECT_EQ(a[2].offset, 21);  // clamped to the last character
  EXPECT_EQ(a[3].offset, 3);
  EXPECT_EQ(r.byBlock.at(p1).at(0).offset, 1);
  EXPECT_EQ(r.byBlock.at(snap->BlockIndex("s0.b4")).at(0).offset, -1);
  // Reversed ranges are invalid.
  const auto bad = ResolveMarkers(*snap, {{"rev", "app:t.p0", 9, 3}});
  ASSERT_EQ(bad.invalidIds.size(), 1u);
  EXPECT_TRUE(bad.byBlock.empty());
  ReaderRegistry::Instance().Release(id);
}

TEST(ReaderMarkers, PageRectFallsBackToTheBlockRect) {
  const std::string id = DocWithParagraphs({"Text"});
  auto snap = ReaderRegistry::Instance().Snapshot(id);
  // No line boxes and no rect: the page's top edge.
  const auto r = MarkerPageRect(*snap, snap->BlockIndex("app:t.p0"), 2);
  EXPECT_EQ(r.y, 0);
  EXPECT_EQ(r.w, 1);
  ReaderRegistry::Instance().Release(id);
}
