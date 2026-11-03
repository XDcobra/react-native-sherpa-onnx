/**
 * Host tests for shared TextRegistry / Txt* (no device required).
 *
 * Always-on: create/release, offline populate, live partial/commit/finalize, UTF-16 length.
 * Opt-in spool: SHERPA_HOST_TEXT_SPOOL=1 ./textbuffer_host_test
 *
 * Build: cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target textbuffer_host_test
 */
#include "TextRegistry.h"
#include "TxtUtf16.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <unistd.h>

namespace fs = std::filesystem;

namespace {

class TextRegistryFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = fs::temp_directory_path() / ("txt_host_" + std::to_string(::getpid()));
    fs::create_directories(cacheDir_);
    txt_configure_cache_dir(cacheDir_.string());
  }

  void TearDown() override {
    txt_release_all_entries();
    std::error_code ec;
    fs::remove_all(cacheDir_, ec);
  }

  fs::path cacheDir_;
};

}  // namespace

TEST_F(TextRegistryFixture, Utf16Length_Basic) {
  EXPECT_EQ(txt_utf16_length("abc"), 3);
  EXPECT_EQ(txt_utf16_length("ä"), 1);  // U+00E4
  // U+1F600 😀 encodes as UTF-8 F0 9F 98 80 → two UTF-16 code units
  EXPECT_EQ(txt_utf16_length("\xF0\x9F\x98\x80"), 2);
}

TEST_F(TextRegistryFixture, CreateEmptyOffline_Populate_Release) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  EXPECT_FALSE(id.empty());
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "hello", {}, {}, {}, "", "", "", &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(id, &text, &err)) << err;
  EXPECT_EQ(text, "hello");
  EXPECT_TRUE(txt_release_buffer(id));
  EXPECT_FALSE(txt_read_offline_text(id, &text, &err));
}

TEST_F(TextRegistryFixture, LivePartialCommitFinalize) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "partial", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "partial", {}, {}, "test", "", &err)) << err;
  EXPECT_EQ(live->snapshotText(), "");
  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  EXPECT_TRUE(txt_release_buffer(id));
}

TEST_F(TextRegistryFixture, LiveCommitStripsWindowAndKeepsRemainder) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "hello world", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "hello", {}, {}, "test", "", &err)) << err;
  EXPECT_EQ(live->snapshotText(), " world");
  EXPECT_EQ(live->segmentCount(), 1);
}

TEST_F(TextRegistryFixture, LiveAppendTextVsWritePartial) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "ab", &err)) << err;
  ASSERT_TRUE(txt_live_append_text(live, "cd", &err)) << err;
  EXPECT_EQ(live->snapshotText(), "abcd");
  ASSERT_TRUE(txt_live_write_partial(live, "xy", &err)) << err;
  EXPECT_EQ(live->snapshotText(), "xy");
}

TEST_F(TextRegistryFixture, LiveCursorDrainOrderAndEmptySecondDrain) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_commit_segment(live, "one", {}, {}, "t", "", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "two", {}, {}, "t", "", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "three", {}, {}, "t", "", &err)) << err;

  int cursor = live->createSegmentCursor();
  auto first = live->drainSegments(cursor, 2);
  ASSERT_EQ(first.size(), 2u);
  EXPECT_EQ(first[0].text, "one");
  EXPECT_EQ(first[1].text, "two");
  auto second = live->drainSegments(cursor, 10);
  ASSERT_EQ(second.size(), 1u);
  EXPECT_EQ(second[0].text, "three");
  auto third = live->drainSegments(cursor, 10);
  EXPECT_TRUE(third.empty());
  live->releaseSegmentCursor(cursor);
}

TEST_F(TextRegistryFixture, LiveGetSegmentsBounds) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_commit_segment(live, "a", {}, {}, "t", "", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "b", {}, {}, "t", "", &err)) << err;
  EXPECT_TRUE(live->getSegments(-1, 1).empty());
  EXPECT_TRUE(live->getSegments(0, 0).empty());
  EXPECT_TRUE(live->getSegments(5, 1).empty());
  auto mid = live->getSegments(1, 10);
  ASSERT_EQ(mid.size(), 1u);
  EXPECT_EQ(mid[0].text, "b");
}

