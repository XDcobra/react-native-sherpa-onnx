/**
 * Host tests for shared SegmentRegistry / Seg* (no device required).
 *
 * Always-on: create/release, offline, live append/finalize, link-map CRUD.
 * Opt-in spool: SHERPA_HOST_SEGMENT_SPOOL=1 ./segmentbuffer_host_test
 *
 * Build: cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target segmentbuffer_host_test
 */
#include "SegmentLinkMapRegistry.h"
#include "SegmentRegistry.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <unistd.h>

namespace fs = std::filesystem;

namespace {

class SegmentRegistryFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = fs::temp_directory_path() / ("seg_host_" + std::to_string(::getpid()));
    fs::create_directories(cacheDir_);
    seg_configure_cache_dir(cacheDir_.string());
  }

  void TearDown() override {
    seg_release_all_entries();
    slm_release_all_link_maps();
    std::error_code ec;
    fs::remove_all(cacheDir_, ec);
  }

  fs::path cacheDir_;
};

}  // namespace

TEST_F(SegmentRegistryFixture, CreateEmptyOffline_Release) {
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_empty_offline("", &id, &err)) << err;
  EXPECT_FALSE(id.empty());
  EXPECT_TRUE(seg_get_offline_entry(id) != nullptr);
  EXPECT_TRUE(seg_release_buffer(id));
  EXPECT_EQ(seg_get_offline_entry(id), nullptr);
}

TEST_F(SegmentRegistryFixture, LiveAppendFinalize) {
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_live("", 100, "off", "", true, 0, false, 0, &id, &err)) << err;
  std::string segId;
  int segIndex = -1;
  ASSERT_TRUE(seg_live_append_segment(id, "speech", "audio_1", 0, 1600, 16000, 100, false, 0.0,
                                      "{\"source\":\"manual\"}", &segId, &segIndex, &err))
      << err;
  EXPECT_FALSE(segId.empty());
  EXPECT_GE(segIndex, 0);
  ASSERT_TRUE(seg_finalize_live(id, &err)) << err;
  EXPECT_TRUE(seg_release_buffer(id));
}

TEST_F(SegmentRegistryFixture, InvalidId_FailsCleanly) {
  std::string err;
  EXPECT_FALSE(seg_finalize_live("seg_live_missing", &err));
}

TEST_F(SegmentRegistryFixture, LinkMap_CreateAddDuplicateReject) {
  std::string mapId;
  std::string err;
  ASSERT_TRUE(slm_create("", "", &mapId, &err)) << err;
  PaSegmentLink link;
  ASSERT_TRUE(slm_add_link(mapId, "t1", "s1", "alignment", false, 0.f, "", &link, &err)) << err;
  EXPECT_FALSE(link.linkId.empty());
  EXPECT_FALSE(slm_add_link(mapId, "t1", "s1", "alignment", false, 0.f, "", &link, &err));
  PaSegmentLinkMapInfo info;
  ASSERT_TRUE(slm_get_info(mapId, &info, &err)) << err;
  EXPECT_EQ(info.linkCount, 1);
  EXPECT_TRUE(slm_release(mapId));
}

TEST_F(SegmentRegistryFixture, LiveCursor_DrainOrderAndEmptySecond) {
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_live("", 100, "off", "", true, 0, false, 0, &id, &err)) << err;

  for (int i = 0; i < 3; ++i) {
    std::string segId;
    int segIndex = -1;
    ASSERT_TRUE(seg_live_append_segment(id, "speech", "a", i * 100, i * 100 + 50, 16000, 3, false,
                                        0.0, "{}", &segId, &segIndex, &err))
        << err;
    EXPECT_EQ(segIndex, i);
  }

  int cursor = seg_live_create_cursor(id, &err);
  ASSERT_GE(cursor, 0) << err;

  int start = -1;
  auto batch1 = seg_live_drain_segments(id, cursor, 10, &start, &err);
  ASSERT_EQ(batch1.size(), 3u);
  EXPECT_EQ(start, 0);
  EXPECT_EQ(batch1[0].startSample, 0);
  EXPECT_EQ(batch1[1].startSample, 100);
  EXPECT_EQ(batch1[2].startSample, 200);

  start = -1;
  auto batch2 = seg_live_drain_segments(id, cursor, 10, &start, &err);
  EXPECT_TRUE(batch2.empty());
  EXPECT_EQ(start, -1);

  seg_live_release_cursor(id, cursor);
  EXPECT_TRUE(seg_release_buffer(id));
}

