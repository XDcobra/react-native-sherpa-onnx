#include "sortformer-streaming-model.h"
#include "sherpa-onnx-streaming-diarization-wrapper.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

namespace sherpaonnx::diarization {

TEST(SortformerCacheTest, UpdateSilenceProfileComputesRunningMeanForQuietFrames) {
  SortformerStreamingModel model;

  const int32_t emb_dim = 512;
  const int32_t num_spk = 4;

  // Frame 0: sum of probabilities = 0.05 < 0.2 (silence)
  // Frame 1: sum of probabilities = 0.90 > 0.2 (speech)
  // Frame 2: sum of probabilities = 0.10 < 0.2 (silence)
  std::vector<float> preds = {
    // Frame 0:
    0.01f, 0.01f, 0.01f, 0.02f, // sum = 0.05 -> silence
    // Frame 1:
    0.80f, 0.05f, 0.05f, 0.00f, // sum = 0.90 -> speech
    // Frame 2:
    0.02f, 0.02f, 0.03f, 0.03f  // sum = 0.10 -> silence
  };

  std::vector<float> embs(3 * emb_dim, 0.0f);
  // Frame 0 emb: all 1.0f
  for (int32_t d = 0; d < emb_dim; ++d) embs[0 * emb_dim + d] = 1.0f;
  // Frame 1 emb: all 10.0f
  for (int32_t d = 0; d < emb_dim; ++d) embs[1 * emb_dim + d] = 10.0f;
  // Frame 2 emb: all 3.0f
  for (int32_t d = 0; d < emb_dim; ++d) embs[2 * emb_dim + d] = 3.0f;

  model.TestUpdateSilenceProfile(embs.data(), preds.data(), 3);

  // Silence profile should only be updated from Frame 0 (1.0f) and Frame 2 (3.0f)
  // Expected mean = (1.0 + 3.0) / 2 = 2.0f
  auto snapshot = model.GetStateSnapshot();
  EXPECT_EQ(snapshot.n_sil_frames, 2);

  const auto& mean_sil = model.GetMeanSilEmb();
  ASSERT_EQ(mean_sil.size(), static_cast<size_t>(emb_dim));
  for (int32_t d = 0; d < emb_dim; ++d) {
    EXPECT_NEAR(mean_sil[d], 2.0f, 1e-4f);
  }
}

TEST(SortformerCacheTest, CacheCompressionKeepsTopSpeakerFramesAndBindsMemory) {
  SortformerStreamingModel model;

  const int32_t emb_dim = 512;
  const int32_t num_spk = 4;
  const int32_t cache_len = 188;

  // Setup cache overflow with 200 frames (> 188)
  const int32_t overflow_frames = 200;
  std::vector<float> cache_embs(overflow_frames * emb_dim, 0.5f);
  std::vector<float> cache_preds(overflow_frames * num_spk, 0.1f);

  // Set distinct speaker activations
  for (int32_t t = 0; t < 50; ++t) {
    cache_preds[t * num_spk + 0] = 0.95f; // Strong speaker 0
  }
  for (int32_t t = 50; t < 100; ++t) {
    cache_preds[t * num_spk + 1] = 0.95f; // Strong speaker 1
  }
  for (int32_t t = 100; t < 150; ++t) {
    cache_preds[t * num_spk + 2] = 0.95f; // Strong speaker 2
  }
  for (int32_t t = 150; t < 200; ++t) {
    cache_preds[t * num_spk + 3] = 0.95f; // Strong speaker 3
  }

  std::vector<float> mean_sil(emb_dim, 0.0f);
  model.TestSetState({}, 0, {}, cache_embs, overflow_frames, cache_preds, mean_sil, 0);

  EXPECT_EQ(model.GetStateSnapshot().spkcache_len, overflow_frames);

  // Trigger compression
  model.TestCompressCache();

  // Compressed cache MUST have exactly cache_len (188) frames!
  EXPECT_EQ(model.GetStateSnapshot().spkcache_len, cache_len);
  EXPECT_EQ(model.GetSpkCache().size(), static_cast<size_t>(cache_len * emb_dim));
  EXPECT_EQ(model.GetSpkCachePreds().size(), static_cast<size_t>(cache_len * num_spk));
}

TEST(StreamingDiarizationWrapperTest, UninitializedCallsReturnErrorSafely) {
  StreamingDiarizationWrapper wrapper;
  EXPECT_FALSE(wrapper.isInitialized());

  std::vector<float> samples(1024, 0.0f);
  auto res = wrapper.feed(samples.data(), samples.size());
  EXPECT_FALSE(res.success);
  EXPECT_EQ(res.errorCode, "NOT_INITIALIZED");

  auto flush_res = wrapper.flush();
  EXPECT_FALSE(flush_res.success);
  EXPECT_EQ(flush_res.errorCode, "NOT_INITIALIZED");

  // Reset and release on uninitialized wrapper should be no-ops and safe
  wrapper.reset();
  wrapper.release();
}

} // namespace sherpaonnx::diarization
