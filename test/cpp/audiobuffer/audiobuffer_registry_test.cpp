/**
 * Host tests for shared AudioRegistry / Pa* (no device required).
 *
 * Always-on: create/release, invalid IDs, offline RAM slice, live append/drain.
 * Opt-in mmap/spool: SHERPA_HOST_AUDIO_MMAP=1 ./audiobuffer_host_test
 *
 * Build: cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target audiobuffer_host_test
 * Run:   ctest --test-dir test/cpp/build -R audiobuffer_host_test --output-on-failure
 */
#include "AudioRegistry.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

namespace {

class AudioRegistryFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = fs::temp_directory_path() / ("pa_host_" + std::to_string(::getpid()));
    fs::create_directories(cacheDir_);
    pa_configure_cache_dir(cacheDir_.string());
    pa_configure_threshold(4ULL * 1024ULL * 1024ULL * 1024ULL);
  }

  void TearDown() override {
    std::error_code ec;
    fs::remove_all(cacheDir_, ec);
  }

  fs::path cacheDir_;
};

}  // namespace

TEST_F(AudioRegistryFixture, CreateEmptyOffline_AndRelease) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_empty_offline(16000, 1, &id, &errCode, &errMsg)) << errMsg;
  EXPECT_FALSE(id.empty());
  int sr = 0;
  int n = 0;
  ASSERT_TRUE(pa_get_offline_metadata(id, &sr, &n, &errCode, &errMsg));
  EXPECT_EQ(sr, 16000);
  EXPECT_EQ(n, 0);
  EXPECT_TRUE(pa_release_buffer(id));
  EXPECT_FALSE(pa_get_offline_metadata(id, &sr, &n, &errCode, &errMsg));
}

TEST_F(AudioRegistryFixture, CreateOfflineFromSamples_ReadSlice) {
  std::vector<float> samples(1600, 0.25f);
  std::string json;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_offline_from_samples(samples.data(), samples.size(), 16000, 1, &json,
                                             &errCode, &errMsg))
      << errMsg;
  ASSERT_NE(json.find("bufferId"), std::string::npos);

  auto pos = json.find("\"bufferId\":\"");
  ASSERT_NE(pos, std::string::npos);
  pos += 12;
  auto end = json.find('"', pos);
  std::string id = json.substr(pos, end - pos);

  std::vector<float> slice;
  ASSERT_TRUE(pa_get_offline_samples_slice(id, 0, 100, &slice, &errCode, &errMsg));
  ASSERT_EQ(slice.size(), 100u);
  EXPECT_FLOAT_EQ(slice[0], 0.25f);
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, LiveAppendDrainCursor) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  std::vector<float> chunk(320, 0.5f);
  ASSERT_TRUE(pa_append_samples_to_live(id, chunk.data(), chunk.size(), 16000, &errCode, &errMsg))
      << errMsg;

  auto live = pa_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  int cursor = live->createCursorHandle();
  auto drained = live->drainCursor(cursor, 320);
  EXPECT_EQ(drained.size(), 320u);
  live->releaseCursor(cursor);

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, DrainCursorInto_ParityWithAllocatingDrain) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  std::vector<float> pcm(640);
  for (int i = 0; i < 640; ++i) {
    pcm[static_cast<size_t>(i)] = static_cast<float>(i) * 0.001f;
  }
  ASSERT_TRUE(pa_append_samples_to_live(id, pcm.data(), pcm.size(), 16000, &errCode, &errMsg))
      << errMsg;

  auto live = pa_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  // Allocating drain mid-slice
  int cursorA = live->createCursorHandle();
  auto viaAlloc = live->drainCursor(cursorA, 200);
  ASSERT_EQ(viaAlloc.size(), 200u);

  // Into-dest drain from a fresh cursor for same range
  int cursorB = live->createCursorHandle();
  std::vector<float> dest(200, -1.f);
  int copied = -1;
  ASSERT_TRUE(pa_drain_cursor_into(id, cursorB, dest.data(), 200, &copied, &errCode, &errMsg))
      << errMsg;
  EXPECT_EQ(copied, 200);
  for (size_t i = 0; i < viaAlloc.size(); ++i) {
    EXPECT_FLOAT_EQ(dest[i], viaAlloc[i]) << "i=" << i;
  }

  // Remaining via into (EOF clamp)
  dest.assign(500, -1.f);
  ASSERT_TRUE(pa_drain_cursor_into(id, cursorB, dest.data(), 500, &copied, &errCode, &errMsg))
      << errMsg;
  EXPECT_EQ(copied, 440);
  auto viaAllocRest = live->drainCursor(cursorA, 500);
  ASSERT_EQ(viaAllocRest.size(), 440u);
  for (size_t i = 0; i < viaAllocRest.size(); ++i) {
    EXPECT_FLOAT_EQ(dest[i], viaAllocRest[i]) << "rest i=" << i;
  }

  // Empty drain
  ASSERT_TRUE(pa_drain_cursor_into(id, cursorB, dest.data(), 8, &copied, &errCode, &errMsg));
  EXPECT_EQ(copied, 0);

  // Invalid live id
  errCode.clear();
  copied = 99;
  EXPECT_FALSE(
      pa_drain_cursor_into("live_missing", 0, dest.data(), 8, &copied, &errCode, &errMsg));
  EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");
  EXPECT_EQ(copied, 0);

  live->releaseCursor(cursorA);
  live->releaseCursor(cursorB);
  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, InvalidId_FailsCleanly) {
  std::vector<float> out;
  std::string errCode;
  std::string errMsg;
  EXPECT_FALSE(pa_get_offline_samples_slice("off_missing", 0, 10, &out, &errCode, &errMsg));
  EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");
}

