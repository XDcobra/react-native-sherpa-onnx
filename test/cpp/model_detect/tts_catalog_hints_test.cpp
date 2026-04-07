#include "sherpa-onnx-model-detect.h"

#include <gtest/gtest.h>
#include <string>
#include <vector>

using sherpaonnx::BatchDeriveTtsCatalogHints;
using sherpaonnx::DeriveTtsCatalogHintsFromModelId;

TEST(TtsCatalogHints, MatchesDeriveLanguagesParityCases) {
    auto h = DeriveTtsCatalogHintsFromModelId("vits-piper-nl_BE-rdh-medium");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"nl"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-piper-en_GB-sweetbbak-amy");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"en"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-piper-fa_en-rezahedayatfar-ibrahimwalk-medium");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"fa", "en"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-coqui-pt-cv");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"pt"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-coqui-uk-mai");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"uk"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-coqui-en-ljspeech-neon");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"en"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-coqui-de-css10");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"de"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-mms-eng");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"en"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-mms-spa");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"es"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-mms-nan");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"nan"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-piper-en_US-glados");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"en"}));

    h = DeriveTtsCatalogHintsFromModelId("matcha-icefall-zh-en");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"zh", "en"}));

    h = DeriveTtsCatalogHintsFromModelId("vits-zh-hf-bronya");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"zh"}));

    h = DeriveTtsCatalogHintsFromModelId("sherpa-onnx-vits-zh-ll");
    EXPECT_EQ(h.languages, (std::vector<std::string>{"zh"}));
}

TEST(TtsCatalogHints, PrimaryKindFromNameOnly) {
    auto h = DeriveTtsCatalogHintsFromModelId("vits-piper-en_US-lessac-medium");
    EXPECT_EQ(h.primaryKind, "vits");
    h = DeriveTtsCatalogHintsFromModelId("kokoro-multi-lang-v1_0");
    EXPECT_EQ(h.primaryKind, "kokoro");
}

TEST(TtsCatalogHints, QuantizationAndSizeTier) {
    auto h = DeriveTtsCatalogHintsFromModelId("vits-piper-ka_GE-natia-medium-int8");
    EXPECT_EQ(h.quantization, "int8");
    h = DeriveTtsCatalogHintsFromModelId("vits-piper-ka_GE-natia-medium-fp16");
    EXPECT_EQ(h.quantization, "fp16");
    h = DeriveTtsCatalogHintsFromModelId("vits-piper-en_US-lessac-medium");
    EXPECT_EQ(h.sizeTier, "medium");
}

TEST(TtsCatalogHints, BatchPreservesOrderAndCount) {
    std::vector<std::string> ids = {"vits-mms-eng", "kokoro-en-v0_19", "zzz-no-known-tts-token"};
    auto batch = BatchDeriveTtsCatalogHints(ids);
    ASSERT_EQ(batch.size(), 3u);
    EXPECT_EQ(batch[0].modelId, "vits-mms-eng");
    EXPECT_EQ(batch[0].languages, (std::vector<std::string>{"en"}));
    EXPECT_EQ(batch[1].primaryKind, "kokoro");
    EXPECT_EQ(batch[2].primaryKind, "unknown");
}
