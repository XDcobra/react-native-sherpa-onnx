#include "sherpa-onnx-model-detect.h"
#include "model_language_catalog.inc.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cctype>
#include <optional>
#include <ostream>
#include <string>
#include <vector>

using sherpaonnx::DetectAlignmentModelFromFileList;
using sherpaonnx::DetectDiarizationModel;
using sherpaonnx::DetectOcrModelFromFileList;
using sherpaonnx::DetectSpeakerEmbeddingModel;
using sherpaonnx::DetectSttModel;
using sherpaonnx::DetectTtsModel;
using sherpaonnx::DetectionSource;
using sherpaonnx::OcrModelKind;
using sherpaonnx::PublicLanguageRow;
using sherpaonnx::SttModelKind;
using sherpaonnx::TtsModelKind;
using sherpaonnx::model_detect::FileEntry;

namespace {

enum class LanguageHintDomain {
    kTts,
    kStt,
    kSpeakerEmbedding,
    kDiarization,
};

const char* LanguageHintDomainName(LanguageHintDomain domain) {
    switch (domain) {
        case LanguageHintDomain::kTts:
            return "tts";
        case LanguageHintDomain::kStt:
            return "stt";
        case LanguageHintDomain::kSpeakerEmbedding:
            return "speakerEmbedding";
        case LanguageHintDomain::kDiarization:
            return "diarization";
    }
    return "unknown";
}

std::vector<PublicLanguageRow> RowsFromHints(const std::vector<std::string>& hints) {
    std::vector<PublicLanguageRow> out;
    out.reserve(hints.size());
    for (const auto& hint : hints) {
        out.push_back(PublicLanguageRow{hint, hint});
    }
    return out;
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

std::vector<PublicLanguageRow> DetectNameOnlyLanguages(
    LanguageHintDomain domain,
    const std::string& assetId) {
    switch (domain) {
        case LanguageHintDomain::kTts:
            return DetectTtsModel(std::nullopt, std::optional<std::string>(assetId), "auto")
                .derivedLanguages;
        case LanguageHintDomain::kStt:
            return DetectSttModel(
                       std::nullopt,
                       std::optional<std::string>(assetId),
                       "auto",
                       std::nullopt,
                       false)
                .derivedLanguages;
        case LanguageHintDomain::kSpeakerEmbedding:
            return DetectSpeakerEmbeddingModel(
                       std::nullopt, std::optional<std::string>(assetId), "auto")
                .derivedLanguages;
        case LanguageHintDomain::kDiarization:
            return DetectDiarizationModel(
                       std::nullopt, std::optional<std::string>(assetId), "auto")
                .derivedLanguages;
    }
    return {};
}

struct NameOnlyLanguageHintCase {
    LanguageHintDomain domain;
    const char* assetId;
    std::vector<std::string> expectedHints;
    // When true, curated catalog must not appear in TTS detectionSources.
    bool forbidCuratedSource = false;
};

void PrintTo(const NameOnlyLanguageHintCase& value, std::ostream* os) {
    *os << LanguageHintDomainName(value.domain) << "/" << value.assetId;
}

class NameOnlyLanguageHints
    : public ::testing::TestWithParam<NameOnlyLanguageHintCase> {};

} // namespace

TEST_P(NameOnlyLanguageHints, MatchesExpectedHints) {
    const auto& param = GetParam();
    const auto actual = DetectNameOnlyLanguages(param.domain, param.assetId);
    EXPECT_EQ(actual, RowsFromHints(param.expectedHints));

    if (param.forbidCuratedSource) {
        ASSERT_EQ(param.domain, LanguageHintDomain::kTts);
        const auto result =
            DetectTtsModel(std::nullopt, std::optional<std::string>(param.assetId), "auto");
        for (const auto src : result.detectionSources) {
            EXPECT_NE(src, DetectionSource::kCuratedCatalog);
        }
    }
}

INSTANTIATE_TEST_SUITE_P(
    ModelLanguageCatalog,
    NameOnlyLanguageHints,
    ::testing::Values(
        // TTS heuristic parity
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "vits-piper-nl_BE-rdh-medium", {"nl"}, true},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "vits-piper-en_GB-sweetbbak-amy", {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts,
            "vits-piper-fa_en-rezahedayatfar-ibrahimwalk-medium",
            {"fa", "en"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-coqui-pt-cv", {"pt"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-coqui-uk-mai", {"uk"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "vits-coqui-en-ljspeech-neon", {"en"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-coqui-de-css10", {"de"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-mms-eng", {"en"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-mms-spa", {"es"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-mms-nan", {"nan"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-piper-en_US-glados", {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "matcha-icefall-zh-en", {"zh", "en"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "vits-zh-hf-bronya", {"zh"}},
        NameOnlyLanguageHintCase{LanguageHintDomain::kTts, "sherpa-onnx-vits-zh-ll", {"zh"}},
        // TTS curated pocket / legacy supertonic
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "sherpa-onnx-pocket-tts-2026-01-26", {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts, "sherpa-onnx-pocket-tts-int8-2026-01-26", {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kTts,
            "sherpa-onnx-supertonic-tts-int8-2026-03-06",
            {"en", "ko", "fr", "es", "pt"}},
        // Speaker embedding curated (replace heuristics)
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_campplus_sv_en_voxceleb_16k",
            {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
            {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_eres2net_sv_en_voxceleb_16k",
            {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_campplus_sv_zh-cn_16k-common",
            {"zh"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common",
            {"zh"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "wespeaker_zh_cnceleb_resnet34",
            {"zh"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
            {"zh", "en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding, "nemo_en_titanet_small", {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "nemo_en_speakerverification_speakernet",
            {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding,
            "wespeaker_en_voxceleb_resnet34",
            {"en"}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kSpeakerEmbedding, "wespeaker_en_voxceleb_CAM++", {"en"}},
        // Diarization segmentation is language-agnostic
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kDiarization,
            "sherpa-onnx-pyannote-segmentation-3-0",
            {}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kDiarization, "sherpa-onnx-reverb-diarization-v1", {}},
        NameOnlyLanguageHintCase{
            LanguageHintDomain::kDiarization, "sherpa-onnx-reverb-diarization-v2", {}}),
    [](const ::testing::TestParamInfo<NameOnlyLanguageHintCase>& info) {
        std::string name = LanguageHintDomainName(info.param.domain);
        name.push_back('_');
        for (char c : std::string(info.param.assetId)) {
            if (std::isalnum(static_cast<unsigned char>(c))) {
                name.push_back(c);
            } else {
                name.push_back('_');
            }
        }
        return name;
    });

// --- Non-tabular edge cases (subset asserts, kind/quant, OCR/alignment maps) ---

TEST(ModelLanguageCatalogHints, TtsPrimaryKindFromNameOnly) {
    auto r = DetectTtsModel(
        std::nullopt, std::optional<std::string>("vits-piper-en_US-lessac-medium"), "auto");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kVits);
    r = DetectTtsModel(
        std::nullopt, std::optional<std::string>("kokoro-multi-lang-v1_0"), "auto");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kKokoro);
}

TEST(ModelLanguageCatalogHints, TtsPocketSelectedKind) {
    auto r = DetectTtsModel(
        std::nullopt, std::optional<std::string>("sherpa-onnx-pocket-tts-2026-01-26"), "auto");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kPocket);
    r = DetectTtsModel(
        std::nullopt,
        std::optional<std::string>("sherpa-onnx-pocket-tts-int8-2026-01-26"),
        "auto");
    EXPECT_EQ(r.selectedKind, TtsModelKind::kPocket);
}

TEST(ModelLanguageCatalogHints, TtsQuantizationAndSizeTier) {
    auto r = DetectTtsModel(
        std::nullopt,
        std::optional<std::string>("vits-piper-ka_GE-natia-medium-int8"),
        "auto");
    EXPECT_EQ(r.quantization, "int8");
    r = DetectTtsModel(
        std::nullopt,
        std::optional<std::string>("vits-piper-ka_GE-natia-medium-fp16"),
        "auto");
    EXPECT_EQ(r.quantization, "fp16");
    r = DetectTtsModel(
        std::nullopt, std::optional<std::string>("vits-piper-en_US-lessac-medium"), "auto");
    EXPECT_EQ(r.sizeTier, "medium");
}

TEST(ModelLanguageCatalogHints, TtsSequentialNameOnlyMatchesBatchParity) {
    std::vector<std::string> ids = {
        "vits-mms-eng", "kokoro-en-v0_19", "zzz-no-known-tts-token"};
    auto a = DetectTtsModel(std::nullopt, std::optional<std::string>(ids[0]), "auto");
    EXPECT_EQ(a.derivedLanguages, RowsFromHints({"en"}));
    EXPECT_EQ(a.selectedKind, TtsModelKind::kVits);

    auto b = DetectTtsModel(std::nullopt, std::optional<std::string>(ids[1]), "auto");
    EXPECT_EQ(b.selectedKind, TtsModelKind::kKokoro);
}

TEST(ModelLanguageCatalogHints, Supertonic3NameOnlyGetsFullHintSet) {
    auto r = DetectTtsModel(
        std::nullopt,
        std::optional<std::string>("sherpa-onnx-supertonic-3-tts-int8-2026-05-11"),
        "auto");
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

TEST(ModelLanguageCatalogHints, WhisperNameOnlyGetsCatalogHints) {
    auto r = DetectSttModel(
        std::nullopt,
        std::optional<std::string>("sherpa-onnx-whisper-tiny"),
        "auto",
        std::nullopt,
        false);
    ASSERT_FALSE(r.derivedLanguages.empty());
    EXPECT_TRUE(HasHint(r.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(r.derivedLanguages, "de"));
    ASSERT_FALSE(r.detectionSources.empty());
    EXPECT_EQ(r.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(ModelLanguageCatalogHints, FunAsrNameOnlyGetsChineseModelOptionId) {
    auto r = DetectSttModel(
        std::nullopt,
        std::optional<std::string>("sherpa-onnx-funasr-nano"),
        "auto",
        std::nullopt,
        false);
    EXPECT_EQ(r.selectedKind, SttModelKind::kFunAsrNano);
    EXPECT_TRUE(HasRow(r.derivedLanguages, "zh", "中文"));
    EXPECT_TRUE(HasRow(r.derivedLanguages, "en", "英文"));
}

TEST(ModelLanguageCatalogHints, ModelOptionIdForHintMapsFunAsrZh) {
    using sherpaonnx::model_language_catalog::ModelOptionIdForHint;
    EXPECT_EQ(ModelOptionIdForHint("funasr_nano", "zh"), "中文");
    EXPECT_EQ(ModelOptionIdForHint("whisper", "en"), "en");
}

TEST(ModelLanguageCatalogHints, AlignmentWav2Vec2GetsEnglishHint) {
    FileEntry modelFile;
    modelFile.path = "wav2vec2-base-960h-int8/model.int8.onnx";
    modelFile.name = "model.int8.onnx";
    modelFile.nameLower = "model.int8.onnx";
    modelFile.size = 1024;

    auto ok = DetectAlignmentModelFromFileList(
        {modelFile}, "wav2vec2-base-960h-int8", "wav2vec2", "int8");
    EXPECT_TRUE(ok.ok);
    EXPECT_EQ(ok.derivedLanguages, RowsFromHints({"en"}));
    ASSERT_FALSE(ok.detectionSources.empty());
    EXPECT_EQ(ok.detectionSources.back(), DetectionSource::kCuratedCatalog);

    auto nameOnly =
        DetectAlignmentModelFromFileList({}, "wav2vec2-base-960h-int8", "auto", "");
    EXPECT_FALSE(nameOnly.ok);
    EXPECT_EQ(nameOnly.derivedLanguages, RowsFromHints({"en"}));
    ASSERT_FALSE(nameOnly.detectionSources.empty());
    EXPECT_EQ(nameOnly.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(ModelLanguageCatalogHints, OcrPpocrv6TinyGetsPackHints) {
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

    auto ok = DetectOcrModelFromFileList({det, rec, dict}, "ppocrv6-tiny", "ppocr", "");
    EXPECT_TRUE(ok.ok);
    EXPECT_EQ(ok.selectedKind, OcrModelKind::kPpocr);
    ASSERT_GE(ok.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "zh"));
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(ok.derivedLanguages, "de"));
    EXPECT_FALSE(HasHint(ok.derivedLanguages, "ja"));
    ASSERT_FALSE(ok.detectionSources.empty());
    EXPECT_EQ(ok.detectionSources.back(), DetectionSource::kCuratedCatalog);

    auto nameOnly = DetectOcrModelFromFileList({}, "ppocrv6-tiny", "auto", "");
    EXPECT_FALSE(nameOnly.ok);
    ASSERT_GE(nameOnly.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(nameOnly.derivedLanguages, "zh"));
    EXPECT_FALSE(HasHint(nameOnly.derivedLanguages, "ja"));
    ASSERT_FALSE(nameOnly.detectionSources.empty());
    EXPECT_EQ(nameOnly.detectionSources.back(), DetectionSource::kCuratedCatalog);

    auto small = DetectOcrModelFromFileList({}, "ppocrv6-small", "auto", "");
    ASSERT_GE(small.derivedLanguages.size(), 40u);
    EXPECT_TRUE(HasHint(small.derivedLanguages, "zh"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "en"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "ja"));
    EXPECT_TRUE(HasHint(small.derivedLanguages, "fr"));
}

TEST(ModelLanguageCatalogHints, OcrDoctrFamilyRowsNonEmpty) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrRowsForModelType("doctr");
    ASSERT_FALSE(rows.empty()) << "OcrRowsForModelType(\"doctr\") should return family hints";
    bool hasEn = false;
    for (const auto& r : rows) {
        if (r.iso6391Hint == "en") hasEn = true;
    }
    EXPECT_TRUE(hasEn);
}

TEST(ModelLanguageCatalogHints, OcrDoctrPackRowsForKnownIds) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& mobile = OcrPackRowsForModelKey("doctr-mobile");
    ASSERT_FALSE(mobile.empty());
    EXPECT_EQ(mobile.size(), 2u);

    const auto& dflt = OcrPackRowsForModelKey("doctr-default");
    ASSERT_FALSE(dflt.empty());
    EXPECT_EQ(dflt.size(), 15u);
}

TEST(ModelLanguageCatalogHints, OcrNemotronParseFamilyRows) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrRowsForModelType("nemotron_parse");
    ASSERT_FALSE(rows.empty());
    EXPECT_EQ(rows[0].iso6391Hint, "en");
    EXPECT_TRUE(HasHint(rows, "en"));
}

TEST(ModelLanguageCatalogHints, OcrDocVlmFamilyRows) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrRowsForModelType("doc_vlm");
    ASSERT_EQ(rows.size(), 4u);
    EXPECT_EQ(rows[0].iso6391Hint, "en");
    EXPECT_EQ(rows[1].iso6391Hint, "ja");
    EXPECT_EQ(rows[2].iso6391Hint, "ar");
    EXPECT_EQ(rows[3].iso6391Hint, "zh");
}

TEST(ModelLanguageCatalogHints, OcrDocVlmPackRows) {
    using namespace sherpaonnx::model_language_catalog;
    const auto& rows = OcrPackRowsForModelKey("docvlm-granite-258m-fp32");
    ASSERT_EQ(rows.size(), 4u);
    EXPECT_EQ(rows[0].iso6391Hint, "en");
    EXPECT_EQ(rows[1].iso6391Hint, "ja");
    EXPECT_EQ(rows[2].iso6391Hint, "ar");
    EXPECT_EQ(rows[3].iso6391Hint, "zh");
}

TEST(ModelLanguageCatalogHints, OcrDocVlmNameOnlyPackLanguages) {
    auto result = DetectOcrModelFromFileList({}, "docvlm-granite-258m-fp32", "auto");
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, OcrModelKind::kDocVlm);
    ASSERT_EQ(result.derivedLanguages.size(), 4u);
    EXPECT_EQ(result.derivedLanguages[0].iso6391Hint, "en");
    EXPECT_EQ(result.derivedLanguages[1].iso6391Hint, "ja");
    EXPECT_EQ(result.derivedLanguages[2].iso6391Hint, "ar");
    EXPECT_EQ(result.derivedLanguages[3].iso6391Hint, "zh");
    ASSERT_FALSE(result.detectionSources.empty());
    EXPECT_EQ(result.detectionSources.back(), DetectionSource::kCuratedCatalog);
}

TEST(ModelLanguageCatalogHints, OcrDocVlmUnknownPackUsesFamilyRows) {
    auto result = DetectOcrModelFromFileList({}, "future-doc-vlm-pack", "doc_vlm");
    EXPECT_FALSE(result.ok);
    EXPECT_EQ(result.selectedKind, OcrModelKind::kDocVlm);
    ASSERT_EQ(result.derivedLanguages.size(), 4u);
    EXPECT_EQ(result.derivedLanguages[0].iso6391Hint, "en");
    EXPECT_EQ(result.derivedLanguages[1].iso6391Hint, "ja");
    EXPECT_EQ(result.derivedLanguages[2].iso6391Hint, "ar");
    EXPECT_EQ(result.derivedLanguages[3].iso6391Hint, "zh");
    ASSERT_FALSE(sherpaonnx::model_language_catalog::OcrRowsForModelType("doctr").empty());
    ASSERT_FALSE(sherpaonnx::model_language_catalog::OcrRowsForModelType("ppocr").empty());
}