TEST_F(TextRegistryFixture, LiveMaxSegmentsEvictionAdjustsCursor) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 2, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  int cursor = live->createSegmentCursor();
  ASSERT_TRUE(txt_live_commit_segment(live, "a", {}, {}, "t", "", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "b", {}, {}, "t", "", &err)) << err;
  auto before = live->drainSegments(cursor, 1);
  ASSERT_EQ(before.size(), 1u);
  EXPECT_EQ(before[0].text, "a");
  // readPos==1; committing "c" evicts "a" and decrements cursors → readPos==0 over [b,c]
  ASSERT_TRUE(txt_live_commit_segment(live, "c", {}, {}, "t", "", &err)) << err;
  EXPECT_EQ(live->segmentCount(), 2);
  auto window = live->getSegments(0, 10);
  ASSERT_EQ(window.size(), 2u);
  EXPECT_EQ(window[0].text, "b");
  EXPECT_EQ(window[1].text, "c");
  auto after = live->drainSegments(cursor, 10);
  ASSERT_EQ(after.size(), 2u);
  EXPECT_EQ(after[0].text, "b");
  EXPECT_EQ(after[1].text, "c");
  live->releaseSegmentCursor(cursor);
}

TEST_F(TextRegistryFixture, LiveFinalizeRejectsFurtherWrite) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  EXPECT_FALSE(txt_live_write_partial(live, "nope", &err));
  EXPECT_FALSE(txt_live_append_text(live, "nope", &err));
  EXPECT_FALSE(txt_live_commit_segment(live, "nope", {}, {}, "t", "", &err));
}

TEST_F(TextRegistryFixture, LiveCommitTokensTimestampsRoundTrip) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  std::vector<std::string> tokens = {"hel", "lo"};
  std::vector<float> timestamps = {0.1f, 0.2f};
  ASSERT_TRUE(txt_live_commit_segment(live, "hello", tokens, timestamps, "stt", "", &err)) << err;

  auto segs = live->getSegments(0, 10);
  ASSERT_EQ(segs.size(), 1u);
  ASSERT_EQ(segs[0].tokens.size(), 2u);
  EXPECT_EQ(segs[0].tokens[0], "hel");
  EXPECT_EQ(segs[0].tokens[1], "lo");
  ASSERT_EQ(segs[0].timestamps.size(), 2u);
  EXPECT_FLOAT_EQ(segs[0].timestamps[0], 0.1f);
  EXPECT_FLOAT_EQ(segs[0].timestamps[1], 0.2f);

  int cursor = live->createSegmentCursor();
  auto drained = live->drainSegments(cursor, 1);
  ASSERT_EQ(drained.size(), 1u);
  ASSERT_EQ(drained[0].tokens.size(), 2u);
  EXPECT_EQ(drained[0].tokens[1], "lo");
  live->releaseSegmentCursor(cursor);
}

TEST_F(TextRegistryFixture, InvalidId_FailsCleanly) {
  std::string text;
  std::string err;
  EXPECT_FALSE(txt_read_offline_text("txt_off_missing", &text, &err));
}

TEST_F(TextRegistryFixture, OptInSpool_SkippedWithoutEnv) {
  const char *flag = std::getenv("SHERPA_HOST_TEXT_SPOOL");
  if (flag == nullptr || std::string(flag) != "1") {
    GTEST_SKIP() << "Set SHERPA_HOST_TEXT_SPOOL=1 for TXT2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool.bin").string();
  ASSERT_TRUE(txt_create_live(65536, 100, false, 0, "on", spool, true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "spooled text", &err)) << err;
  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  std::string offlineId;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(offlineId, &text, &err)) << err;
  EXPECT_FALSE(text.empty());
}
