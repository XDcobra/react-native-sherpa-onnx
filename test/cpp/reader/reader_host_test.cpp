#include "DocumentExtractor.h"

#include "ReaderFileHash.h"
#include "ReaderHighlights.h"
#include "ReaderJson.h"
#include "ReaderRegistry.h"
#include "ReaderTextHash.h"
#include "ReaderTracker.h"

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
  in.id = "app:path-a";
  in.title = "Another way";
  in.blocks = {{"title", ReaderBlockType::Heading, "Another way", 2},
               {"p1", ReaderBlockType::Paragraph, "A new road opens.", 0}};
  ReaderError err;
  ASSERT_TRUE(reg.InsertSection(id, in, &err)) << err.message;
  auto snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 2);
  ASSERT_EQ(snap->sections.size(), 4u);
  EXPECT_EQ(snap->sections[1].id, "app:path-a");
  EXPECT_EQ(snap->sections[1].titleSource, "app");
  const int p1 = snap->BlockIndex("app:path-a.p1");
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

  ASSERT_TRUE(reg.RemoveSection(id, "app:path-a", &err));
  snap = reg.Snapshot(id);
  EXPECT_EQ(snap->revision, 3);
  EXPECT_EQ(snap->sections.size(), 3u);
  EXPECT_LT(snap->BlockIndex("app:path-a.p1"), 0);
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

TEST(ReaderTracker, ScrubbingAndScrollToAreJumps) {
  ReaderTracker t({}, 20);
  t.Sample(0, 4, ScrollPhase::Layout);
  auto ev = t.Sample(50, 54, ScrollPhase::Drag);  // indicator scrub
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "scroll");
  ev = t.Sample(5, 9, ScrollPhase::Programmatic);
  ASSERT_TRUE(Find(ev, Kind::Jump));
  EXPECT_EQ(Find(ev, Kind::Jump)->cause, "scrollTo");
  EXPECT_EQ(Find(ev, Kind::Jump)->distance, 5 - 50);
  // Back at the frontier: reading continues it.
  EXPECT_EQ(t.Frontier(), 9);
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
