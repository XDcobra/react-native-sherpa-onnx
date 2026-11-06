/**
 * Host tests for shared TextRegistry / Txt* (no device required).
 *
 * Always-on: create/release, offline populate, live partial/commit/finalize, UTF-16 length,
 *            and behavior coverage for measured perf keeps (parity / invariants — not wall time).
 * Opt-in spool: SHERPA_HOST_TEXT_SPOOL=1 ./textbuffer_host_test
 *
 * Perf keeps covered (see textbuffer-perf-plan.md / ship-overview):
 *   B — utf16 slice, notify-only partial, spool lossless, offline text view
 *   C1 delta APPEND, C2 checkpoint rotate, C3 deferred fflush, C4 unlock-before spool,
 *   C5 short registry lock, C6 unlock-before notify (hooks/emit), C8 utf16 len cache,
 *   C12 spool-off commit, D-A2 utf16 units, D-I3 Jetsam (Apple only).
 *   D-A4 Batched emit is Android Kotlin — device-only; host covers emit contract (B).
 *
 * Build: cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target textbuffer_host_test
 */
#include "TextRegistry.h"
#include "TxtSpatialSpanJson.h"
#include "TxtUtf16.h"
#include "TxtUtf16Codec.h"

#if defined(__APPLE__)
#include "TxtJetsamCaps.h"
#endif

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <regex>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

namespace {

std::mutex g_seg_hook_mu;
std::atomic<int> g_seg_text_write_n{0};
std::atomic<int> g_seg_finalized_n{0};
std::atomic<int> g_seg_released_n{0};
std::string g_seg_last_text_id;

void ResetSegHooks() {
  std::lock_guard<std::mutex> lock(g_seg_hook_mu);
  g_seg_text_write_n = 0;
  g_seg_finalized_n = 0;
  g_seg_released_n = 0;
  g_seg_last_text_id.clear();
}

bool SpoolOptInEnabled() {
  const char *flag = std::getenv("SHERPA_HOST_TEXT_SPOOL");
  return flag != nullptr && std::string(flag) == "1";
}

/** TXT2 journal record type counts (PartialSet=1, PartialAppend=2, …). */
struct Txt2TypeCounts {
  int partialSet = 0;
  int partialAppend = 0;
  int other = 0;
  int records = 0;
};

bool CountTxt2JournalTypes(const std::string &journalPath, Txt2TypeCounts *out) {
  if (!out) return false;
  *out = Txt2TypeCounts{};
  FILE *f = std::fopen(journalPath.c_str(), "rb");
  if (f == nullptr) return false;
  while (true) {
    unsigned char hdr[16];
    const size_t n = std::fread(hdr, 1, 16, f);
    if (n == 0) break;
    if (n != 16) {
      std::fclose(f);
      return false;
    }
    const uint32_t magic = (uint32_t)hdr[0] | ((uint32_t)hdr[1] << 8) | ((uint32_t)hdr[2] << 16) |
                           ((uint32_t)hdr[3] << 24);
    const uint16_t version = (uint16_t)hdr[4] | ((uint16_t)hdr[5] << 8);
    const uint16_t type = (uint16_t)hdr[6] | ((uint16_t)hdr[7] << 8);
    const uint32_t len = (uint32_t)hdr[8] | ((uint32_t)hdr[9] << 8) | ((uint32_t)hdr[10] << 16) |
                         ((uint32_t)hdr[11] << 24);
    if (magic != 0x32545854u || version != 2) {
      std::fclose(f);
      return false;
    }
    if (len > 0 && std::fseek(f, static_cast<long>(len), SEEK_CUR) != 0) {
      std::fclose(f);
      return false;
    }
    out->records += 1;
    if (type == 1) {
      out->partialSet += 1;
    } else if (type == 2) {
      out->partialAppend += 1;
    } else {
      out->other += 1;
    }
  }
  std::fclose(f);
  return true;
}

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

// Strong overrides of weak TextRegistry stubs — assert C write/finalize/release notify.
void seg_engine_on_text_write(const std::string &liveBufferId) {
  std::lock_guard<std::mutex> lock(g_seg_hook_mu);
  g_seg_text_write_n.fetch_add(1);
  g_seg_last_text_id = liveBufferId;
}

void seg_engine_on_buffer_finalized(const std::string & /*bufferId*/) {
  g_seg_finalized_n.fetch_add(1);
}

void seg_engine_on_buffer_released(const std::string & /*bufferId*/) {
  g_seg_released_n.fetch_add(1);
}

TEST_F(TextRegistryFixture, Utf16Length_Basic) {
  EXPECT_EQ(txt_utf16_length("abc"), 3);
  EXPECT_EQ(txt_utf16_length("ä"), 1);  // U+00E4
  // U+1F600 😀 encodes as UTF-8 F0 9F 98 80 → two UTF-16 code units
  EXPECT_EQ(txt_utf16_length("\xF0\x9F\x98\x80"), 2);
}

TEST_F(TextRegistryFixture, GeneratedIds_MatchTsDashedUuidPattern) {
  static const char *kPattern =
      "^(txt_off|txt_live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
  std::regex re(kPattern);
  for (int i = 0; i < 16; ++i) {
    std::string offId;
    std::string liveId;
    std::string err;
    ASSERT_TRUE(txt_create_empty_offline(&offId, &err)) << err;
    ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &liveId, &err)) << err;
    EXPECT_TRUE(std::regex_match(offId, re)) << offId;
    EXPECT_TRUE(std::regex_match(liveId, re)) << liveId;
    EXPECT_TRUE(txt_release_buffer(offId));
    EXPECT_TRUE(txt_release_buffer(liveId));
  }
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