TEST_F(SegmentRegistryFixture, LiveCursor_UnknownCursorReturnsEmpty) {
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_live("", 100, "off", "", true, 0, false, 0, &id, &err)) << err;
  std::string segId;
  int segIndex = -1;
  ASSERT_TRUE(seg_live_append_segment(id, "speech", "a", 0, 100, 16000, 6, false, 0.0, "{}",
                                      &segId, &segIndex, &err))
      << err;

  int start = -1;
  auto batch = seg_live_drain_segments(id, /*unknown*/ 99999, 10, &start, &err);
  EXPECT_TRUE(batch.empty());
  EXPECT_EQ(start, -1);
  EXPECT_TRUE(seg_release_buffer(id));
}

TEST_F(SegmentRegistryFixture, LiveCursor_EvictionPreservesAbsoluteStartIndex) {
  // C segment policy: eviction does not rewind cursors (unlike Text). Absolute startIndex
  // accounts for evictedCount so drained ids stay monotonic with written indices.
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_live("", /*maxSegments*/ 2, "off", "", true, 0, false, 0, &id, &err))
      << err;

  int cursor = seg_live_create_cursor(id, &err);
  ASSERT_GE(cursor, 0) << err;

  for (int i = 0; i < 4; ++i) {
    std::string segId;
    int segIndex = -1;
    ASSERT_TRUE(seg_live_append_segment(id, "speech", "a", i * 10, i * 10 + 5, 16000, 1, false, 0.0,
                                        "{}", &segId, &segIndex, &err))
        << err;
    EXPECT_EQ(segIndex, i);
  }

  auto live = seg_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  {
    std::lock_guard<std::mutex> lock(live->lock);
    EXPECT_EQ(live->segments.size(), 2u);
    EXPECT_EQ(live->evictedCount, 2);
    EXPECT_EQ(live->totalSegmentsWritten, 4);
  }

  int start = -1;
  auto batch = seg_live_drain_segments(id, cursor, 10, &start, &err);
  // Cursor still at window pos 0; after two evictions window holds indices 2 and 3.
  ASSERT_EQ(batch.size(), 2u);
  EXPECT_EQ(start, 2);
  EXPECT_EQ(batch[0].startSample, 20);
  EXPECT_EQ(batch[1].startSample, 30);

  EXPECT_TRUE(seg_release_buffer(id));
}

TEST_F(SegmentRegistryFixture, LiveFinalize_RejectsFurtherAppend) {
  std::string id;
  std::string err;
  ASSERT_TRUE(seg_create_live("", 100, "off", "", true, 0, false, 0, &id, &err)) << err;
  ASSERT_TRUE(seg_finalize_live(id, &err)) << err;

  std::string segId;
  int segIndex = -1;
  EXPECT_FALSE(seg_live_append_segment(id, "speech", "a", 0, 100, 16000, 6, false, 0.0, "{}",
                                       &segId, &segIndex, &err));
  EXPECT_NE(err.find("SEGMENT_ALREADY_FINALIZED"), std::string::npos);
  EXPECT_TRUE(seg_release_buffer(id));
}

