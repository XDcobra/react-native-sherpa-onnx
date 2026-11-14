#include "DocumentExtractor.h"

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
