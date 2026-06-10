#ifndef SHERPA_ONNX_MODEL_DETECT_H
#define SHERPA_ONNX_MODEL_DETECT_H

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect-helper.h"
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
    kQwen3Asr,
    kCohereTranscribe,
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

/** Parse public model type string to {@link SttModelKind}. Returns kUnknown when unrecognized. */
SttModelKind ParseSttModelType(const std::string& modelType);

enum class TtsModelKind {
    kUnknown,
    kVits,
    kMatcha,
    kKokoro,
    kKitten,
    kPocket,
    kZipvoice,
    kSupertonic
};

/** Traces how model kind was chosen; shared across all features (TTS, Alignment, etc.).
 *  Serialized to JS as stable string literals (see DetectionSourceToLiteral). */
enum class DetectionSource {
    /** Recursive file listing was used (non-empty file vector). */
    kFileListing,
    /** Directory basename contained a known type token and that drove selection in auto mode. */
    kDirName,
    /** Default priority order among capabilities when folder name did not resolve. */
    kFallbackOrder,
    /** Caller passed an explicit modelType string (not "auto"). */
    kExplicitModelType,
    /** files vector was empty: name-only heuristics only; no path validation. */
    kNameOnly,
};

/** Stable literals for JNI / NSDictionary / TypeScript (must match src/types/modelDetect.ts). */
inline const char* DetectionSourceToLiteral(DetectionSource s) {
    switch (s) {
        case DetectionSource::kFileListing: return "fileListing";
        case DetectionSource::kDirName: return "dirName";
        case DetectionSource::kFallbackOrder: return "fallbackOrder";
        case DetectionSource::kExplicitModelType: return "explicitModelType";
        case DetectionSource::kNameOnly: return "nameOnly";
    }
    return "fileListing";
}

enum class EnhancementModelKind {
    kUnknown,
    kGtcrn,
    kDpdfNet
};

/** Offline=CT-Transformer (ct_transformer); online=CNN-BiLSTM (cnn_bilstm + bpe.vocab) per sherpa-onnx. */
enum class PunctuationModelKind {
    kUnknown,
    kCtTransformer,
    kCnnBilstm
};

enum class VadModelKind {
    kUnknown,
    kSileroVad,
    kTenVad
};

enum class AlignmentModelKind {
    kUnknown,
    kWav2Vec2
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
    /** Qwen3-ASR: conv_frontend + encoder + decoder + tokenizer directory. */
    std::string qwen3ConvFrontend;
    std::string qwen3Encoder;
    std::string qwen3Decoder;
    std::string qwen3Tokenizer;
    /** Cohere Transcribe: encoder + decoder ONNX; tokens.txt in model_config.tokens. */
    std::string cohereEncoder;
    std::string cohereDecoder;
    // Moonshine
    std::string moonshinePreprocessor;
    std::string moonshineEncoder;
    std::string moonshineUncachedDecoder;
    std::string moonshineCachedDecoder;
    /** Moonshine v2: encoder + mergedDecoder (reuse moonshineEncoder for encoder path). */
    std::string moonshineMergedDecoder;
    // Dolphin, Omnilingual, MedAsr, TeleSpeech (single model each)
    std::string dolphinModel;
    std::string omnilingualModel;
    std::string medasrModel;
    std::string telespeechCtcModel;
    // FireRed ASR, Canary (encoder/decoder)
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
    std::string qwen3ConvFrontend;
    std::string qwen3TokenizerDir;
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
    bool isLikelyQwen3Asr = false;
    /** Directory name contains cohere / cohere-transcribe (CohereLabs ASR). */
    bool isLikelyCohere = false;
    bool isLikelyZipformer = false;
    bool isLikelyMoonshine = false;
    bool isLikelyDolphin = false;
    bool isLikelyFireRedAsr = false;
    bool isLikelyCanary = false;
    bool isLikelyOmnilingual = false;
    bool isLikelyMedAsr = false;
    bool isLikelyTeleSpeech = false;
    bool isLikelyToneCtc = false;
    bool isLikelyParaformer = false;
    /** VAD (silero, ten-vad, etc.): not yet supported; when true, detection returns unsupported. */
    bool isLikelyVad = false;
    /** TDNN (keyword/yesno): not yet supported; when true, detection returns unsupported. */
    bool isLikelyTdnn = false;
};