TEST_F(TextRegistryFixture, Utf16Codec_EmojiRoundTrip) {
  const std::string emoji = "\xF0\x9F\x98\x80";  // 😀
  EXPECT_EQ(txt_utf16_length(emoji), 2);
  auto units = txt_utf16_from_utf8(emoji);
  ASSERT_EQ(units.size(), 2u);
  EXPECT_EQ(units[0], 0xD83D);
  EXPECT_EQ(units[1], 0xDE00);
  EXPECT_EQ(txt_utf8_from_utf16(units.data(), units.size()), emoji);
  EXPECT_EQ((int)units.size(), txt_utf16_length(emoji));
}

TEST_F(TextRegistryFixture, Utf16Codec_EmbeddedNulRoundTrip) {
  std::string withNul = "a";
  withNul.push_back('\0');
  withNul += "b";
  EXPECT_EQ(txt_utf16_length(withNul), 3);
  auto units = txt_utf16_from_utf8(withNul);
  ASSERT_EQ(units.size(), 3u);
  EXPECT_EQ(units[0], 'a');
  EXPECT_EQ(units[1], 0);
  EXPECT_EQ(units[2], 'b');
  EXPECT_EQ(txt_utf8_from_utf16(units.data(), units.size()), withNul);
}

TEST_F(TextRegistryFixture, Utf16Codec_UnpairedSurrogateBecomesReplacement) {
  uint16_t loneHigh = 0xD800;
  std::string utf8 = txt_utf8_from_utf16(&loneHigh, 1);
  EXPECT_EQ(utf8, "\xEF\xBF\xBD");  // U+FFFD
  uint16_t loneLow = 0xDC00;
  EXPECT_EQ(txt_utf8_from_utf16(&loneLow, 1), "\xEF\xBF\xBD");
}

TEST_F(TextRegistryFixture, Utf16Codec_LengthMatchesTxtUtf16Length) {
  const std::string mixed = std::string("hi") + "ä" + "\xF0\x9F\x98\x80";
  auto units = txt_utf16_from_utf8(mixed);
  EXPECT_EQ((int)units.size(), txt_utf16_length(mixed));
  EXPECT_EQ(txt_utf8_from_utf16(units.data(), units.size()), mixed);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — utf16 slice axiom).
