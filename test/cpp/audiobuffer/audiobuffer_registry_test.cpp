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

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <regex>
#include <string>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

namespace {

std::mutex g_seg_hook_mu;
std::atomic<int> g_seg_audio_append_n{0};
std::atomic<int> g_seg_finalized_n{0};
std::atomic<int> g_seg_released_n{0};
std::string g_seg_last_audio_id;
size_t g_seg_last_count = 0;
int g_seg_last_sr = 0;
int64_t g_seg_last_total = 0;

void ResetSegHooks() {
  std::lock_guard<std::mutex> lock(g_seg_hook_mu);
  g_seg_audio_append_n = 0;
  g_seg_finalized_n = 0;
  g_seg_released_n = 0;
  g_seg_last_audio_id.clear();
  g_seg_last_count = 0;
  g_seg_last_sr = 0;
  g_seg_last_total = 0;
}

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

// Strong overrides of weak AudioRegistry stubs — assert C append/finalize/release notify.
void seg_engine_on_audio_append(const std::string &liveBufferId, const float * /*samples*/,
                                size_t count, int sampleRate, int64_t totalSamplesWritten) {
  std::lock_guard<std::mutex> lock(g_seg_hook_mu);
  g_seg_audio_append_n.fetch_add(1);
  g_seg_last_audio_id = liveBufferId;
  g_seg_last_count = count;
  g_seg_last_sr = sampleRate;
  g_seg_last_total = totalSamplesWritten;
}

void seg_engine_on_buffer_finalized(const std::string & /*bufferId*/) {
  g_seg_finalized_n.fetch_add(1);
}

void seg_engine_on_buffer_released(const std::string & /*bufferId*/) {
  g_seg_released_n.fetch_add(1);
}

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

TEST_F(AudioRegistryFixture, GeneratedIds_MatchTsDashedUuidPattern) {
  static const char *kPattern =
      "^(off|live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
  std::regex re(kPattern);
  for (int i = 0; i < 32; ++i) {
    std::string offId;
    std::string liveId;
    std::string errCode;
    std::string errMsg;
    ASSERT_TRUE(pa_create_empty_offline(16000, 1, &offId, &errCode, &errMsg)) << errMsg;
    ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &liveId, &errCode, &errMsg)) << errMsg;
    EXPECT_TRUE(std::regex_match(offId, re)) << offId;
    EXPECT_TRUE(std::regex_match(liveId, re)) << liveId;
    EXPECT_TRUE(pa_release_buffer(offId));
    EXPECT_TRUE(pa_release_buffer(liveId));
  }
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

