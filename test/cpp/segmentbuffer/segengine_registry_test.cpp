/**
 * Host tests for shared SegEngine (no ORT, no device).
 *
 * Always-on: attach/detach, text_synthetic_auto, speech_energy_silence, continuous_frames.
 * Built with SHERPA_SEG_ENGINE_STUB_INFERENCE so VAD / pyannote stay unlinked.
 *
 * Build: cmake -S test/cpp -B test/cpp/build && cmake --build test/cpp/build --target segengine_host_test
 */
#include "AudioRegistry.h"
#include "SegEngine.h"
#include "SegmentRegistry.h"
#include "TextRegistry.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <filesystem>
#include <string>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

namespace {

class SegEngineFixture : public ::testing::Test {
 protected:
  void SetUp() override {
    cacheDir_ = fs::temp_directory_path() / ("segengine_host_" + std::to_string(::getpid()));
    fs::create_directories(cacheDir_);
    const std::string cache = cacheDir_.string();
    txt_configure_cache_dir(cache);
    pa_configure_cache_dir(cache);
    pa_configure_threshold(4ULL * 1024ULL * 1024ULL * 1024ULL);
    seg_configure_cache_dir(cache);
  }

  void TearDown() override {
    seg_engine_release_all();
    txt_release_all_entries();
    seg_release_all_entries();
    std::error_code ec;
    fs::remove_all(cacheDir_, ec);
  }

  std::string makeLiveText() {
    std::string id;
    std::string err;
    EXPECT_TRUE(txt_create_live(4096, 64, false, 0, "off", "", false, &id, &err)) << err;
    return id;
  }

  std::string makeLiveAudio() {
    std::string id;
    std::string code;
    std::string err;
    EXPECT_TRUE(pa_create_live(16000, 1, 2.0, "", false, 0, &id, &code, &err)) << err;
    return id;
  }

  fs::path cacheDir_;
};

TEST_F(SegEngineFixture, AttachDetachAndRejectDuplicate) {
  const std::string bufferId = makeLiveText();
  ASSERT_FALSE(bufferId.empty());
  SegEnginePolicy policy;
  policy.evaluator = "text_synthetic_auto";
  policy.sentenceBoundary = false;
  policy.maxLengthChars = 32;
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_attach(bufferId, "text", policy, &info, &code, &error)) << error;
  EXPECT_FALSE(info.engineId.empty());
  EXPECT_EQ(info.domain, "text");
  EXPECT_EQ(info.state, "active");
  EXPECT_EQ(info.attachedBufferId, bufferId);

  SegEngineInfoSnapshot again;
  EXPECT_FALSE(seg_engine_attach(bufferId, "text", policy, &again, &code, &error));
  EXPECT_EQ(code, "ENGINE_ALREADY_ATTACHED");

  SegEngineInfoSnapshot fetched;
  ASSERT_TRUE(seg_engine_get_info(info.engineId, &fetched, &code, &error)) << error;
  EXPECT_EQ(fetched.engineId, info.engineId);

  EXPECT_FALSE(seg_engine_detach("missing-engine", false, &error));
  ASSERT_TRUE(seg_engine_detach(info.engineId, false, &error)) << error;
  ASSERT_TRUE(seg_engine_get_info(info.engineId, &fetched, &code, &error));
  EXPECT_EQ(fetched.state, "detached");
  EXPECT_FALSE(seg_engine_detach(info.engineId, false, &error));
}

TEST_F(SegEngineFixture, TextSyntheticCommitsOnLength) {
  const std::string bufferId = makeLiveText();
  SegEnginePolicy policy;
  policy.evaluator = "text_synthetic_auto";
  policy.sentenceBoundary = false;
  policy.maxLengthChars = 5;
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_attach(bufferId, "text", policy, &info, &code, &error)) << error;

  auto live = txt_get_live_entry(bufferId);
  ASSERT_TRUE(live);
  live->writePartial("abcdefgh");
  EXPECT_EQ(live->segmentCount(), 1);
  EXPECT_EQ(live->snapshotText(), "fgh");

  ASSERT_TRUE(seg_engine_flush(info.engineId, &error));
  EXPECT_EQ(live->segmentCount(), 2);
  EXPECT_TRUE(live->snapshotText().empty());

  SegEngineInfoSnapshot fetched;
  ASSERT_TRUE(seg_engine_get_info(info.engineId, &fetched, &code, &error));
  EXPECT_GE(fetched.totalSegmentsCommitted, 2);
}