TEST_F(TextRegistryFixture, Utf16Slice_AsciiMidAndPastEnd) {
  EXPECT_EQ(txt_utf16_slice("abcdef", 2, 3), "cde");
  EXPECT_EQ(txt_utf16_slice("abcdef", 6, 1), "");
  EXPECT_EQ(txt_utf16_slice("abcdef", 0, 0), "");
  EXPECT_EQ(txt_utf16_slice("", 0, 4), "");
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — utf16 slice axiom).
TEST_F(TextRegistryFixture, Utf16Slice_MultibyteAndEmoji) {
  // "ä" is one UTF-16 unit
  EXPECT_EQ(txt_utf16_slice("xäy", 1, 1), "ä");
  EXPECT_EQ(txt_utf16_slice("xäy", 0, 2), "xä");
  // U+1F600 😀 = two UTF-16 units; maxUnits=1 omits the whole codepoint
  const std::string emoji = "\xF0\x9F\x98\x80";
  EXPECT_EQ(txt_utf16_length(emoji), 2);
  EXPECT_EQ(txt_utf16_slice(emoji, 0, 2), emoji);
  EXPECT_EQ(txt_utf16_slice(emoji, 0, 1), "");
  const std::string mixed = std::string("a") + emoji + "b";
  EXPECT_EQ(txt_utf16_slice(mixed, 1, 2), emoji);
  EXPECT_EQ(txt_utf16_slice(mixed, 3, 1), "b");
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — utf16 slice axiom).
TEST_F(TextRegistryFixture, OfflineUtf16Slice_MatchesFullOverlap) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "hello world", {}, {}, {}, "", "", "", &err))
      << err;
  std::string full;
  ASSERT_TRUE(txt_read_offline_text(id, &full, &err)) << err;
  std::string slice;
  ASSERT_TRUE(txt_copy_offline_text_utf16_slice(id, 6, 5, &slice, &err)) << err;
  EXPECT_EQ(slice, "world");
  EXPECT_EQ(slice, full.substr(6, 5));
  ASSERT_TRUE(txt_copy_offline_text_utf16_slice(id, 100, 5, &slice, &err)) << err;
  EXPECT_EQ(slice, "");
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — utf16 slice axiom).
TEST_F(TextRegistryFixture, LiveSnapshotUtf16Slice_AfterAppend) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "abcdef", &err)) << err;
  std::string slice;
  ASSERT_TRUE(txt_copy_live_snapshot_utf16_slice(id, 2, 3, &slice, &err)) << err;
  EXPECT_EQ(slice, "cde");
  ASSERT_TRUE(txt_live_append_text(live, "gh", &err)) << err;
  ASSERT_TRUE(txt_copy_live_snapshot_utf16_slice(id, 5, 10, &slice, &err)) << err;
  EXPECT_EQ(slice, "fgh");
}

TEST_F(TextRegistryFixture, OfflinePopulateTokensTimestampsDurations) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  auto off = txt_get_offline_entry(id);
  ASSERT_NE(off, nullptr);
  std::vector<std::string> tokens = {"hel", "lo"};
  std::vector<float> timestamps = {0.1f, 0.2f};
  std::vector<float> durations = {0.05f, 0.06f};
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "hello", tokens, timestamps, durations, "en", "neutral",
                                            "speech", &err))
      << err;
  EXPECT_TRUE(off->populated);
  EXPECT_EQ(off->tokenCount(), 2);
  EXPECT_EQ(off->tokens[0], "hel");
  EXPECT_EQ(off->tokens[1], "lo");
  ASSERT_EQ(off->timestampCount(), 2);
  EXPECT_FLOAT_EQ(off->timestamps[0], 0.1f);
  EXPECT_FLOAT_EQ(off->timestamps[1], 0.2f);
  ASSERT_EQ(off->durationCount(), 2);
  EXPECT_FLOAT_EQ(off->durations[1], 0.06f);
  EXPECT_EQ(off->lang, "en");
  EXPECT_EQ(off->emotion, "neutral");
  EXPECT_EQ(off->event, "speech");
}

TEST_F(TextRegistryFixture, OfflinePopulateSpatialSpan) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  auto off = txt_get_offline_entry(id);
  ASSERT_NE(off, nullptr);
  TxtSpatialSpan span;
  span.utf16Start = 0;
  span.utf16End = 5;
  span.level = "word";
  span.sourceImageBufferId = "img_1";
  span.frameIndex = 2;
  for (int i = 0; i < 8; ++i) span.quad[i] = (float)i;
  span.hasConfidence = true;
  span.confidence = 0.9f;
  span.origin = "ocr";
  span.hasPageNumber = true;
  span.pageNumber = 3;
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "hello", {}, {}, {}, "", "", "", {span}, &err))
      << err;
  ASSERT_EQ(off->spatialSpanCount(), 1);
  EXPECT_EQ(off->spatialSpans[0].utf16Start, 0);
  EXPECT_EQ(off->spatialSpans[0].utf16End, 5);
  EXPECT_EQ(off->spatialSpans[0].level, "word");
  EXPECT_EQ(off->spatialSpans[0].sourceImageBufferId, "img_1");
  EXPECT_EQ(off->spatialSpans[0].frameIndex, 2);
  EXPECT_FLOAT_EQ(off->spatialSpans[0].quad[7], 7.f);
  EXPECT_TRUE(off->spatialSpans[0].hasConfidence);
  EXPECT_FLOAT_EQ(off->spatialSpans[0].confidence, 0.9f);
  EXPECT_TRUE(off->spatialSpans[0].hasPageNumber);
  EXPECT_EQ(off->spatialSpans[0].pageNumber, 3);
}