TEST_F(AudioRegistryFixture, CopyLiveSamplesSlice_ParityWithSlice) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  std::vector<float> pcm(400);
  for (int i = 0; i < 400; ++i) {
    pcm[static_cast<size_t>(i)] = static_cast<float>(i) * 0.01f;
  }
  ASSERT_TRUE(pa_append_samples_to_live(id, pcm.data(), pcm.size(), 16000, &errCode, &errMsg))
      << errMsg;

  // Mid-slice parity
  {
    std::vector<float> viaGet;
    ASSERT_TRUE(pa_get_live_samples_slice(id, 50, 80, &viaGet, &errCode, &errMsg));
    ASSERT_EQ(viaGet.size(), 80u);

    std::vector<float> dest(80, -1.f);
    int copied = -1;
    ASSERT_TRUE(
        pa_copy_live_samples_slice(id, 50, 80, dest.data(), 80, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 80);
    for (size_t i = 0; i < viaGet.size(); ++i) {
      EXPECT_FLOAT_EQ(dest[i], viaGet[i]) << "i=" << i;
    }
  }

  // EOF clamp
  {
    std::vector<float> viaGet;
    ASSERT_TRUE(pa_get_live_samples_slice(id, 350, 100, &viaGet, &errCode, &errMsg));
    ASSERT_EQ(viaGet.size(), 50u);

    std::vector<float> dest(100, -1.f);
    int copied = -1;
    ASSERT_TRUE(
        pa_copy_live_samples_slice(id, 350, 100, dest.data(), 100, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 50);
    for (size_t i = 0; i < viaGet.size(); ++i) {
      EXPECT_FLOAT_EQ(dest[i], viaGet[i]);
    }
  }

  // Past end → zero copied
  {
    std::vector<float> dest(8, -1.f);
    int copied = -1;
    ASSERT_TRUE(
        pa_copy_live_samples_slice(id, 400, 8, dest.data(), 8, &copied, &errCode, &errMsg));
    EXPECT_EQ(copied, 0);
    EXPECT_FLOAT_EQ(dest[0], -1.f);
  }

  // Invalid id
  {
    float scratch = 0.f;
    int copied = 99;
    errCode.clear();
    EXPECT_FALSE(
        pa_copy_live_samples_slice("live_missing", 0, 4, &scratch, 4, &copied, &errCode, &errMsg));
    EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");
    EXPECT_EQ(copied, 0);
  }

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, AppendInt16_ParityWithFloat) {
  std::string idFloat;
  std::string idInt16;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &idFloat, &errCode, &errMsg)) << errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &idInt16, &errCode, &errMsg)) << errMsg;

  const int16_t i16[] = {0, 32767, -32768, -1, 16384, -16384};
  const size_t n = sizeof(i16) / sizeof(i16[0]);
  std::vector<float> asFloat(n);
  for (size_t i = 0; i < n; ++i) {
    asFloat[i] = static_cast<float>(i16[i]) / 32768.0f;
  }

  ASSERT_TRUE(
      pa_append_samples_to_live(idFloat, asFloat.data(), asFloat.size(), 16000, &errCode, &errMsg))
      << errMsg;
  ASSERT_TRUE(
      pa_append_int16_samples_to_live(idInt16, i16, n, 16000, &errCode, &errMsg))
      << errMsg;

  auto liveF = pa_get_live_entry(idFloat);
  auto liveI = pa_get_live_entry(idInt16);
  ASSERT_NE(liveF, nullptr);
  ASSERT_NE(liveI, nullptr);
  EXPECT_EQ(liveF->totalSamplesWritten, liveI->totalSamplesWritten);
  EXPECT_EQ(liveF->totalSamplesWritten, static_cast<int64_t>(n));

  int cF = liveF->createCursorHandle();
  int cI = liveI->createCursorHandle();
  auto dF = liveF->drainCursor(cF, static_cast<int>(n));
  auto dI = liveI->drainCursor(cI, static_cast<int>(n));
  ASSERT_EQ(dF.size(), n);
  ASSERT_EQ(dI.size(), n);
  for (size_t i = 0; i < n; ++i) {
    EXPECT_FLOAT_EQ(dF[i], asFloat[i]) << "float path i=" << i;
    EXPECT_FLOAT_EQ(dI[i], asFloat[i]) << "int16 path i=" << i;
    EXPECT_FLOAT_EQ(dF[i], dI[i]) << "parity i=" << i;
  }
  liveF->releaseCursor(cF);
  liveI->releaseCursor(cI);

  // Invalid id
  errCode.clear();
  EXPECT_FALSE(pa_append_int16_samples_to_live("live_missing", i16, n, 16000, &errCode, &errMsg));
  EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");

  // Empty / null
  errCode.clear();
  EXPECT_FALSE(pa_append_int16_samples_to_live(idInt16, i16, 0, 16000, &errCode, &errMsg));
  EXPECT_EQ(errCode, "AUDIO_INVALID_ARGUMENT");

  ASSERT_TRUE(pa_finalize_live(idFloat, &errCode, &errMsg));
  ASSERT_TRUE(pa_finalize_live(idInt16, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(idFloat));
  EXPECT_TRUE(pa_release_buffer(idInt16));
}

