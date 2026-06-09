#include "sherpa-onnx-model-detect.h"

#include <gtest/gtest.h>
#include <optional>
#include <string>
#include <vector>

using sherpaonnx::DetectTtsModel;
using sherpaonnx::PublicLanguageRow;
using sherpaonnx::TtsModelKind;

namespace {

static sherpaonnx::TtsDetectResult DetectNameOnly(const std::string& assetId) {
    return DetectTtsModel(std::nullopt, std::optional<std::string>(assetId), "auto");
}

std::vector<PublicLanguageRow> RowsFromHints(const std::vector<std::string>& hints) {
    std::vector<PublicLanguageRow> out;
    out.reserve(hints.size());
    for (const auto& hint : hints) {
        out.push_back(PublicLanguageRow{hint, hint});
    }
    return out;
}

} // namespace

TEST(TtsCatalogHints, MatchesDeriveLanguagesParityCases) {
    auto r = DetectNameOnly("vits-piper-nl_BE-rdh-medium");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"nl"}));

    r = DetectNameOnly("vits-piper-en_GB-sweetbbak-amy");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"en"}));

    r = DetectNameOnly("vits-piper-fa_en-rezahedayatfar-ibrahimwalk-medium");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"fa", "en"}));

    r = DetectNameOnly("vits-coqui-pt-cv");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"pt"}));

    r = DetectNameOnly("vits-coqui-uk-mai");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"uk"}));

    r = DetectNameOnly("vits-coqui-en-ljspeech-neon");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"en"}));

    r = DetectNameOnly("vits-coqui-de-css10");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"de"}));

    r = DetectNameOnly("vits-mms-eng");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"en"}));

    r = DetectNameOnly("vits-mms-spa");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"es"}));

    r = DetectNameOnly("vits-mms-nan");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"nan"}));

    r = DetectNameOnly("vits-piper-en_US-glados");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"en"}));

    r = DetectNameOnly("matcha-icefall-zh-en");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"zh", "en"}));

    r = DetectNameOnly("vits-zh-hf-bronya");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"zh"}));

    r = DetectNameOnly("sherpa-onnx-vits-zh-ll");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"zh"}));
}

TEST(TtsCatalogHints, PrimaryKindFromNameOnly) {
    auto r = DetectNameOnly("vits-piper-en_US-lessac-medium");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kVits);
    r = DetectNameOnly("kokoro-multi-lang-v1_0");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kKokoro);
}

TEST(TtsCatalogHints, QuantizationAndSizeTier) {
    auto r = DetectNameOnly("vits-piper-ka_GE-natia-medium-int8");
    EXPECT_EQ(r.quantization, "int8");
    r = DetectNameOnly("vits-piper-ka_GE-natia-medium-fp16");
    EXPECT_EQ(r.quantization, "fp16");
    r = DetectNameOnly("vits-piper-en_US-lessac-medium");
    EXPECT_EQ(r.sizeTier, "medium");
}

TEST(TtsCatalogHints, SequentialNameOnlyMatchesBatchParity) {
    std::vector<std::string> ids = {"vits-mms-eng", "kokoro-en-v0_19", "zzz-no-known-tts-token"};
    auto a = DetectNameOnly(ids[0]);
    EXPECT_EQ(a.derivedLanguages, RowsFromHints({"en"}));
    EXPECT_EQ(a.selectedKind, TtsModelKind::kVits);

    auto b = DetectNameOnly(ids[1]);
    EXPECT_EQ(b.selectedKind, TtsModelKind::kKokoro);
}