TEST_F(TextRegistryFixture, OfflineSecondPopulateIsNoOpFailure) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "first", {}, {}, {}, "", "", "", &err)) << err;
  EXPECT_FALSE(txt_populate_offline_if_empty(id, "second", {}, {}, {}, "", "", "", &err));
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(id, &text, &err)) << err;
  EXPECT_EQ(text, "first");
}

TEST_F(TextRegistryFixture, SpatialSpanJsonRoundTrip) {
  TxtSpatialSpan span;
  span.utf16Start = 1;
  span.utf16End = 4;
  span.level = "line";
  span.sourceImageBufferId = "buf";
  span.frameIndex = 0;
  span.quad[0] = 1.5f;
  span.quad[1] = 2.5f;
  span.origin = "textLayer";
  span.hasPtsMs = true;
  span.ptsMs = 12.5;
  span.href = "https://example.com";
  std::string json = txt_span_json::encode({span});
  std::vector<TxtSpatialSpan> decoded;
  ASSERT_TRUE(txt_span_json::decode(json, &decoded));
  ASSERT_EQ(decoded.size(), 1u);
  EXPECT_EQ(decoded[0].utf16Start, 1);
  EXPECT_EQ(decoded[0].utf16End, 4);
  EXPECT_EQ(decoded[0].level, "line");
  EXPECT_EQ(decoded[0].sourceImageBufferId, "buf");
  EXPECT_FLOAT_EQ(decoded[0].quad[0], 1.5f);
  EXPECT_FLOAT_EQ(decoded[0].quad[1], 2.5f);
  EXPECT_EQ(decoded[0].origin, "textLayer");
  EXPECT_TRUE(decoded[0].hasPtsMs);
  EXPECT_DOUBLE_EQ(decoded[0].ptsMs, 12.5);
  EXPECT_EQ(decoded[0].href, "https://example.com");

  EXPECT_EQ(txt_span_json::encodeSlice({span}, 0, 1), json);
  EXPECT_EQ(txt_span_json::encodeSlice({span}, 1, 1), "[]");
  EXPECT_EQ(txt_span_json::encodeTokensSlice({"a", "b"}, 0, 1), "[\"a\"]");
  EXPECT_EQ(txt_span_json::encodeFloatSlice({1.f, 2.f}, 1, 1), "[2]");
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

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — notify-only partial).
// D-A4 Batched mainHandler coalesce is Android Kotlin (device); host covers emit contract only.
TEST_F(TextRegistryFixture, PartialEmit_PassesUtf16LengthNotFullString) {
  struct Capture {
    std::string bufferId;
    std::string source;
    int utf16Length = -1;
    int64_t revision = -1;
    int calls = 0;
  };
  static Capture cap;
  cap = Capture{};

  txt_set_partial_emit_fn([](const std::string &bufferId, const char *source, int utf16Length,
                             int64_t revision, int64_t /*minIntervalMs*/) {
    cap.bufferId = bufferId;
    cap.source = source ? source : "";
    cap.utf16Length = utf16Length;
    cap.revision = revision;
    cap.calls += 1;
  });

  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, true, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, "hello", &err)) << err;

  EXPECT_EQ(cap.calls, 1);
  EXPECT_EQ(cap.bufferId, id);
  EXPECT_EQ(cap.source, "replace");
  EXPECT_EQ(cap.utf16Length, 5);
  EXPECT_GE(cap.revision, 1);

  ASSERT_TRUE(txt_live_append_text(live, "!", &err)) << err;
  EXPECT_EQ(cap.calls, 2);
  EXPECT_EQ(cap.source, "append");
  EXPECT_EQ(cap.utf16Length, 6);

  txt_set_partial_emit_fn(nullptr);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — spool lossless).
