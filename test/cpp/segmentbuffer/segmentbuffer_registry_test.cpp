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
