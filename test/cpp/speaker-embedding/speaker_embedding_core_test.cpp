#include "speaker-embedding-registry-key.h"
#include "speaker-embedding-types.h"

#include <gtest/gtest.h>

#include <unordered_map>

using namespace sherpaonnx::speaker_embedding;

TEST(SpeakerEmbeddingRegistryKey, SameOptionsProduceEqualKeys) {
  EmbeddingRunnerOptions a;
  a.model_path = "/models/emb.onnx";
  a.provider = "cpu";
  a.num_threads = 2;
  a.debug = false;

  EmbeddingRunnerOptions b = a;
  EXPECT_EQ(MakeRegistryKey(a), MakeRegistryKey(b));
  EXPECT_EQ(RegistryKeyHash{}(MakeRegistryKey(a)),
            RegistryKeyHash{}(MakeRegistryKey(b)));
}

TEST(SpeakerEmbeddingRegistryKey, EmptyProviderNormalizesToCpu) {
  EmbeddingRunnerOptions a;
  a.model_path = "/models/emb.onnx";
  a.provider = "";
  a.num_threads = 1;

  EmbeddingRunnerOptions b = a;
  b.provider = "cpu";

  EXPECT_EQ(MakeRegistryKey(a), MakeRegistryKey(b));
  EXPECT_EQ(MakeRegistryKey(a).provider, "cpu");
}

TEST(SpeakerEmbeddingRegistryKey, NumThreadsClampedToAtLeastOne) {
  EmbeddingRunnerOptions opts;
  opts.model_path = "/models/emb.onnx";
  opts.num_threads = 0;
  EXPECT_EQ(MakeRegistryKey(opts).num_threads, 1);

  opts.num_threads = -3;
  EXPECT_EQ(MakeRegistryKey(opts).num_threads, 1);
}

TEST(SpeakerEmbeddingRegistryKey, DebugIsPartOfKey) {
  EmbeddingRunnerOptions a;
  a.model_path = "/models/emb.onnx";
  a.provider = "cpu";
  a.num_threads = 1;
  a.debug = false;

  EmbeddingRunnerOptions b = a;
  b.debug = true;

  EXPECT_FALSE(MakeRegistryKey(a) == MakeRegistryKey(b));

  std::unordered_map<RegistryKey, int, RegistryKeyHash> map;
  map[MakeRegistryKey(a)] = 1;
  map[MakeRegistryKey(b)] = 2;
  EXPECT_EQ(map.size(), 2u);
  EXPECT_EQ(map[MakeRegistryKey(a)], 1);
  EXPECT_EQ(map[MakeRegistryKey(b)], 2);
}

TEST(SpeakerEmbeddingRegistryKey, DifferentModelPathsDoNotCollide) {
  EmbeddingRunnerOptions a;
  a.model_path = "/models/a.onnx";
  EmbeddingRunnerOptions b;
  b.model_path = "/models/b.onnx";
  EXPECT_FALSE(MakeRegistryKey(a) == MakeRegistryKey(b));
}

TEST(SpeakerEmbeddingStatus, FailCarriesCodeAndMessage) {
  auto st = Status::Fail(kErrInvalidArgument, "bad arg");
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.code, kErrInvalidArgument);
  EXPECT_EQ(st.message, "bad arg");
  EXPECT_TRUE(Status::Ok().ok);
}