TEST_F(TextRegistryFixture, OptInSpool_SkippedWithoutEnv) {
  if (!SpoolOptInEnabled()) {
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

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C1).
// Also B — spool lossless (fullIfSpooled == RAM after APPEND/SET/commit).
TEST_F(TextRegistryFixture, OptInSpool_DeltaParityGrowRewriteCommit) {
  if (!SpoolOptInEnabled()) {
    GTEST_SKIP() << "Set SHERPA_HOST_TEXT_SPOOL=1 for TXT2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool_delta.bin").string();
  ASSERT_TRUE(txt_create_live(65536, 100, false, 0, "on", spool, true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  // Prefix-growing appends → PARTIAL_APPEND path.
  ASSERT_TRUE(txt_live_append_text(live, "hello", &err)) << err;
  ASSERT_TRUE(txt_live_append_text(live, " world", &err)) << err;
  ASSERT_TRUE(txt_live_append_text(live, "!", &err)) << err;

  // Non-prefix rewrite → PARTIAL_SET.
  ASSERT_TRUE(txt_live_write_partial(live, "RESET", &err)) << err;
  ASSERT_TRUE(txt_live_append_text(live, " more", &err)) << err;

  // Commit strips matching prefix from window; journal must not double-append.
  ASSERT_TRUE(txt_live_write_partial(live, "alpha beta", &err)) << err;
  ASSERT_TRUE(txt_live_commit_segment(live, "alpha ", {}, {}, "test", "", &err)) << err;
  // After commit, window is "beta"; append without leading space → "betagamma".
  ASSERT_TRUE(txt_live_append_text(live, "gamma", &err)) << err;

  const std::string expected = "alpha betagamma";

  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;

  Txt2TypeCounts counts;
  ASSERT_TRUE(CountTxt2JournalTypes(spool + ".txtj", &counts));
  EXPECT_GE(counts.partialAppend, 1);
  EXPECT_GE(counts.partialSet, 1);

  std::string offlineId;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(offlineId, &text, &err)) << err;
  EXPECT_EQ(text, expected);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C2).
TEST_F(TextRegistryFixture, OptInSpool_CheckpointRotateParity) {
  if (!SpoolOptInEnabled()) {
    GTEST_SKIP() << "Set SHERPA_HOST_TEXT_SPOOL=1 for TXT2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool_ckpt.bin").string();
  ASSERT_TRUE(txt_create_live(1 << 20, 100, false, 0, "on", spool, true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  std::string expected;
  constexpr int kOps = 400;  // > 128 × 3 rotates
  expected.reserve(static_cast<size_t>(kOps) * 2);
  for (int i = 0; i < kOps; ++i) {
    const std::string chunk = "x" + std::to_string(i % 10);
    expected += chunk;
    ASSERT_TRUE(txt_live_append_text(live, chunk, &err)) << err;
  }

  struct stat stJ {};
  struct stat stC {};
  ASSERT_EQ(stat((spool + ".txtj").c_str(), &stJ), 0);
  ASSERT_EQ(stat((spool + ".txtc").c_str(), &stC), 0);
  EXPECT_LT(stJ.st_size, 8 * 1024);
  EXPECT_GT(stC.st_size, 0);

  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  std::string offlineId;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(offlineId, &text, &err)) << err;
  EXPECT_EQ(text, expected);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (B — offline text view).
TEST_F(TextRegistryFixture, OfflineTextView_ParityWithRead) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  ASSERT_TRUE(txt_populate_offline_if_empty(id, "hello view", {}, {}, {}, "en", "", "", &err))
      << err;

  std::string viaRead;
  ASSERT_TRUE(txt_read_offline_text(id, &viaRead, &err)) << err;

  TxtOfflineTextView view;
  std::string code;
  std::string msg;
  ASSERT_TRUE(txt_acquire_offline_text_view(id, /*allowEmpty=*/false, &view, &code, &msg)) << msg;
  ASSERT_NE(view.data, nullptr);
  EXPECT_EQ(std::string(view.data, view.bytes), viaRead);
  EXPECT_STREQ(view.lang, "en");
  EXPECT_TRUE(view.populated);
  EXPECT_TRUE(static_cast<bool>(view.entry));

  EXPECT_TRUE(txt_release_buffer(id));
  // Storage stays alive while view holds shared_ptr.
  EXPECT_EQ(std::string(view.data, view.bytes), viaRead);
}

TEST_F(TextRegistryFixture, OfflineTextView_MissingAndEmpty) {
  TxtOfflineTextView view;
  std::string code;
  std::string msg;
  EXPECT_FALSE(txt_acquire_offline_text_view("txt_off_missing", false, &view, &code, &msg));
  EXPECT_EQ(code, "TEXT_BUFFER_NOT_FOUND");

  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;
  EXPECT_FALSE(txt_acquire_offline_text_view(id, /*allowEmpty=*/false, &view, &code, &msg));
  EXPECT_EQ(code, "TEXT_BUFFER_EMPTY");
  ASSERT_TRUE(txt_acquire_offline_text_view(id, /*allowEmpty=*/true, &view, &code, &msg)) << msg;
  EXPECT_EQ(view.bytes, 0u);
  EXPECT_EQ(view.data, nullptr);
}

TEST_F(TextRegistryFixture, CreateLiveFromOffline_SeedsPartial) {
  std::string offId;
  std::string err;
  ASSERT_TRUE(txt_create_offline_from_text("seed me", "de", "", "", &offId, &err)) << err;

  std::string liveId;
  std::string code;
  std::string msg;
  ASSERT_TRUE(txt_create_live_from_offline(offId, 1024, 100, false, 0, "off", "", true, &liveId,
                                           &code, &msg))
      << msg;
  auto live = txt_get_live_entry(liveId);
  ASSERT_NE(live, nullptr);
  std::string snap;
  ASSERT_TRUE(txt_live_snapshot_text(live, &snap, &err)) << err;
  EXPECT_EQ(snap, "seed me");
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C6).
// Unlock-before listeners/hooks: write/finalize/release notify outside stateMutex (SoT).
TEST_F(TextRegistryFixture, SegEngineHooks_FireOnWriteFinalizeRelease) {
  ResetSegHooks();
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  ASSERT_TRUE(txt_live_write_partial(live, "hello", &err)) << err;
  EXPECT_EQ(g_seg_text_write_n.load(), 1);
  {
    std::lock_guard<std::mutex> lock(g_seg_hook_mu);
    EXPECT_EQ(g_seg_last_text_id, id);
  }

  ASSERT_TRUE(txt_live_append_text(live, "!", &err)) << err;
  EXPECT_EQ(g_seg_text_write_n.load(), 2);

  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  EXPECT_EQ(g_seg_finalized_n.load(), 1);

  EXPECT_TRUE(txt_release_buffer(id));
  EXPECT_EQ(g_seg_released_n.load(), 1);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C3).
// Mid-session fullIfSpooled forces flushSpoolJournalLocked; finalize remains durable.
TEST_F(TextRegistryFixture, OptInSpool_DeferredFlushParityMidSession) {
  if (!SpoolOptInEnabled()) {
    GTEST_SKIP() << "Set SHERPA_HOST_TEXT_SPOOL=1 for TXT2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool_flush.bin").string();
  ASSERT_TRUE(txt_create_live(65536, 100, false, 0, "on", spool, true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  std::string expected;
  constexpr int kOps = 48;  // > kSpoolFlushRecords (32)
  for (int i = 0; i < kOps; ++i) {
    const std::string chunk = "a";
    expected += chunk;
    ASSERT_TRUE(txt_live_append_text(live, chunk, &err)) << err;
  }

  // Snapshot while live — must flush deferred journal and reconstruct.
  std::string midOffline;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &midOffline, &err)) << err;
  std::string midText;
  ASSERT_TRUE(txt_read_offline_text(midOffline, &midText, &err)) << err;
  EXPECT_EQ(midText, expected);

  ASSERT_TRUE(txt_live_append_text(live, "Z", &err)) << err;
  expected += "Z";

  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  std::string offlineId;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(offlineId, &text, &err)) << err;
  EXPECT_EQ(text, expected);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C8).
TEST_F(TextRegistryFixture, LivePartialUtf16Length_MatchesWindow) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  const std::string emoji = "\xF0\x9F\x98\x80";  // 😀 = 2 UTF-16 units
  ASSERT_TRUE(txt_live_write_partial(live, std::string("hi") + emoji, &err)) << err;
  EXPECT_EQ(txt_live_partial_utf16_length(live), 4);
  EXPECT_EQ(txt_live_partial_utf16_length(live), txt_utf16_length(live->snapshotText()));

  ASSERT_TRUE(txt_live_append_text(live, "!", &err)) << err;
  EXPECT_EQ(txt_live_partial_utf16_length(live), 5);
  EXPECT_EQ(txt_live_partial_utf16_length(live), txt_utf16_length(live->snapshotText()));

  ASSERT_TRUE(txt_live_commit_segment(live, "hi", {}, {}, "test", "", &err)) << err;
  // Window stripped "hi" → emoji + "!"
  EXPECT_EQ(live->snapshotText(), emoji + "!");
  EXPECT_EQ(txt_live_partial_utf16_length(live), 3);
  EXPECT_EQ(txt_live_partial_utf16_length(live), txt_utf16_length(live->snapshotText()));
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C12).
TEST_F(TextRegistryFixture, CommitWithSpoolOff_NoJournalFiles) {
  std::string id;
  std::string err;
  const std::string spool = (cacheDir_ / "should_not_appear.bin").string();
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", spool, true, &id, &err)) << err;
  auto live = txt_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  for (int i = 0; i < 40; ++i) {
    const std::string piece = "w" + std::to_string(i);
    ASSERT_TRUE(txt_live_write_partial(live, piece + " rest", &err)) << err;
    ASSERT_TRUE(txt_live_commit_segment(live, piece, {}, {}, "t", "", &err)) << err;
  }
  EXPECT_EQ(live->segmentCount(), 40);
  EXPECT_EQ(live->snapshotText(), " rest");
  EXPECT_FALSE(fs::exists(spool + ".txtj"));
  EXPECT_FALSE(fs::exists(spool + ".txtc"));
  EXPECT_FALSE(fs::exists(spool));

  int cursor = live->createSegmentCursor();
  auto drained = live->drainSegments(cursor, 100);
  EXPECT_EQ(drained.size(), 40u);
  live->releaseSegmentCursor(cursor);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C4).
// Spool I/O after stateMutex unlock — concurrent lookup must not hang.
TEST_F(TextRegistryFixture, OptInSpool_ConcurrentAppendWithLookup_NoDeadlock) {
  if (!SpoolOptInEnabled()) {
    GTEST_SKIP() << "Set SHERPA_HOST_TEXT_SPOOL=1 for TXT2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool_conc.bin").string();
  ASSERT_TRUE(txt_create_live(1 << 20, 100, false, 0, "on", spool, true, &id, &err)) << err;

  constexpr int kIters = 300;
  std::atomic<bool> appendDone{false};
  std::atomic<int> lookups{0};

  std::thread appender([&]() {
    auto live = txt_get_live_entry(id);
    if (!live) {
      ADD_FAILURE() << "missing live";
      appendDone.store(true);
      return;
    }
    std::string ec;
    for (int i = 0; i < kIters; ++i) {
      if (!txt_live_append_text(live, "x", &ec)) {
        ADD_FAILURE() << ec;
        break;
      }
    }
    appendDone.store(true);
  });

  std::thread lookup([&]() {
    while (!appendDone.load()) {
      auto live = txt_get_live_entry(id);
      if (live) {
        (void)live->snapshotText();
        (void)txt_live_partial_utf16_length(live);
        lookups.fetch_add(1);
      }
      std::this_thread::yield();
    }
    for (int i = 0; i < 20; ++i) {
      EXPECT_NE(txt_get_live_entry(id), nullptr);
      lookups.fetch_add(1);
    }
  });

  appender.join();
  lookup.join();

  EXPECT_GT(lookups.load(), 0);
  ASSERT_TRUE(txt_finalize_live(id, &err)) << err;
  std::string offlineId;
  ASSERT_TRUE(txt_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(offlineId, &text, &err)) << err;
  EXPECT_EQ(text.size(), static_cast<size_t>(kIters));
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C5).
TEST_F(TextRegistryFixture, OfflinePopulate_ConcurrentSecondFails_NoDeadlock) {
  std::string id;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&id, &err)) << err;

  const std::string big(256 * 1024, 'A');
  std::atomic<bool> firstDone{false};
  std::atomic<int> lookups{0};
  std::atomic<bool> secondFailed{false};

  std::thread populator([&]() {
    std::string ec;
    EXPECT_TRUE(txt_populate_offline_if_empty(id, big, {}, {}, {}, "en", "", "", &ec)) << ec;
    firstDone.store(true);
  });

  std::thread second([&]() {
    while (!firstDone.load()) {
      auto off = txt_get_offline_entry(id);
      if (off) lookups.fetch_add(1);
      std::this_thread::yield();
    }
    std::string ec;
    if (!txt_populate_offline_if_empty(id, "other", {}, {}, {}, "", "", "", &ec)) {
      secondFailed.store(true);
      EXPECT_NE(ec.find("already populated"), std::string::npos) << ec;
    }
  });

  populator.join();
  second.join();

  EXPECT_TRUE(secondFailed.load());
  EXPECT_GT(lookups.load(), 0);
  std::string text;
  ASSERT_TRUE(txt_read_offline_text(id, &text, &err)) << err;
  EXPECT_EQ(text, big);
}

// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (D-A2).
TEST_F(TextRegistryFixture, Utf16SliceUnits_ParityWithSliceReencode) {
  const std::string emoji = "\xF0\x9F\x98\x80";
  const std::string mixed = std::string("ab") + "ä" + emoji + "cd";

  auto expectParity = [](const std::string &utf8, int start, int max) {
    const std::string slice = txt_utf16_slice(utf8, start, max);
    const auto viaSlice = txt_utf16_from_utf8(slice);
    const auto viaUnits = txt_utf16_slice_units(utf8, start, max);
    EXPECT_EQ(viaUnits, viaSlice) << "start=" << start << " max=" << max;
  };

  expectParity(mixed, 0, 2);
  expectParity(mixed, 2, 1);   // ä
  expectParity(mixed, 3, 2);   // emoji
  expectParity(mixed, 5, 2);   // cd
  expectParity(mixed, 1, 4);
  expectParity("abcdef", 2, 3);

  std::string offId;
  std::string err;
  ASSERT_TRUE(txt_create_empty_offline(&offId, &err)) << err;
  ASSERT_TRUE(txt_populate_offline_if_empty(offId, mixed, {}, {}, {}, "", "", "", &err)) << err;
  std::vector<uint16_t> units;
  ASSERT_TRUE(txt_copy_offline_text_utf16_units(offId, 3, 2, &units, &err)) << err;
  EXPECT_EQ(units, txt_utf16_from_utf8(emoji));

  std::string liveId;
  ASSERT_TRUE(txt_create_live(1024, 100, false, 0, "off", "", true, &liveId, &err)) << err;
  auto live = txt_get_live_entry(liveId);
  ASSERT_NE(live, nullptr);
  ASSERT_TRUE(txt_live_write_partial(live, mixed, &err)) << err;
  units.clear();
  ASSERT_TRUE(txt_copy_live_snapshot_utf16_units(liveId, 5, 2, &units, &err)) << err;
  EXPECT_EQ(units, txt_utf16_from_utf8("cd"));
}