TEST_F(AudioRegistryFixture, AppendInt16_MultiChunkParityWithFloat) {
  // Forces C #4 kChunk=4096 boundary (one full chunk + remainder).
  constexpr size_t kN = 4096 + 257;
  std::string idFloat;
  std::string idInt16;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &idFloat, &errCode, &errMsg)) << errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &idInt16, &errCode, &errMsg)) << errMsg;

  std::vector<int16_t> i16(kN);
  std::vector<float> asFloat(kN);
  for (size_t i = 0; i < kN; ++i) {
    const int16_t v = static_cast<int16_t>((i % 60001) - 30000);
    i16[i] = v;
    asFloat[i] = static_cast<float>(v) / 32768.0f;
  }

  ASSERT_TRUE(
      pa_append_samples_to_live(idFloat, asFloat.data(), asFloat.size(), 16000, &errCode, &errMsg))
      << errMsg;
  ASSERT_TRUE(
      pa_append_int16_samples_to_live(idInt16, i16.data(), i16.size(), 16000, &errCode, &errMsg))
      << errMsg;

  auto liveF = pa_get_live_entry(idFloat);
  auto liveI = pa_get_live_entry(idInt16);
  ASSERT_NE(liveF, nullptr);
  ASSERT_NE(liveI, nullptr);
  EXPECT_EQ(liveF->totalSamplesWritten, liveI->totalSamplesWritten);
  EXPECT_EQ(liveF->totalSamplesWritten, static_cast<int64_t>(kN));

  int cF = liveF->createCursorHandle();
  int cI = liveI->createCursorHandle();
  auto dF = liveF->drainCursor(cF, static_cast<int>(kN));
  auto dI = liveI->drainCursor(cI, static_cast<int>(kN));
  liveF->releaseCursor(cF);
  liveI->releaseCursor(cI);
  ASSERT_EQ(dF.size(), kN);
  ASSERT_EQ(dI.size(), kN);
  for (size_t i = 0; i < kN; ++i) {
    EXPECT_FLOAT_EQ(dF[i], asFloat[i]) << "float path i=" << i;
    EXPECT_FLOAT_EQ(dI[i], asFloat[i]) << "int16 path i=" << i;
    EXPECT_FLOAT_EQ(dF[i], dI[i]) << "parity i=" << i;
  }

  ASSERT_TRUE(pa_finalize_live(idFloat, &errCode, &errMsg));
  ASSERT_TRUE(pa_finalize_live(idInt16, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(idFloat));
  EXPECT_TRUE(pa_release_buffer(idInt16));
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

TEST_F(AudioRegistryFixture, AcquireOfflineSampleView_RamParityRangeAndRelease) {
  std::vector<float> samples(64);
  for (int i = 0; i < 64; ++i) {
    samples[static_cast<size_t>(i)] = static_cast<float>(i) * 0.5f;
  }
  std::string json;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_offline_from_samples(samples.data(), samples.size(), 16000, 1, &json,
                                             &errCode, &errMsg))
      << errMsg;
  const std::string id = bufferIdFromCreateJson(json);
  ASSERT_FALSE(id.empty());

  std::vector<float> read;
  int readRate = 0;
  ASSERT_TRUE(pa_read_offline_samples(id, &read, &readRate));
  ASSERT_EQ(read.size(), samples.size());

  PaOfflineSampleView full;
  ASSERT_TRUE(pa_acquire_offline_sample_view(id, -1, -1, &full, &errCode, &errMsg)) << errMsg;
  EXPECT_EQ(full.sampleRate, readRate);
  EXPECT_EQ(full.count, read.size());
  ASSERT_NE(full.data, nullptr);
  ASSERT_TRUE(static_cast<bool>(full.entry));
  for (size_t i = 0; i < read.size(); ++i) {
    EXPECT_FLOAT_EQ(full.data[i], read[i]) << "i=" << i;
  }

  PaOfflineSampleView range;
  ASSERT_TRUE(pa_acquire_offline_sample_view(id, 10, 26, &range, &errCode, &errMsg)) << errMsg;
  EXPECT_EQ(range.count, 16u);
  ASSERT_NE(range.data, nullptr);
  for (size_t i = 0; i < range.count; ++i) {
    EXPECT_FLOAT_EQ(range.data[i], read[10 + i]);
  }

  // Past-end range clamps to empty success.
  PaOfflineSampleView past;
  ASSERT_TRUE(pa_acquire_offline_sample_view(id, 64, 80, &past, &errCode, &errMsg));
  EXPECT_EQ(past.count, 0u);
  EXPECT_EQ(past.data, nullptr);

  EXPECT_TRUE(pa_release_buffer(id));
  // Registry id is gone, but a held view keeps storage readable.
  EXPECT_FLOAT_EQ(full.data[0], read[0]);
  EXPECT_FLOAT_EQ(full.data[63], read[63]);
  PaOfflineSampleView missing;
  errCode.clear();
  EXPECT_FALSE(pa_acquire_offline_sample_view(id, -1, -1, &missing, &errCode, &errMsg));
  EXPECT_EQ(errCode, "AUDIO_BUFFER_NOT_FOUND");
}