TEST_F(SegmentRegistryFixture, OfflineFromLive_WindowSnapshotAndSlice) {
  std::string liveId;
  std::string err;
  ASSERT_TRUE(seg_create_live("", 100, "off", "", true, 0, false, 0, &liveId, &err)) << err;
  for (int i = 0; i < 3; ++i) {
    std::string segId;
    int segIndex = -1;
    ASSERT_TRUE(seg_live_append_segment(liveId, "speech", "a", i * 100, i * 100 + 50, 16000, 3,
                                        false, 0.0, "{}", &segId, &segIndex, &err))
        << err;
  }

  auto window = seg_live_get_window_segments(liveId, 1, 1);
  ASSERT_EQ(window.size(), 1u);
  EXPECT_EQ(window[0].startSample, 100);

  auto oob = seg_live_get_window_segments(liveId, 10, 5);
  EXPECT_TRUE(oob.empty());
  auto neg = seg_live_get_window_segments(liveId, -1, 5);
  EXPECT_TRUE(neg.empty());

  std::string offlineId;
  ASSERT_TRUE(seg_create_offline_from_live(liveId, "windowSnapshot", &offlineId, &err)) << err;
  EXPECT_EQ(seg_offline_segment_count(offlineId), 3);

  auto slice = seg_offline_get_segments(offlineId, 1, 2);
  ASSERT_EQ(slice.size(), 2u);
  EXPECT_EQ(slice[0].startSample, 100);
  EXPECT_EQ(slice[1].startSample, 200);

  EXPECT_TRUE(seg_release_buffer(liveId));
  EXPECT_TRUE(seg_release_buffer(offlineId));
}

TEST_F(SegmentRegistryFixture, OfflinePopulate_ThenSlice_SecondFails) {
  std::string offlineId;
  std::string err;
  ASSERT_TRUE(seg_create_empty_offline("audio_src", &offlineId, &err)) << err;
  EXPECT_EQ(seg_offline_segment_count(offlineId), 0);

  SegRecord r;
  r.id = "seg_manual_1";
  r.kind = "speech";
  r.sourceAudioBufferId = "audio_src";
  r.startSample = 0;
  r.endSample = 1600;
  r.sampleRate = 16000;
  r.durationMs = 100;
  ASSERT_TRUE(seg_offline_populate(offlineId, {r}, &err)) << err;
  EXPECT_EQ(seg_offline_segment_count(offlineId), 1);

  auto slice = seg_offline_get_segments(offlineId, 0, 10);
  ASSERT_EQ(slice.size(), 1u);
  EXPECT_EQ(slice[0].id, "seg_manual_1");

  err.clear();
  EXPECT_FALSE(seg_offline_populate(offlineId, {r}, &err));
  EXPECT_NE(err.find("SEGMENT_INVALID_STATE"), std::string::npos);

  EXPECT_TRUE(seg_release_buffer(offlineId));
}

TEST_F(SegmentRegistryFixture, OptInSpool_SkippedWithoutEnv) {
  const char *flag = std::getenv("SHERPA_HOST_SEGMENT_SPOOL");
  if (flag == nullptr || std::string(flag) != "1") {
    GTEST_SKIP() << "Set SHERPA_HOST_SEGMENT_SPOOL=1 for SEG2 spool opt-in test";
  }
  std::string id;
  std::string err;
  std::string spool = (cacheDir_ / "spool").string();
  ASSERT_TRUE(seg_create_live("", 100, "on", spool, true, 0, false, 0, &id, &err)) << err;
  std::string segId;
  int segIndex = -1;
  ASSERT_TRUE(seg_live_append_segment(id, "speech", "a", 0, 800, 16000, 50, false, 0.0,
                                      "{\"source\":\"manual\"}", &segId, &segIndex, &err))
      << err;
  ASSERT_TRUE(seg_finalize_live(id, &err)) << err;
  std::string offlineId;
  ASSERT_TRUE(seg_create_offline_from_live(id, "fullIfSpooled", &offlineId, &err)) << err;
  auto off = seg_get_offline_entry(offlineId);
  ASSERT_NE(off, nullptr);
  EXPECT_FALSE(off->segments.empty());
}