#if defined(__APPLE__)
// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (D-I3).
TEST_F(TextRegistryFixture, JetsamCaps_OffForceTightAdaptiveOverride) {
  const TxtJetsamCapsMode prevMode = txt_ios_get_jetsam_caps_mode();
  const int64_t prevOverride = -1;  // reset to OS at end
  txt_ios_set_jetsam_avail_override_bytes(-1);

  txt_ios_set_jetsam_caps_mode(TxtJetsamCapsModeOff);
  int w = 100000;
  int s = 9000;
  EXPECT_FALSE(txt_ios_apply_jetsam_caps(&w, &s));
  EXPECT_EQ(w, 100000);
  EXPECT_EQ(s, 9000);

  txt_ios_set_jetsam_caps_mode(TxtJetsamCapsModeForceTight);
  w = 100000;
  s = 9000;
  EXPECT_TRUE(txt_ios_apply_jetsam_caps(&w, &s));
  EXPECT_EQ(w, 16384);
  EXPECT_EQ(s, 512);

  txt_ios_set_jetsam_caps_mode(TxtJetsamCapsModeAdaptive);
  txt_ios_set_jetsam_avail_override_bytes(0);  // unknown → no clamp
  w = 100000;
  s = 9000;
  EXPECT_FALSE(txt_ios_apply_jetsam_caps(&w, &s));
  EXPECT_EQ(w, 100000);
  EXPECT_EQ(s, 9000);

  txt_ios_set_jetsam_avail_override_bytes(32LL * 1024 * 1024);  // < 64 MiB
  w = 100000;
  s = 9000;
  EXPECT_TRUE(txt_ios_apply_jetsam_caps(&w, &s));
  EXPECT_EQ(w, 16384);
  EXPECT_EQ(s, 512);

  txt_ios_set_jetsam_caps_mode(prevMode);
  txt_ios_set_jetsam_avail_override_bytes(prevOverride);
}
#endif
