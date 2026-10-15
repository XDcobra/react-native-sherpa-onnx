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

TEST(CuratedLanguageCatalog, AlignmentWav2Vec2GetsEnglishHint) {
    using sherpaonnx::DetectAlignmentModelFromFileList;
    using sherpaonnx::model_detect::FileEntry;

    FileEntry modelFile;
    modelFile.path = "wav2vec2-base-960h-int8/model.int8.onnx";
    modelFile.name = "model.int8.onnx";
    modelFile.nameLower = "model.int8.onnx";
    modelFile.size = 1024;

    // Successful detect with no language tokens in the folder name → curated en.
    auto ok = DetectAlignmentModelFromFileList(
        {modelFile}, "wav2vec2-base-960h-int8", "wav2vec2", "int8");
    EXPECT_TRUE(ok.ok);
    EXPECT_EQ(ok.derivedLanguages, RowsFromHints({"en"}));
    ASSERT_FALSE(ok.detectionSources.empty());
    EXPECT_EQ(ok.detectionSources.back(), DetectionSource::kCuratedCatalog);

    // Name-only (empty listing): infer wav2vec2 from model key → curated en.
    auto nameOnly = DetectAlignmentModelFromFileList(
        {}, "wav2vec2-base-960h-int8", "auto", "");
    EXPECT_FALSE(nameOnly.ok);
    EXPECT_EQ(nameOnly.derivedLanguages, RowsFromHints({"en"}));
    ASSERT_FALSE(nameOnly.detectionSources.empty());
    EXPECT_EQ(nameOnly.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(CuratedLanguageCatalog, OcrPpocrv6TinyGetsPackHints) {
    using sherpaonnx::DetectOcrModelFromFileList;
    using sherpaonnx::model_detect::FileEntry;
    using sherpaonnx::OcrModelKind;

    FileEntry det;
    det.path = "ppocrv6-tiny/det.onnx";
    det.name = "det.onnx";
    det.nameLower = "det.onnx";
    det.size = 1024;
    FileEntry rec;
    rec.path = "ppocrv6-tiny/rec.onnx";
    rec.name = "rec.onnx";
    rec.nameLower = "rec.onnx";
    rec.size = 1024;
    FileEntry dict;
    dict.path = "ppocrv6-tiny/rec_inference.yml";
    dict.name = "rec_inference.yml";
    dict.nameLower = "rec_inference.yml";
    dict.size = 128;

    // Successful detect with no ISO tokens in the pack id → curated pack CSV.
    // PP-OCRv6 tiny: zh/en + 46 Latin (~48 ISO); no Japanese.
    auto ok = DetectOcrModelFromFileList(
        {det, rec, dict}, "ppocrv6-tiny", "ppocr", "");
    EXPECT_TRUE(ok.ok);
    EXPECT_EQ(ok.selectedKind, OcrModelKind::kPpocr);
    ASSERT_GE(ok.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "zh"));
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "de"));
    EXPECT_FALSE(HasHint(ok.derivedLanguages, "ja"));
    ASSERT_FALSE(ok.detectionSources.empty());
    EXPECT_EQ(ok.detectionSources.back(), DetectionSource::kCuratedCatalog);

    // Name-only (empty listing): infer ppocr from model key → pack hints.
    auto nameOnly = DetectOcrModelFromFileList({}, "ppocrv6-tiny", "auto", "");
    EXPECT_FALSE(nameOnly.ok);
    ASSERT_GE(nameOnly.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(nameOnly.derivedLanguages, "zh"));
    EXPECT_FALSE(HasHint(nameOnly.derivedLanguages, "ja"));
    ASSERT_FALSE(nameOnly.detectionSources.empty());
    EXPECT_EQ(nameOnly.detectionSources.back(), DetectionSource::kCuratedCatalog);

    // small/medium packs include ja (+ same Latin set).
    auto small = DetectOcrModelFromFileList({}, "ppocrv6-small", "auto", "");
    ASSERT_GE(small.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(small.derivedLanguages, "zh"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "ja"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "fr"));
}

TEST(CuratedLanguageCatalog, OcrDoctrFamilyRowsNonEmpty) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrRowsForModelType("doctr");
    ASSERT_FALSE(rows.empty()) << "OcrRowsForModelType(\"doctr\") should return family hints";
    bool hasEn = false;
    for (const auto& r : rows) {
        if (r.iso6391Hint == "en") hasEn = true;
    }
    EXPECT_TRUE(hasEn);
}

TEST(CuratedLanguageCatalog, OcrDoctrPackRowsForKnownIds) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& mobile = OcrPackRowsForModelKey("doctr-mobile");
    ASSERT_FALSE(mobile.empty());
    EXPECT_EQ(mobile.size(), 2u);

    const auto& dflt = OcrPackRowsForModelKey("doctr-default");
    ASSERT_FALSE(dflt.empty());
    EXPECT_EQ(dflt.size(), 15u);
}