namespace {

std::string bufferIdFromCreateJson(const std::string &json) {
  auto pos = json.find("\"bufferId\":\"");
  if (pos == std::string::npos) return {};
  pos += 12;
  auto end = json.find('"', pos);
  if (end == std::string::npos) return {};
  return json.substr(pos, end - pos);
}

}  // namespace

TEST_F(AudioRegistryFixture, CopyOfflineSamples_ParityWithSlice) {
  std::vector<float> samples(200);
  for (int i = 0; i < 200; ++i) {
    samples[static_cast<size_t>(i)] = static_cast<float>(i) * 0.01f;
  }
  std::string json;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_offline_from_samples(samples.data(), samples.size(), 16000, 1, &json,
                                             &errCode, &errMsg))
      << errMsg;
  const std::string id = bufferIdFromCreateJson(json);
  ASSERT_FALSE(id.empty());

  // Mid-slice parity
  {
    std::vector<float> slice;
    ASSERT_TRUE(pa_get_offline_samples_slice(id, 50, 40, &slice, &errCode, &errMsg));
    ASSERT_EQ(slice.size(), 40u);

    std::vector<float> dest(40, -1.f);
    int copied = -1;
    ASSERT_TRUE(pa_copy_offline_samples(id, 50, dest.data(), 40, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 40);
    for (size_t i = 0; i < slice.size(); ++i) {
      EXPECT_FLOAT_EQ(dest[i], slice[i]) << "i=" << i;
    }
  }

  // EOF clamp
  {
    std::vector<float> dest(100, -1.f);
    int copied = -1;
    ASSERT_TRUE(pa_copy_offline_samples(id, 180, dest.data(), 100, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 20);
    std::vector<float> slice;
    ASSERT_TRUE(pa_get_offline_samples_slice(id, 180, 100, &slice, &errCode, &errMsg));
    ASSERT_EQ(slice.size(), 20u);
    for (size_t i = 0; i < slice.size(); ++i) {
      EXPECT_FLOAT_EQ(dest[i], slice[i]);
    }
  }

  // Past EOF → zero copied, success
  {
    std::vector<float> dest(8, -1.f);
    int copied = -1;
    ASSERT_TRUE(pa_copy_offline_samples(id, 200, dest.data(), 8, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 0);
    EXPECT_FLOAT_EQ(dest[0], -1.f);
  }

  // Empty / maxSamples 0
  {
    float scratch = 0.f;
    int copied = -1;
    ASSERT_TRUE(pa_copy_offline_samples(id, 0, &scratch, 0, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 0);
  }

  // Invalid id
  {
    float scratch = 0.f;
    int copied = 99;
    errCode.clear();
    EXPECT_FALSE(
        pa_copy_offline_samples("off_missing", 0, &scratch, 4, &copied, &errCode, &errMsg));
    EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");
    EXPECT_EQ(copied, 0);
  }

  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, OptInLargeMmap_SkippedWithoutEnv) {
  const char *flag = std::getenv("SHERPA_HOST_AUDIO_MMAP");
  if (flag == nullptr || std::string(flag) != "1") {
    GTEST_SKIP() << "Set SHERPA_HOST_AUDIO_MMAP=1 for large mmap opt-in test";
  }
  // ~2s of 48kHz float (~384k samples) — still modest; exercises threshold path when RAM low.
  const size_t n = 48000 * 2;
  std::vector<float> samples(n, 0.1f);
  std::string json;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_offline_from_samples(samples.data(), samples.size(), 48000, 1, &json,
                                             &errCode, &errMsg))
      << errMsg;
}