TEST_F(AudioRegistryFixture, AcquireOfflineSampleView_EmptyBuffer) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_empty_offline(16000, 1, &id, &errCode, &errMsg)) << errMsg;

  PaOfflineSampleView view;
  ASSERT_TRUE(pa_acquire_offline_sample_view(id, -1, -1, &view, &errCode, &errMsg)) << errMsg;
  EXPECT_EQ(view.count, 0u);
  EXPECT_EQ(view.sampleRate, 16000);
  EXPECT_EQ(view.data, nullptr);
  EXPECT_TRUE(static_cast<bool>(view.entry));

  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, SegEngineHooks_FireOnAppendFinalizeRelease) {
  ResetSegHooks();
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  std::vector<float> chunk(160, 0.25f);
  ASSERT_TRUE(pa_append_samples_to_live(id, chunk.data(), chunk.size(), 16000, &errCode, &errMsg))
      << errMsg;
  EXPECT_EQ(g_seg_audio_append_n.load(), 1);
  {
    std::lock_guard<std::mutex> lock(g_seg_hook_mu);
    EXPECT_EQ(g_seg_last_audio_id, id);
    EXPECT_EQ(g_seg_last_count, chunk.size());
    EXPECT_EQ(g_seg_last_sr, 16000);
    EXPECT_EQ(g_seg_last_total, static_cast<int64_t>(chunk.size()));
  }

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg)) << errMsg;
  EXPECT_EQ(g_seg_finalized_n.load(), 1);

  EXPECT_TRUE(pa_release_buffer(id));
  EXPECT_EQ(g_seg_released_n.load(), 1);
}

namespace {

/** Append uneven chunks that wrap the ring; return golden linear stream. */
std::vector<float> appendUnevenWrapChunks(const std::string &id, int sampleRate,
                                          int64_t targetTotal, std::string *errCode,
                                          std::string *errMsg) {
  const int chunkSizes[] = {257, 320, 1600};
  std::vector<float> golden;
  golden.reserve(static_cast<size_t>(targetTotal));
  int chunkIdx = 0;
  int64_t seq = 0;
  while (static_cast<int64_t>(golden.size()) < targetTotal) {
    const int want = chunkSizes[chunkIdx % 3];
    ++chunkIdx;
    const int n =
        static_cast<int>(std::min<int64_t>(want, targetTotal - static_cast<int64_t>(golden.size())));
    std::vector<float> chunk(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      chunk[static_cast<size_t>(i)] = static_cast<float>(seq++) * 0.0001f;
    }
    EXPECT_TRUE(pa_append_samples_to_live(id, chunk.data(), chunk.size(), sampleRate, errCode, errMsg))
        << *errMsg;
    golden.insert(golden.end(), chunk.begin(), chunk.end());
  }
  return golden;
}

}  // namespace