/** Which model types are possible given paths and hints (has* flags). */
struct SttCapabilities {
    bool hasTransducer = false;
    bool hasWhisper = false;
    bool hasMoonshine = false;
    bool hasMoonshineV2 = false;
    bool hasParaformer = false;
    bool hasFunAsrNano = false;
    bool hasQwen3Asr = false;
    /** Encoder+decoder+tokens, no joiner, not Qwen3 — structural match for Cohere (explicit type). */
    bool hasCohereTranscribeLayout = false;
    /** Auto: layout + directory name suggests Cohere (excludes from Whisper). */
    bool hasCohereTranscribe = false;
    bool hasDolphin = false;
    bool hasFireRedAsr = false;
    /** True when dir name suggests Fire Red but only a single CTC/paraformer model (no encoder/decoder). Use zipformer_ctc. */
    bool hasFireRedCtc = false;
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
    // Supertonic TTS
    std::string durationPredictor;
    std::string textEncoder;
    std::string vectorEstimator;
    std::string ttsJson;
    std::string unicodeIndexer;
    std::string voiceStyle;
};

struct EnhancementModelPaths {
    std::string model;
};

struct PunctuationModelPaths {
    /** OfflinePunctuationModelConfig.ct_transformer */
    std::string ct_transformer;
    /** OnlinePunctuationModelConfig.cnn_bilstm */
    std::string cnn_bilstm;
    /** OnlinePunctuationModelConfig.bpe_vocab */
    std::string bpe_vocab;
};

struct AlignmentModelPaths {
    std::string model;
};

struct VadModelPaths {
    std::string model;
};

struct SttDetectResult {
    bool ok = false;
    /** True when online-streaming compatibility is confirmed (or heuristically inferred in name-only mode). */
    bool isStreaming = false;
    std::string error;
    /** True when detection failed because the model is for unsupported hardware (RK35xx, Ascend, CANN, etc.). */
    bool isHardwareSpecificUnsupported = false;
    std::vector<DetectedModel> detectedModels;
    SttModelKind selectedKind = SttModelKind::kUnknown;
    bool tokensRequired = true;
    SttModelPaths paths;
    /** Ordered trace of detection mechanisms (see DetectionSource). */
    std::vector<DetectionSource> detectionSources;
    /** Heuristic languages from asset/folder name (release id stem); not from model files. */
    std::vector<std::string> derivedLanguages;
    /** fp16, int8, int8-quantized, unknown — from asset/folder name heuristics. */
    std::string quantization;
};

struct TtsDetectResult {
    bool ok = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    TtsModelKind selectedKind = TtsModelKind::kUnknown;
    TtsModelPaths paths;
    /** Lexicon files detected on disk (id + path). Empty when not applicable. */
    std::vector<model_detect::LexiconCandidate> lexiconLanguages;
    /** Ordered trace of detection mechanisms (see DetectionSource). */
    std::vector<DetectionSource> detectionSources;
    /** Heuristic languages from asset/folder name (release id stem); not from lexicon files. */
    std::vector<std::string> derivedLanguages;
    /** fp16, int8, int8-quantized, unknown — from asset/folder name heuristics. */
    std::string quantization;
    /** tiny, small, medium, large, unknown — from asset/folder name heuristics. */
    std::string sizeTier;
};

struct EnhancementDetectResult {
    bool ok = false;
    /** True when online-streaming compatibility is confirmed (or heuristically inferred in name-only mode). */
    bool isStreaming = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    EnhancementModelKind selectedKind = EnhancementModelKind::kUnknown;
    EnhancementModelPaths paths;
    /** Ordered trace of detection mechanisms (see DetectionSource). */
    std::vector<DetectionSource> detectionSources;
    /** Heuristic languages from asset/folder name; currently usually empty for enhancement. */
    std::vector<std::string> derivedLanguages;
    /** fp16, int8, int8-quantized, unknown — from asset/folder name heuristics. */
    std::string quantization;
};

struct PunctuationDetectResult {
    bool ok = false;
    /** True when the CNN-BiLSTM (online) layout is selected and the ORT online-compatibility
     *  preflight passes; false for offline CT-Transformer. Name-only or missing-file
     *  heuristics mirror enhancement detect behavior. */
    bool isStreaming = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    PunctuationModelKind selectedKind = PunctuationModelKind::kUnknown;
    PunctuationModelPaths paths;
    std::vector<DetectionSource> detectionSources;
    std::vector<std::string> derivedLanguages;
    std::string quantization;
};

struct AlignmentDetectResult {
    bool ok = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    AlignmentModelKind selectedKind = AlignmentModelKind::kUnknown;
    AlignmentModelPaths paths;
    /** Ordered trace of detection mechanisms (see DetectionSource). */
    std::vector<DetectionSource> detectionSources;
    /** Heuristic languages from folder name; currently empty for alignment. */
    std::vector<std::string> derivedLanguages;
    /** fp16, int8, int8-quantized, unknown — from folder name heuristics. */
    std::string quantization;
};

