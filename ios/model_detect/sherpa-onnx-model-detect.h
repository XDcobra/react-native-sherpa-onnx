#ifndef SHERPA_ONNX_MODEL_DETECT_H
#define SHERPA_ONNX_MODEL_DETECT_H

#include "sherpa-onnx-common.h"
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

enum class SttModelKind {
    kUnknown,
    kTransducer,
    kNemoTransducer,
    kParaformer,
    kNemoCtc,
    kWenetCtc,
    kSenseVoice,
    kZipformerCtc,
    kWhisper,
    kFunAsrNano,
    kFireRedAsr,
    kMoonshine,
    kMoonshineV2,
    kDolphin,
    kCanary,
    kOmnilingual,
    kMedAsr,
    kTeleSpeechCtc,
    kToneCtc
};

enum class TtsModelKind {
    kUnknown,
    kVits,
    kMatcha,
    kKokoro,
    kKitten,
    kPocket,
    kZipvoice
};

struct SttModelPaths {
    std::string encoder;
    std::string decoder;
    std::string joiner;
    std::string paraformerModel;
    std::string ctcModel;
    std::string whisperEncoder;
    std::string whisperDecoder;
    std::string tokens;
    /** BPE vocabulary for hotwords tokenization (sentencepiece export bpe.vocab). Optional. */
    std::string bpeVocab;
    std::string funasrEncoderAdaptor;
    std::string funasrLLM;
    std::string funasrEmbedding;
    std::string funasrTokenizer;
    std::string moonshinePreprocessor;
    std::string moonshineEncoder;
    std::string moonshineUncachedDecoder;
    std::string moonshineCachedDecoder;
    /** Moonshine v2: encoder + mergedDecoder (reuse moonshineEncoder for encoder path). */
    std::string moonshineMergedDecoder;
    std::string dolphinModel;
    std::string omnilingualModel;
    std::string medasrModel;
    std::string telespeechCtcModel;
    std::string fireRedEncoder;
    std::string fireRedDecoder;
    std::string canaryEncoder;
    std::string canaryDecoder;
};

/** All candidate paths gathered before model kind selection (used by STT detection steps). */
struct SttCandidatePaths {
    std::string encoder;
    std::string decoder;
    std::string joiner;
    std::string paraformerModel;
    std::string ctcModel;
    std::string tokens;
    std::string bpeVocab;
    std::string funasrEncoderAdaptor;
    std::string funasrLLM;
    std::string funasrEmbedding;
    std::string funasrTokenizerDir;
    std::string moonshinePreprocessor;
    std::string moonshineEncoder;
    std::string moonshineUncachedDecoder;
    std::string moonshineCachedDecoder;
    std::string moonshineMergedDecoder;
    std::string encoderForV2;
};

/** Path hints derived from model directory name (isLikely* flags). */
struct SttPathHints {
    bool isLikelyNemo = false;
    bool isLikelyTdt = false;
    bool isLikelyWenetCtc = false;
    bool isLikelySenseVoice = false;
    bool isLikelyFunAsrNano = false;
    bool isLikelyZipformer = false;
    bool isLikelyMoonshine = false;
    bool isLikelyDolphin = false;
    bool isLikelyFireRedAsr = false;
    bool isLikelyCanary = false;
    bool isLikelyOmnilingual = false;
    bool isLikelyMedAsr = false;
    bool isLikelyTeleSpeech = false;
    bool isLikelyToneCtc = false;
};

/** Which model types are possible given paths and hints (has* flags). */
struct SttCapabilities {
    bool hasTransducer = false;
    bool hasWhisper = false;
    bool hasMoonshine = false;
    bool hasMoonshineV2 = false;
    bool hasParaformer = false;
    bool hasFunAsrNano = false;
    bool hasDolphin = false;
    bool hasFireRedAsr = false;
    bool hasCanary = false;
    bool hasOmnilingual = false;
    bool hasMedAsr = false;
    bool hasTeleSpeechCtc = false;
    bool hasToneCtc = false;
};

struct TtsModelPaths {
    std::string ttsModel;
    std::string tokens;
    std::string lexicon;
    std::string dataDir;
    std::string voices;
    std::string acousticModel;
    std::string vocoder;
    std::string encoder;
    std::string decoder;
    // Pocket TTS
    std::string lmFlow;
    std::string lmMain;
    std::string textConditioner;
    std::string vocabJson;
    std::string tokenScoresJson;
};

struct SttDetectResult {
    bool ok = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    SttModelKind selectedKind = SttModelKind::kUnknown;
    bool tokensRequired = true;
    SttModelPaths paths;
};

struct TtsDetectResult {
    bool ok = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    TtsModelKind selectedKind = TtsModelKind::kUnknown;
    TtsModelPaths paths;
};

SttDetectResult DetectSttModel(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType,
    bool debug = false
);

TtsDetectResult DetectTtsModel(
    const std::string& modelDir,
    const std::string& modelType
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_MODEL_DETECT_H