TEST_F(AudioRegistryFixture, LiveRingWrap_AppendDrainMatchesGoldenTail) {
  // windowCapacity = max(sr, windowSec*sr) → 16000 even for sub-second windowSec.
  constexpr int kSr = 16000;
  constexpr double kWindowSec = 0.05;
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(kSr, 1, kWindowSec, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  auto live = pa_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  const int cap = live->windowCapacity;
  ASSERT_EQ(cap, kSr);

  // Past one full ring plus uneven wrap; forces multi-span write + drain.
  const int64_t targetTotal = static_cast<int64_t>(cap) + 257 + 320 + 1600 + 400;
  const std::vector<float> golden =
      appendUnevenWrapChunks(id, kSr, targetTotal, &errCode, &errMsg);
  ASSERT_EQ(static_cast<int64_t>(golden.size()), targetTotal);
  EXPECT_EQ(live->totalSamplesWritten, targetTotal);
  EXPECT_EQ(live->totalSamplesDropped, targetTotal - cap);

  int cursor = live->createCursorHandle();
  auto drained = live->drainCursor(cursor, cap + 64);
  live->releaseCursor(cursor);
  ASSERT_EQ(drained.size(), static_cast<size_t>(cap));

  const float *tail = golden.data() + (golden.size() - static_cast<size_t>(cap));
  for (int i = 0; i < cap; ++i) {
    EXPECT_FLOAT_EQ(drained[static_cast<size_t>(i)], tail[i]) << "i=" << i;
  }

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, LiveRingWrap_PeekVsDrainParity) {
  constexpr int kSr = 16000;
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(kSr, 1, 0.1, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  auto live = pa_get_live_entry(id);
  ASSERT_NE(live, nullptr);
  const int cap = live->windowCapacity;
  const int64_t targetTotal = static_cast<int64_t>(cap) + 900;
  (void)appendUnevenWrapChunks(id, kSr, targetTotal, &errCode, &errMsg);
  ASSERT_EQ(live->totalSamplesWritten, targetTotal);

  // Ring-relative mid window vs absolute drain of the same samples.
  constexpr int kPeekStart = 100;
  constexpr int kPeekCount = 480;

  std::vector<float> viaGet;
  ASSERT_TRUE(pa_get_live_samples_slice(id, kPeekStart, kPeekCount, &viaGet, &errCode, &errMsg));
  ASSERT_EQ(viaGet.size(), static_cast<size_t>(kPeekCount));

  std::vector<float> viaCopy(static_cast<size_t>(kPeekCount), -1.f);
  int copied = -1;
  ASSERT_TRUE(pa_copy_live_samples_slice(id, kPeekStart, kPeekCount, viaCopy.data(), kPeekCount,
                                         &copied, &errCode, &errMsg));
  EXPECT_EQ(copied, kPeekCount);

  int cursor = live->createCursorHandle();
  // Skip ring-relative prefix so drain lands on the same absolute range as peek.
  {
    std::vector<float> skip(static_cast<size_t>(kPeekStart));
    int skipCopied = -1;
    ASSERT_TRUE(pa_drain_cursor_into(id, cursor, skip.data(), kPeekStart, &skipCopied, &errCode,
                                     &errMsg));
    EXPECT_EQ(skipCopied, kPeekStart);
  }
  std::vector<float> viaDrain(static_cast<size_t>(kPeekCount), -2.f);
  ASSERT_TRUE(pa_drain_cursor_into(id, cursor, viaDrain.data(), kPeekCount, &copied, &errCode,
                                   &errMsg));
  EXPECT_EQ(copied, kPeekCount);
  live->releaseCursor(cursor);

  for (int i = 0; i < kPeekCount; ++i) {
    EXPECT_FLOAT_EQ(viaGet[static_cast<size_t>(i)], viaCopy[static_cast<size_t>(i)]) << "i=" << i;
    EXPECT_FLOAT_EQ(viaGet[static_cast<size_t>(i)], viaDrain[static_cast<size_t>(i)]) << "i=" << i;
  }

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}

TEST_F(AudioRegistryFixture, LiveRingWrap_Int16ParityAndSegHook) {
  ResetSegHooks();
  constexpr int kSr = 16000;
  std::string idFloat;
  std::string idInt16;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(kSr, 1, 0.05, "", false, 0, &idFloat, &errCode, &errMsg)) << errMsg;
  ASSERT_TRUE(pa_create_live(kSr, 1, 0.05, "", false, 0, &idInt16, &errCode, &errMsg)) << errMsg;

  auto liveF = pa_get_live_entry(idFloat);
  auto liveI = pa_get_live_entry(idInt16);
  ASSERT_NE(liveF, nullptr);
  ASSERT_NE(liveI, nullptr);
  const int cap = liveF->windowCapacity;

  // Uneven int16 chunks past wrap; float twin built from the same convert.
  const int chunkSizes[] = {257, 320, 1600};
  int64_t seq = 0;
  int chunkIdx = 0;
  const int64_t targetTotal = static_cast<int64_t>(cap) + 500;
  int appendCalls = 0;
  while (liveF->totalSamplesWritten < targetTotal) {
    const int want = chunkSizes[chunkIdx % 3];
    ++chunkIdx;
    const int n = static_cast<int>(
        std::min<int64_t>(want, targetTotal - liveF->totalSamplesWritten));
    std::vector<int16_t> i16(static_cast<size_t>(n));
    std::vector<float> f32(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      // Deterministic non-trivial PCM spanning ±range.
      const int16_t v = static_cast<int16_t>(((seq + i) % 60001) - 30000);
      i16[static_cast<size_t>(i)] = v;
      f32[static_cast<size_t>(i)] = static_cast<float>(v) / 32768.0f;
    }
    seq += n;
    ASSERT_TRUE(pa_append_samples_to_live(idFloat, f32.data(), f32.size(), kSr, &errCode, &errMsg))
        << errMsg;
    ASSERT_TRUE(pa_append_int16_samples_to_live(idInt16, i16.data(), i16.size(), kSr, &errCode,
                                                &errMsg))
        << errMsg;
    ++appendCalls;
  }

  EXPECT_EQ(liveF->totalSamplesWritten, liveI->totalSamplesWritten);
  EXPECT_EQ(liveF->totalSamplesDropped, liveI->totalSamplesDropped);
  EXPECT_GE(liveF->totalSamplesDropped, 1);
  EXPECT_EQ(g_seg_audio_append_n.load(), appendCalls * 2);

  int cF = liveF->createCursorHandle();
  int cI = liveI->createCursorHandle();
  auto dF = liveF->drainCursor(cF, cap);
  auto dI = liveI->drainCursor(cI, cap);
  liveF->releaseCursor(cF);
  liveI->releaseCursor(cI);
  ASSERT_EQ(dF.size(), static_cast<size_t>(cap));
  ASSERT_EQ(dI.size(), static_cast<size_t>(cap));
  for (int i = 0; i < cap; ++i) {
    EXPECT_FLOAT_EQ(dF[static_cast<size_t>(i)], dI[static_cast<size_t>(i)]) << "i=" << i;
  }

  ASSERT_TRUE(pa_finalize_live(idFloat, &errCode, &errMsg));
  ASSERT_TRUE(pa_finalize_live(idInt16, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(idFloat));
  EXPECT_TRUE(pa_release_buffer(idInt16));
}

// Bucket C #16: clone is one-copy; append offline→live uses floatPtr chunks.
TEST_F(AudioRegistryFixture, CloneOffline_AndAppendOfflineToLive) {
  std::string errCode, errMsg, json;
  std::vector<float> pcm(1000);
  for (size_t i = 0; i < pcm.size(); ++i) pcm[i] = static_cast<float>(i) * 0.001f;
  ASSERT_TRUE(pa_create_offline_from_samples(pcm.data(), pcm.size(), 16000, 1, &json, &errCode,
                                             &errMsg))
      << errMsg;
  const std::string srcId = bufferIdFromCreateJson(json);
  ASSERT_FALSE(srcId.empty());

  std::string clonedId;
  ASSERT_TRUE(pa_clone_offline(srcId, &clonedId, &errCode, &errMsg)) << errMsg;
  auto src = pa_get_offline_entry(srcId);
  auto cloned = pa_get_offline_entry(clonedId);
  ASSERT_NE(src, nullptr);
  ASSERT_NE(cloned, nullptr);
  EXPECT_EQ(cloned->numSamples(), src->numSamples());
  EXPECT_EQ(cloned->sampleRate, src->sampleRate);
  ASSERT_NE(cloned->floatPtr(), nullptr);
  EXPECT_FLOAT_EQ(cloned->floatPtr()[10], pcm[10]);

  std::string liveId;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &liveId, &errCode, &errMsg)) << errMsg;
  ASSERT_TRUE(pa_append_offline_to_live(liveId, clonedId, &errCode, &errMsg)) << errMsg;
  auto live = pa_get_live_entry(liveId);
  ASSERT_NE(live, nullptr);
  EXPECT_EQ(live->totalSamplesWritten, static_cast<int64_t>(pcm.size()));

  ASSERT_TRUE(pa_finalize_live(liveId, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(liveId));
  EXPECT_TRUE(pa_release_buffer(clonedId));
  EXPECT_TRUE(pa_release_buffer(srcId));
}

// Bucket C #13: listener may remove itself during notify without deadlocking on listener mutex.
TEST_F(AudioRegistryFixture, AppendListener_SelfRemoveDuringNotify) {
  std::string id;
  std::string errCode;
  std::string errMsg;
  ASSERT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &errCode, &errMsg)) << errMsg;

  auto live = pa_get_live_entry(id);
  ASSERT_NE(live, nullptr);

  std::atomic<int> fires{0};
  int token = -1;
  token = live->addAppendListener([&]() {
    fires.fetch_add(1);
    live->removeAppendListener(token);
  });
  EXPECT_EQ(live->appendListenerCount(), 1u);

  std::vector<float> chunk(80, 0.1f);
  ASSERT_TRUE(pa_append_samples_to_live(id, chunk.data(), chunk.size(), 16000, &errCode, &errMsg))
      << errMsg;
  EXPECT_EQ(fires.load(), 1);
  EXPECT_EQ(live->appendListenerCount(), 0u);

  ASSERT_TRUE(pa_append_samples_to_live(id, chunk.data(), chunk.size(), 16000, &errCode, &errMsg))
      << errMsg;
  EXPECT_EQ(fires.load(), 1);

  ASSERT_TRUE(pa_finalize_live(id, &errCode, &errMsg));
  EXPECT_TRUE(pa_release_buffer(id));
}
