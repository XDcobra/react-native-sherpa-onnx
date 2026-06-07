/**
 * Catalog test: GetCustomModelPathRequirements must match the static tables in
 * sherpa-onnx-validate-*.cpp (source of truth for custom-init UI required/optional).
 */
#include "sherpa-onnx-validate-custom.h"

#include <algorithm>
#include <gtest/gtest.h>
#include <optional>
#include <string>
#include <vector>

namespace {

struct FieldExpectation {
    const char* key;
    bool required;
    std::optional<bool> isDirectory;
};

using FieldList = std::vector<FieldExpectation>;

void ExpectRequirementsMatch(
    const char* category,
    const char* modelType,
    const FieldList& expected
) {
    const auto reqs = sherpaonnx::GetCustomModelPathRequirements(category, modelType);
    ASSERT_EQ(reqs.fields.size(), expected.size())
        << category << "/" << modelType << " field count mismatch";
    for (const auto& exp : expected) {
        const auto it = std::find_if(
            reqs.fields.begin(),
            reqs.fields.end(),
            [&](const sherpaonnx::CustomPathFieldSpec& field) {
                return field.key == exp.key;
            });
        ASSERT_NE(it, reqs.fields.end())
            << category << "/" << modelType << " missing field " << exp.key;
        EXPECT_EQ(it->required, exp.required)
            << category << "/" << modelType << " required flag for " << exp.key;
        if (exp.isDirectory.has_value()) {
            EXPECT_EQ(it->isDirectory, *exp.isDirectory)
                << category << "/" << modelType << " isDirectory for " << exp.key;
        } else {
            EXPECT_FALSE(it->isDirectory)
                << category << "/" << modelType << " isDirectory for " << exp.key;
        }
    }
}

const FieldList kSttTransducerFields = {
    {"encoder", true, std::nullopt},
    {"decoder", true, std::nullopt},
    {"joiner", true, std::nullopt},
    {"tokens", true, std::nullopt},
    {"bpeVocab", false, std::nullopt},
};

const FieldList kSttCtcFields = {
    {"ctcModel", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttParaformerOfflineFields = {
    {"paraformerModel", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttWhisperFields = {
    {"whisperEncoder", true, std::nullopt},
    {"whisperDecoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttFunAsrNanoFields = {
    {"funasrEncoderAdaptor", true, std::nullopt},
    {"funasrLLM", true, std::nullopt},
    {"funasrEmbedding", true, std::nullopt},
    {"funasrTokenizer", true, std::nullopt},
};

const FieldList kSttQwen3AsrFields = {
    {"qwen3ConvFrontend", true, std::nullopt},
    {"qwen3Encoder", true, std::nullopt},
    {"qwen3Decoder", true, std::nullopt},
    {"qwen3Tokenizer", true, std::nullopt},
};

const FieldList kSttCohereFields = {
    {"cohereEncoder", true, std::nullopt},
    {"cohereDecoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttMoonshineV1Fields = {
    {"moonshinePreprocessor", true, std::nullopt},
    {"moonshineEncoder", true, std::nullopt},
    {"moonshineUncachedDecoder", true, std::nullopt},
    {"moonshineCachedDecoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttMoonshineV2Fields = {
    {"moonshineEncoder", true, std::nullopt},
    {"moonshineMergedDecoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttEncoderDecoderTokensFields = {
    {"fireRedEncoder", true, std::nullopt},
    {"fireRedDecoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kSttSingleModelTokensFields = {
    {"dolphinModel", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kStreamingTransducerFields = {
    {"encoder", true, std::nullopt},
    {"decoder", true, std::nullopt},
    {"joiner", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kStreamingParaformerFields = {
    {"encoder", true, std::nullopt},
    {"decoder", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kStreamingSingleModelFields = {
    {"model", true, std::nullopt},
    {"tokens", true, std::nullopt},
};

const FieldList kTtsVitsFields = {
    {"ttsModel", true, false},
    {"tokens", true, false},
    {"dataDir", false, true},
    {"lexicon", false, false},
};

const FieldList kTtsMatchaFields = {
    {"acousticModel", true, false},
    {"vocoder", true, false},
    {"tokens", true, false},
    {"dataDir", false, true},
    {"lexicon", false, false},
};

const FieldList kTtsKokoroFields = {
    {"ttsModel", true, false},
    {"tokens", true, false},
    {"voices", true, false},
    {"dataDir", true, true},
    {"lexicon", false, false},
};

const FieldList kTtsPocketFields = {
    {"lmFlow", true, false},
    {"lmMain", true, false},
    {"encoder", true, false},
    {"decoder", true, false},
    {"textConditioner", true, false},
    {"vocabJson", true, false},
    {"tokenScoresJson", true, false},
};

const FieldList kTtsZipvoiceFields = {
    {"encoder", true, false},
    {"decoder", true, false},
    {"vocoder", true, false},
    {"tokens", true, false},
    {"dataDir", true, true},
    {"lexicon", true, false},
};

const FieldList kTtsSupertonicFields = {
    {"durationPredictor", true, false},
    {"textEncoder", true, false},
    {"vectorEstimator", true, false},
    {"vocoder", true, false},
    {"ttsJson", true, false},
    {"unicodeIndexer", true, false},
    {"voiceStyle", true, false},
};

}  // namespace

TEST(CustomPathRequirementsCatalog, OfflineSttTransducerFamily) {
    ExpectRequirementsMatch("stt", "transducer", kSttTransducerFields);
    ExpectRequirementsMatch("stt", "nemo_transducer", kSttTransducerFields);
}

TEST(CustomPathRequirementsCatalog, OfflineSttCtcFamily) {
    for (const char* modelType :
         {"nemo_ctc", "wenet_ctc", "sense_voice", "zipformer_ctc", "ctc", "tone_ctc"}) {
        ExpectRequirementsMatch("stt", modelType, kSttCtcFields);
    }
}

TEST(CustomPathRequirementsCatalog, OfflineSttDistinctLayouts) {
    ExpectRequirementsMatch("stt", "paraformer", kSttParaformerOfflineFields);
    ExpectRequirementsMatch("stt", "whisper", kSttWhisperFields);
    ExpectRequirementsMatch("stt", "funasr_nano", kSttFunAsrNanoFields);
    ExpectRequirementsMatch("stt", "qwen3_asr", kSttQwen3AsrFields);
    ExpectRequirementsMatch("stt", "cohere_transcribe", kSttCohereFields);
    ExpectRequirementsMatch("stt", "moonshine", kSttMoonshineV1Fields);
    ExpectRequirementsMatch("stt", "moonshine_v2", kSttMoonshineV2Fields);
    ExpectRequirementsMatch("stt", "fire_red_asr", kSttEncoderDecoderTokensFields);
    ExpectRequirementsMatch("stt", "canary", {
        {"canaryEncoder", true, std::nullopt},
        {"canaryDecoder", true, std::nullopt},
        {"tokens", true, std::nullopt},
    });
    ExpectRequirementsMatch("stt", "dolphin", kSttSingleModelTokensFields);
    ExpectRequirementsMatch("stt", "omnilingual", {
        {"omnilingualModel", true, std::nullopt},
        {"tokens", true, std::nullopt},
    });
    ExpectRequirementsMatch("stt", "medasr", {
        {"medasrModel", true, std::nullopt},
        {"tokens", true, std::nullopt},
    });
    ExpectRequirementsMatch("stt", "telespeech_ctc", {
        {"telespeechCtcModel", true, std::nullopt},
        {"tokens", true, std::nullopt},
    });
}

TEST(CustomPathRequirementsCatalog, StreamingSttLayouts) {
    ExpectRequirementsMatch("stt_streaming", "transducer", kStreamingTransducerFields);
    ExpectRequirementsMatch("stt_streaming", "nemo_transducer", kStreamingTransducerFields);
    ExpectRequirementsMatch("stt_streaming", "paraformer", kStreamingParaformerFields);
    for (const char* modelType : {"zipformer2_ctc", "nemo_ctc", "tone_ctc"}) {
        ExpectRequirementsMatch("stt_streaming", modelType, kStreamingSingleModelFields);
    }
}

TEST(CustomPathRequirementsCatalog, TtsLayouts) {
    ExpectRequirementsMatch("tts", "vits", kTtsVitsFields);
    ExpectRequirementsMatch("tts", "matcha", kTtsMatchaFields);
    ExpectRequirementsMatch("tts", "kokoro", kTtsKokoroFields);
    ExpectRequirementsMatch("tts", "kitten", kTtsKokoroFields);
    ExpectRequirementsMatch("tts", "pocket", kTtsPocketFields);
    ExpectRequirementsMatch("tts", "zipvoice", kTtsZipvoiceFields);
    ExpectRequirementsMatch("tts", "supertonic", kTtsSupertonicFields);
}

TEST(CustomPathRequirementsCatalog, VadEnhancementAlignmentPunctuation) {
    ExpectRequirementsMatch("vad", "silero_vad", {{"model", true, std::nullopt}});
    ExpectRequirementsMatch("vad", "ten_vad", {{"model", true, std::nullopt}});
    ExpectRequirementsMatch("enhancement", "gtcrn", {{"model", true, std::nullopt}});
    ExpectRequirementsMatch("enhancement", "dpdfnet", {{"model", true, std::nullopt}});
    ExpectRequirementsMatch("alignment", "wav2vec2", {{"model", true, std::nullopt}});
    ExpectRequirementsMatch("punctuation", "ct_transformer", {{"ct_transformer", true, std::nullopt}});
    ExpectRequirementsMatch("punctuation", "cnn_bilstm", {
        {"cnn_bilstm", true, std::nullopt},
        {"bpe_vocab", true, std::nullopt},
    });
}

TEST(CustomPathRequirementsCatalog, UnknownModelTypesReturnEmpty) {
    EXPECT_TRUE(sherpaonnx::GetCustomModelPathRequirements("stt", "unknown_type").fields.empty());
    EXPECT_TRUE(
        sherpaonnx::GetCustomModelPathRequirements("stt_streaming", "wenet_ctc").fields.empty());
    EXPECT_TRUE(sherpaonnx::GetCustomModelPathRequirements("tts", "unknown_type").fields.empty());
}