struct VadDetectResult {
    bool ok = false;
    /** True when online-streaming compatibility is confirmed (or heuristically inferred in name-only mode). */
    bool isStreaming = false;
    std::string error;
    std::vector<DetectedModel> detectedModels;
    VadModelKind selectedKind = VadModelKind::kUnknown;
    VadModelPaths paths;
    /** Ordered trace of detection mechanisms (see DetectionSource). */
    std::vector<DetectionSource> detectionSources;
    /** Heuristic languages from asset/folder name; usually empty for VAD. */
    std::vector<std::string> derivedLanguages;
    /** fp16, int8, int8-quantized, unknown — from asset/folder name heuristics. */
    std::string quantization;
};

/**
 * STT model detection. Pass at least one of `model_dir` or `asset_name`.
 * - `model_dir`: absolute path to extracted model (full file scan when directory exists).
 * - `asset_name`: release asset stem / folder basename (name-only detection when no directory).
 * When both are set, directory scan is used and derived catalog metadata uses `asset_name`.
 */
SttDetectResult DetectSttModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType = "auto",
    const std::optional<bool>& preferInt8 = std::nullopt,
    bool debug = false
);

/** Test-only: Like DetectSttModel but takes a pre-built file list; no filesystem access.
 *  Only used by the host-side C++ test suite (test/cpp/model_detect/model_detect_test.cpp). Not used in
 *  production (Android/iOS use DetectSttModel). Does not validate modelDir existence or
 *  call FileExists on tokens/bpeVocab. */
SttDetectResult DetectSttModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto",
    const std::optional<bool>& preferInt8 = std::nullopt
);

/**
 * TTS model detection. Pass at least one of `model_dir` or `asset_name`.
 * - `model_dir`: absolute path to extracted model (full file scan when directory exists).
 * - `asset_name`: release asset stem / folder basename (e.g. vits-piper-en_US-lessac-medium); name-only detection when no directory.
 * When both are set, the directory is scanned and derived catalog metadata uses `asset_name` for languages/quantization/sizeTier.
 */
TtsDetectResult DetectTtsModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType = "auto");

/** Test-only: Like DetectTtsModel but takes a pre-built file list; no filesystem access.
 *  Only used by the host-side C++ test suite (test/cpp/model_detect/model_detect_test.cpp). Not used in
 *  production (Android/iOS use DetectTtsModel). Does not validate modelDir existence or
 *  call FileExists / IsDirectory.
 *
 *  Contract for DetectTtsModelFromFiles (shared implementation):
 *  - If `files` is non-empty: full capability scan, ValidateTtsPaths on success, `detectionSources` includes
 *    kFileListing plus kDirName, kFallbackOrder, and/or kExplicitModelType as applicable.
 *  - If `files` is empty: name-only mode (kNameOnly). Infers kinds from the last path component of
 *    `modelDir` only; does not run ValidateTtsPaths; leaves paths empty; sets ok to false with an error
 *    explaining that a full scan is required before createTTS. Use for pre-check / UI hints only. */
TtsDetectResult DetectTtsModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto"
);

/**
 * Enhancement model detection. Pass at least one of `model_dir` or `asset_name`.
 * - `model_dir`: absolute path to extracted model (full file scan when directory exists).
 * - `asset_name`: release asset stem / folder basename; enables name-only detection when no directory.
 * When both are set, directory scan is used and derived catalog metadata uses `asset_name`.
 */
EnhancementDetectResult DetectEnhancementModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType = "auto"
);

VadDetectResult DetectVadModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType = "auto"
);

/**
 * Punctuation model detection. Pass at least one of `model_dir` or `asset_name`.
 * Offline (CT) vs online (CNN-BiLSTM) heuristics follow sherpa's Offline/OnlinePunctuationModelConfig.
 * `PunctuationDetectResult::isStreaming` is set per the struct comment (CNN-BiLSTM + ORT preflight).
 */
PunctuationDetectResult DetectPunctuationModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType = "auto"
);

AlignmentDetectResult DetectAlignmentModel(
    const std::string& modelDir,
    const std::string& modelType
);

/** Test-only: Like DetectEnhancementModel but takes a pre-built file list; no filesystem access.
 *  Only used by the host-side C++ test suite (test/cpp/model_detect/model_detect_test.cpp). */
EnhancementDetectResult DetectEnhancementModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto"
);

/** Test-only: Like DetectVadModel but takes a pre-built file list; no filesystem access.
 *  Only used by the host-side C++ test suite (test/cpp/model_detect/model_detect_test.cpp). */
VadDetectResult DetectVadModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto"
);

/** Test-only: Like DetectPunctuationModel but takes a pre-built file list; no filesystem access. */
PunctuationDetectResult DetectPunctuationModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto"
);

/** Test-only: Like DetectAlignmentModel but takes a pre-built file list; no filesystem access.
 *  Only used by the host-side C++ test suite (test/cpp/model_detect/model_detect_test.cpp). */
AlignmentDetectResult DetectAlignmentModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType = "auto"
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_MODEL_DETECT_H