TEST_F(SegEngineFixture, TextSyntheticCommitsOnSentenceBoundary) {
  const std::string bufferId = makeLiveText();
  SegEnginePolicy policy;
  policy.evaluator = "text_synthetic_auto";
  policy.sentenceBoundary = true;
  policy.maxLengthChars = 200;
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_attach(bufferId, "text", policy, &info, &code, &error)) << error;
  auto live = txt_get_live_entry(bufferId);
  ASSERT_TRUE(live);
  live->writePartial("Hi. There");
  EXPECT_EQ(live->segmentCount(), 1);
  EXPECT_EQ(live->snapshotText(), " There");
}

TEST_F(SegEngineFixture, SpeechEnergySilenceCommitsQuietAudio) {
  const std::string bufferId = makeLiveAudio();
  ASSERT_FALSE(bufferId.empty());
  SegEnginePolicy policy;
  policy.evaluator = "speech_energy_silence";
  policy.minSegmentMs = 100;
  policy.maxSegmentMs = 10000;
  policy.silenceThresholdMs = 50;
  policy.hangoverMs = 0;
  policy.energyThresholdDb = 0.0;
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_attach(bufferId, "speech", policy, &info, &code, &error)) << error;
  EXPECT_FALSE(info.segmentBufferId.empty());

  std::vector<float> silence(1600, 0.0f);
  std::string appendCode;
  std::string appendError;
  ASSERT_TRUE(pa_append_samples_to_live(bufferId, silence.data(), silence.size(), 16000, &appendCode,
                                        &appendError))
      << appendError;

  auto seg = seg_get_live_entry(info.segmentBufferId);
  ASSERT_TRUE(seg);
  const auto records = seg->snapshotWindow();
  ASSERT_EQ(records.size(), 1u);
  std::string reason;
  std::string source;
  int64_t createdAtMs = 0;
  int segmentIndex = -1;
  ASSERT_TRUE(seg_engine_peek_annotation(records[0].id, &reason, &source, &createdAtMs, &segmentIndex));
  EXPECT_EQ(reason, "energy_silence");
  EXPECT_EQ(source, "segmentation_engine");
}

TEST_F(SegEngineFixture, ContinuousFramesCheckpoint) {
  const std::string bufferId = makeLiveAudio();
  SegEnginePolicy policy;
  policy.evaluator = "continuous_frames";
  policy.checkpointIntervalMs = 100;
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_attach(bufferId, "speech", policy, &info, &code, &error)) << error;

  std::vector<float> samples(1600, 0.1f);
  std::string appendCode;
  std::string appendError;
  ASSERT_TRUE(pa_append_samples_to_live(bufferId, samples.data(), samples.size(), 16000, &appendCode,
                                        &appendError))
      << appendError;

  auto seg = seg_get_live_entry(info.segmentBufferId);
  ASSERT_TRUE(seg);
  const auto records = seg->snapshotWindow();
  ASSERT_EQ(records.size(), 1u);
  std::string reason;
  ASSERT_TRUE(seg_engine_peek_annotation(records[0].id, &reason, nullptr, nullptr, nullptr));
  EXPECT_EQ(reason, "policy_checkpoint");
}

TEST_F(SegEngineFixture, OfflineTextSynthetic) {
  std::string bufferId;
  std::string err;
  ASSERT_TRUE(txt_create_offline_from_text("Hello. World", "", "", "", &bufferId, &err)) << err;
  SegEnginePolicy policy;
  policy.evaluator = "text_synthetic_auto";
  policy.sentenceBoundary = true;
  policy.maxLengthChars = 200;
  std::vector<SegOfflineTextSegment> segments;
  std::string outId;
  int count = 0;
  std::string code;
  std::string error;
  ASSERT_TRUE(seg_engine_segment_offline(bufferId, "text", policy, &segments, &outId, &count, &code,
                                         &error))
      << error;
  EXPECT_EQ(outId, bufferId);
  EXPECT_GE(count, 2);
  ASSERT_GE(segments.size(), 2u);
  EXPECT_EQ(segments[0].text, "Hello.");
  EXPECT_EQ(segments[0].reason, "punctuation");
}

}  // namespace
