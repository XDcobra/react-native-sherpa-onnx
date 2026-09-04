#include "powerset.h"
#include "agglomerative-clustering.h"
#include "speaker-timeline.h"

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

using namespace sherpaonnx::diarization;

TEST(DiarizationPowerset, ExpectedClassesMatchesPyannoteFormula) {
  // empty + C(n,1) + ... + C(n,k)
  EXPECT_EQ(PowersetDecoder::ExpectedNumClasses(3, 2), 7);
  EXPECT_EQ(PowersetDecoder::ExpectedNumClasses(3, 1), 4);
  EXPECT_EQ(PowersetDecoder::ExpectedNumClasses(4, 2), 11);
  EXPECT_EQ(PowersetDecoder::ExpectedNumClasses(2, 2), 4);
}

TEST(DiarizationPowerset, MappingOrderForThreeSpeakersMaxTwo) {
  PowersetDecoder decoder;
  auto st = decoder.Init(3, 2, 7);
  ASSERT_TRUE(st.ok) << st.message;
  ASSERT_EQ(decoder.numClasses(), 7);
  ASSERT_EQ(decoder.numSpeakers(), 3);

  const auto& map = decoder.mapping();
  auto row = [&](int c) {
    return std::vector<int8_t>{map[c * 3 + 0], map[c * 3 + 1], map[c * 3 + 2]};
  };

  // class 0 = empty
  EXPECT_EQ(row(0), (std::vector<int8_t>{0, 0, 0}));
  // singles
  EXPECT_EQ(row(1), (std::vector<int8_t>{1, 0, 0}));
  EXPECT_EQ(row(2), (std::vector<int8_t>{0, 1, 0}));
  EXPECT_EQ(row(3), (std::vector<int8_t>{0, 0, 1}));
  // pairs
  EXPECT_EQ(row(4), (std::vector<int8_t>{1, 1, 0}));
  EXPECT_EQ(row(5), (std::vector<int8_t>{1, 0, 1}));
  EXPECT_EQ(row(6), (std::vector<int8_t>{0, 1, 1}));
}

TEST(DiarizationPowerset, SupportsMaxClassesThree) {
  PowersetDecoder decoder;
  // C(3,0)+C(3,1)+C(3,2)+C(3,3) = 1+3+3+1 = 8
  auto st = decoder.Init(3, 3, 8);
  ASSERT_TRUE(st.ok) << st.message;
  EXPECT_EQ(decoder.numClasses(), 8);
  const auto& map = decoder.mapping();
  // last class = all three speakers
  EXPECT_EQ(map[7 * 3 + 0], 1);
  EXPECT_EQ(map[7 * 3 + 1], 1);
  EXPECT_EQ(map[7 * 3 + 2], 1);
}

TEST(DiarizationPowerset, RejectsInconsistentNumClasses) {
  PowersetDecoder decoder;
  auto st = decoder.Init(3, 2, 99);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.code, kErrMetadata);
}

TEST(DiarizationPowerset, DecodeArgmaxDeterministicTieBreak) {
  PowersetDecoder decoder;
  ASSERT_TRUE(decoder.Init(2, 1, 3).ok);
  // 1 frame, 3 classes — equal scores → class 0 wins
  std::vector<float> logits = {1.f, 1.f, 1.f};
  auto labels = decoder.Decode(logits.data(), 1, 3);
  ASSERT_EQ(labels.rows, 1);
  ASSERT_EQ(labels.cols, 2);
  EXPECT_EQ(labels.at(0, 0), 0);
  EXPECT_EQ(labels.at(0, 1), 0);
}

TEST(DiarizationClustering, TwoWellSeparatedPoints) {
  AgglomerativeClusterer clusterer(ClusteringConfig{-1, 0.5f});
  // Two opposite unit vectors → cosine dissimilarity ≈ 2
  float features[] = {1.f, 0.f, -1.f, 0.f};
  auto labels = clusterer.Cluster(features, 2, 2);
  ASSERT_EQ(labels.size(), 2u);
  EXPECT_NE(labels[0], labels[1]);
}

TEST(DiarizationClustering, CutreeKForcesClusterCount) {
  AgglomerativeClusterer clusterer(ClusteringConfig{2, 0.01f});
  float features[] = {
      1.f, 0.f, 0.9f, 0.1f, 0.f, 1.f, 0.1f, 0.9f,
  };
  auto labels = clusterer.Cluster(features, 4, 2);
  ASSERT_EQ(labels.size(), 4u);
  int32_t max_label = 0;
  for (int32_t l : labels) {
    max_label = std::max(max_label, l);
  }
  EXPECT_EQ(max_label, 1);
}

TEST(DiarizationTimeline, ExcludeOverlapZerosMultiSpeakerFrames) {
  Int8Matrix m;
  m.resize(2, 2, 0);
  m.at(0, 0) = 1;
  m.at(0, 1) = 1;  // overlap
  m.at(1, 0) = 1;  // single
  auto out = ExcludeOverlap({m});
  ASSERT_EQ(out.size(), 1u);
  EXPECT_EQ(out[0].at(0, 0), 0);
  EXPECT_EQ(out[0].at(0, 1), 0);
  EXPECT_EQ(out[0].at(1, 0), 1);
}

TEST(DiarizationTimeline, ComputeResultMergesAndFilters) {
  Int8Matrix labels;
  labels.resize(4, 1, 0);
  labels.at(0, 0) = 1;
  labels.at(1, 0) = 1;
  labels.at(2, 0) = 0;
  labels.at(3, 0) = 1;

  TimelineConfig cfg;
  cfg.meta.sample_rate = 16000;
  cfg.meta.receptive_field_shift = 160;  // 10 ms
  cfg.meta.receptive_field_size = 160;
  cfg.meta.window_size = 16000;
  cfg.meta.window_shift = 1600;
  cfg.min_duration_on = 0.0f;
  cfg.min_duration_off = 1.0f;  // merge across the gap

  auto segs = ComputeResult(labels, cfg);
  ASSERT_EQ(segs.size(), 1u);
  EXPECT_EQ(segs[0].speaker, 0);
  EXPECT_GT(segs[0].end, segs[0].start);
}

TEST(DiarizationTimeline, SpeechUnionLabelsMarksSpeechFrames) {
  std::vector<int32_t> speakers_per_frame = {0, 1, 2, 0, 1};
  auto union_labels = SpeechUnionLabels(speakers_per_frame);
  ASSERT_EQ(union_labels.rows, 5);
  ASSERT_EQ(union_labels.cols, 1);
  EXPECT_EQ(union_labels.at(0, 0), 0);
  EXPECT_EQ(union_labels.at(1, 0), 1);
  EXPECT_EQ(union_labels.at(2, 0), 1);
  EXPECT_EQ(union_labels.at(3, 0), 0);
  EXPECT_EQ(union_labels.at(4, 0), 1);

  TimelineConfig cfg;
  cfg.meta.sample_rate = 16000;
  cfg.meta.receptive_field_shift = 160;
  cfg.meta.receptive_field_size = 160;
  cfg.meta.window_size = 16000;
  cfg.meta.window_shift = 1600;
  cfg.min_duration_on = 0.0f;
  cfg.min_duration_off = 0.0f;

  auto segs = ComputeResult(union_labels, cfg);
  ASSERT_EQ(segs.size(), 2u);
  EXPECT_EQ(segs[0].speaker, 0);
  EXPECT_EQ(segs[1].speaker, 0);
  EXPECT_GT(segs[0].end, segs[0].start);
  EXPECT_GT(segs[1].end, segs[1].start);
}
