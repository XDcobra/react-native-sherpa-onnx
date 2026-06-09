#include "sherpa-onnx-model-detect.h"
#include "model_language_catalog.inc.h"

#include <gtest/gtest.h>
#include <algorithm>
#include <optional>
#include <string>
#include <vector>

using sherpaonnx::DetectSttModel;
using sherpaonnx::DetectTtsModel;
using sherpaonnx::DetectionSource;
using sherpaonnx::PublicLanguageRow;
using sherpaonnx::SttModelKind;
using sherpaonnx::TtsModelKind;

namespace {

static sherpaonnx::TtsDetectResult DetectTtsNameOnly(const std::string& assetId) {
    return DetectTtsModel(std::nullopt, std::optional<std::string>(assetId), "auto");
}

static sherpaonnx::SttDetectResult DetectSttNameOnly(const std::string& assetId) {
    return DetectSttModel(std::nullopt, std::optional<std::string>(assetId), "auto", std::nullopt, false);
}

bool HasHint(const std::vector<PublicLanguageRow>& rows, const std::string& hint) {
    return std::any_of(rows.begin(), rows.end(), [&](const PublicLanguageRow& row) {
        return row.iso6391Hint == hint;
    });
}

bool HasRow(
    const std::vector<PublicLanguageRow>& rows,
    const std::string& hint,
    const std::string& id) {
    return std::any_of(rows.begin(), rows.end(), [&](const PublicLanguageRow& row) {
        return row.iso6391Hint == hint && row.id == id;
    });
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

TEST(CuratedLanguageCatalog, Supertonic3NameOnlyGetsFullHintSet) {
    auto r = DetectTtsNameOnly("sherpa-onnx-supertonic-3-tts-int8-2026-05-11");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kSupertonic);
    ASSERT_FALSE(r.derivedLanguages.empty());
    EXPECT_TRUE(HasHint(r.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(r.derivedLanguages, "de"));
    EXPECT_TRUE(HasHint(r.derivedLanguages, "na"));
    EXPECT_EQ(r.derivedLanguages.size(), 32u);
    for (const auto& row : r.derivedLanguages) {
        EXPECT_EQ(row.id, row.iso6391Hint);
    }
    ASSERT_FALSE(r.detectionSources.empty());
    EXPECT_EQ(r.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(CuratedLanguageCatalog, LegacySupertonicGetsFiveLangSet) {
    auto r = DetectTtsNameOnly("sherpa-onnx-supertonic-tts-int8-2026-03-06");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kSupertonic);
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"en", "ko", "fr", "es", "pt"}));
}

TEST(CuratedLanguageCatalog, WhisperNameOnlyGetsCatalogHints) {
    auto r = DetectSttNameOnly("sherpa-onnx-whisper-tiny");
    ASSERT_FALSE(r.derivedLanguages.empty());
    EXPECT_TRUE(HasHint(r.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(r.derivedLanguages, "de"));
    ASSERT_FALSE(r.detectionSources.empty());
    EXPECT_EQ(r.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(CuratedLanguageCatalog, FunAsrNameOnlyGetsChineseModelOptionId) {
    auto r = DetectSttNameOnly("sherpa-onnx-funasr-nano");
    EXPECT_EQ(r.selectedKind, SttModelKind::kFunAsrNano);
    EXPECT_TRUE(HasRow(r.derivedLanguages, "zh", "中文"));
    EXPECT_TRUE(HasRow(r.derivedLanguages, "en", "英文"));
}

TEST(CuratedLanguageCatalog, ModelOptionIdForHintMapsFunAsrZh) {
    using sherpaonnx::model_language_catalog::ModelOptionIdForHint;
    EXPECT_EQ(ModelOptionIdForHint("funasr_nano", "zh"), "中文");
    EXPECT_EQ(ModelOptionIdForHint("whisper", "en"), "en");
}

TEST(CuratedLanguageCatalog, FilenameHeuristicsWinOverCatalog) {
    auto r = DetectTtsNameOnly("vits-piper-nl_BE-rdh-medium");
    EXPECT_EQ(r.derivedLanguages, RowsFromHints({"nl"}));
    for (const auto src : r.detectionSources) {
        EXPECT_NE(src, DetectionSource::kCuratedCatalog);
    }
}
