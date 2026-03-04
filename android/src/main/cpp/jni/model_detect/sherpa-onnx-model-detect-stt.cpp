/**
 * sherpa-onnx-model-detect-stt.cpp
 *
 * Purpose: Detects STT model type and fills SttModelPaths from a model directory. Used by
 * nativeDetectSttModel (module-jni). Supports transducer, paraformer, whisper, moonshine, etc.
 *
 * --- Detection pipeline (overview) ---
 *
 * 1. Gather files in modelDir (recursive), then:
 *    - SttCandidatePaths: map file names to logical paths (encoder, decoder, joiner, moonshine
 *      preprocessor/encoder/mergedDecoder, paraformer/ctc model, tokens, etc.).
 *    - SttPathHints: from directory name only (isLikelyMoonshine, isLikelyNemo, ...).
 *    - SttCapabilities: which model types are *possible* given paths + hints (hasWhisper,
 *      hasMoonshineV2, hasTransducer, ...). Multiple can be true at once (e.g. same files
 *      can satisfy both Whisper and Moonshine v2).
 *
 * 2. detectedModels (for UI "Select model type"): built from capabilities only. Every kind
 *    with has* == true is added. So the list shows all types that could work with the files,
 *    not the single chosen type.
 *
 * 3. selectedKind (which type we actually use): from ResolveSttKind():
 *    - If modelType is explicit (e.g. "whisper"): use it if capabilities allow.
 *    - If modelType == "auto": Priority 1 = folder name (GetKindsFromDirName: tokens like
 *      "moonshine", "whisper" in dir name → candidate kinds). Priority 2 = among those
 *      candidates, pick the first that CapabilitySupportsKind(). Fallback = if no name
 *      candidates, use file-only order (transducer → moonshine v2/v1 → CTC → paraformer →
 *      whisper → ...).
 *
 * 4. paths: ApplyPathsForSttKind(selectedKind) copies the relevant candidate paths into
 *    SttModelPaths (encoder/decoder, moonshine encoder/mergedDecoder, etc.) for the chosen kind.
 *
 * Result to caller: ok, error, detectedModels (list), selectedKind (single), paths (for selectedKind).
 */
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include <cstdlib>
#include <string>
#include <algorithm>
#ifdef __ANDROID__
#include <android/log.h>
#define LOG_TAG "SttModelDetect"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

namespace sherpaonnx {
namespace {

static const char* KindToName(SttModelKind k) {
    switch (k) {
        case SttModelKind::kTransducer: return "transducer";
        case SttModelKind::kNemoTransducer: return "nemo_transducer";
        case SttModelKind::kParaformer: return "paraformer";
        case SttModelKind::kNemoCtc: return "nemo_ctc";
        case SttModelKind::kWenetCtc: return "wenet_ctc";
        case SttModelKind::kSenseVoice: return "sense_voice";
        case SttModelKind::kZipformerCtc: return "zipformer_ctc";
        case SttModelKind::kWhisper: return "whisper";
        case SttModelKind::kFunAsrNano: return "funasr_nano";
        case SttModelKind::kFireRedAsr: return "fire_red_asr";
        case SttModelKind::kMoonshine: return "moonshine";
        case SttModelKind::kMoonshineV2: return "moonshine_v2";
        case SttModelKind::kDolphin: return "dolphin";
        case SttModelKind::kCanary: return "canary";
        case SttModelKind::kOmnilingual: return "omnilingual";
        case SttModelKind::kMedAsr: return "medasr";
        case SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
        case SttModelKind::kToneCtc: return "tone_ctc";
        default: return "unknown";
    }
}

static const char* EmptyOrPath(const std::string& s) {
    return s.empty() ? "(empty)" : s.c_str();
}

SttModelKind ParseSttModelType(const std::string& modelType) {
    if (modelType == "transducer") return SttModelKind::kTransducer;
    if (modelType == "nemo_transducer") return SttModelKind::kNemoTransducer;
    if (modelType == "paraformer") return SttModelKind::kParaformer;
    if (modelType == "nemo_ctc") return SttModelKind::kNemoCtc;
    if (modelType == "wenet_ctc") return SttModelKind::kWenetCtc;
    if (modelType == "sense_voice") return SttModelKind::kSenseVoice;
    if (modelType == "zipformer_ctc" || modelType == "ctc") return SttModelKind::kZipformerCtc;
    if (modelType == "whisper") return SttModelKind::kWhisper;
    if (modelType == "funasr_nano") return SttModelKind::kFunAsrNano;
    if (modelType == "fire_red_asr") return SttModelKind::kFireRedAsr;
    if (modelType == "moonshine") return SttModelKind::kMoonshine;
    if (modelType == "moonshine_v2") return SttModelKind::kMoonshineV2;
    if (modelType == "dolphin") return SttModelKind::kDolphin;
    if (modelType == "canary") return SttModelKind::kCanary;
    if (modelType == "omnilingual") return SttModelKind::kOmnilingual;
    if (modelType == "medasr") return SttModelKind::kMedAsr;
    if (modelType == "telespeech_ctc") return SttModelKind::kTeleSpeechCtc;
    if (modelType == "tone_ctc") return SttModelKind::kToneCtc;
    return SttModelKind::kUnknown;
}

/** Returns true if \p cap and hints/paths support the given \p kind (required files present). */
static bool CapabilitySupportsKind(
    SttModelKind kind,
    const SttCapabilities& cap,
    const SttPathHints& hints,
    const SttCandidatePaths& paths
) {
    switch (kind) {
        case SttModelKind::kTransducer:
            return cap.hasTransducer && !(hints.isLikelyNemo || hints.isLikelyTdt);
        case SttModelKind::kNemoTransducer:
            return cap.hasTransducer;
        case SttModelKind::kParaformer:
            return cap.hasParaformer;
        case SttModelKind::kNemoCtc:
            return !paths.ctcModel.empty() && hints.isLikelyNemo;
        case SttModelKind::kWenetCtc:
            return !paths.ctcModel.empty() && hints.isLikelyWenetCtc;
        case SttModelKind::kSenseVoice:
            return !paths.ctcModel.empty() && hints.isLikelySenseVoice;
        case SttModelKind::kZipformerCtc:
            return !paths.ctcModel.empty() && hints.isLikelyZipformer;
        case SttModelKind::kWhisper:
            return cap.hasWhisper;
        case SttModelKind::kFunAsrNano:
            return cap.hasFunAsrNano;
        case SttModelKind::kFireRedAsr:
            return cap.hasFireRedAsr;
        case SttModelKind::kMoonshine:
            return cap.hasMoonshine;
        case SttModelKind::kMoonshineV2:
            return cap.hasMoonshineV2;
        case SttModelKind::kDolphin:
            return cap.hasDolphin;
        case SttModelKind::kCanary:
            return cap.hasCanary;
        case SttModelKind::kOmnilingual:
            return cap.hasOmnilingual;
        case SttModelKind::kMedAsr:
            return cap.hasMedAsr;
        case SttModelKind::kTeleSpeechCtc:
            return cap.hasTeleSpeechCtc;
        case SttModelKind::kToneCtc:
            return cap.hasToneCtc;
        default:
            return false;
    }
}

/**
 * Priority 1: Collect candidate STT kinds from the model directory name (last path component).
 * Tokens like "moonshine", "whisper", "paraformer" are matched case-insensitively. Returns
 * candidates in a fixed priority order so that when multiple kinds match the name, file-based
 * disambiguation picks the first supported one.
 */
static std::vector<SttModelKind> GetKindsFromDirName(const std::string& modelDir) {
    using namespace model_detect;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    std::vector<SttModelKind> out;
    auto add = [&out](SttModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end())
            out.push_back(k);
    };

    if (lower.find("moonshine") != std::string::npos) {
        add(SttModelKind::kMoonshineV2);
        add(SttModelKind::kMoonshine);
    }
    if (lower.find("whisper") != std::string::npos)
        add(SttModelKind::kWhisper);
    if (lower.find("paraformer") != std::string::npos)
        add(SttModelKind::kParaformer);
    if (lower.find("nemo") != std::string::npos || lower.find("parakeet") != std::string::npos) {
        add(SttModelKind::kNemoTransducer);
        add(SttModelKind::kNemoCtc);
    }
    if (lower.find("tdt") != std::string::npos)
        add(SttModelKind::kNemoTransducer);
    if (lower.find("wenet") != std::string::npos)
        add(SttModelKind::kWenetCtc);
    if (lower.find("sense") != std::string::npos || lower.find("sensevoice") != std::string::npos)
        add(SttModelKind::kSenseVoice);
    if (lower.find("zipformer") != std::string::npos) {
        add(SttModelKind::kTransducer);
        add(SttModelKind::kZipformerCtc);
    }
    if (lower.find("funasr") != std::string::npos)
        add(SttModelKind::kFunAsrNano);
    if (lower.find("canary") != std::string::npos)
        add(SttModelKind::kCanary);
    if (lower.find("fire_red") != std::string::npos || lower.find("fire-red") != std::string::npos)
        add(SttModelKind::kFireRedAsr);
    if (lower.find("dolphin") != std::string::npos)
        add(SttModelKind::kDolphin);
    if (lower.find("omnilingual") != std::string::npos)
        add(SttModelKind::kOmnilingual);
    if (lower.find("medasr") != std::string::npos)
        add(SttModelKind::kMedAsr);
    if (lower.find("telespeech") != std::string::npos)
        add(SttModelKind::kTeleSpeechCtc);
    if (lower.find("t-one") != std::string::npos || lower.find("t_one") != std::string::npos ||
        model_detect::ContainsWord(lower, "tone"))
        add(SttModelKind::kToneCtc);
    if (lower.find("transducer") != std::string::npos) {
        add(SttModelKind::kTransducer);
        add(SttModelKind::kNemoTransducer);
    }

    return out;
}

static SttCandidatePaths GatherSttCandidatePaths(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    int maxDepth,
    const std::optional<bool>& preferInt8
) {
    using namespace model_detect;
    SttCandidatePaths p;
    p.encoder = FindOnnxByAnyToken(files, {"encoder"}, preferInt8);
    p.decoder = FindOnnxByAnyToken(files, {"decoder"}, preferInt8);
    p.joiner = FindOnnxByAnyToken(files, {"joiner"}, preferInt8);
    p.funasrEncoderAdaptor = FindOnnxByAnyToken(files, {"encoder_adaptor", "encoder-adaptor"}, preferInt8);
    p.funasrLLM = FindOnnxByAnyToken(files, {"llm"}, preferInt8);
    p.funasrEmbedding = FindOnnxByAnyToken(files, {"embedding"}, preferInt8);
    {
        std::string vocabInSubdir;
        const std::string vocabName = "vocab.json";
        for (const auto& entry : files) {
            if (entry.nameLower != vocabName) continue;
            const std::string& path = entry.path;
            if (path.size() >= modelDir.size() && path.compare(0, modelDir.size(), modelDir) == 0 &&
                (modelDir.empty() || path[modelDir.size()] == '/')) {
                if (path.size() == modelDir.size() + 12 && path.compare(modelDir.size(), 12, "/vocab.json") == 0) {
                    p.funasrTokenizerDir = modelDir;
                    break;
                }
                if (vocabInSubdir.empty())
                    vocabInSubdir = path;
            }
        }
        if (p.funasrTokenizerDir.empty() && !vocabInSubdir.empty()) {
            size_t lastSlash = vocabInSubdir.find_last_of("/\\");
            if (lastSlash != std::string::npos)
                p.funasrTokenizerDir = vocabInSubdir.substr(0, lastSlash);
        }
    }
    p.moonshinePreprocessor = FindOnnxByAnyToken(files, {"preprocess", "preprocessor"}, preferInt8);
    p.moonshineEncoder = FindOnnxByAnyToken(files, {"encode", "encoder_model"}, preferInt8);
    p.moonshineUncachedDecoder = FindOnnxByAnyToken(files, {"uncached_decode", "uncached"}, preferInt8);
    p.moonshineCachedDecoder = FindOnnxByAnyTokenExcluding(
        files, std::vector<std::string>{"cached_decode", "cached"}, std::vector<std::string>{"uncached"}, preferInt8);
    p.moonshineMergedDecoder = FindOnnxByAnyToken(files, {"merged_decode", "merged_decoder", "decoder_model_merged", "merged"}, preferInt8);
    static const std::vector<std::string> modelExcludes = {
        "encoder", "decoder", "joiner", "vocoder", "acoustic", "embedding", "llm",
        "encoder_adaptor", "encoder-adaptor", "encoder_model", "decoder_model",
        "merged_decoder", "decoder_model_merged", "preprocess", "encode", "uncached", "cached"
    };
    p.paraformerModel = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (!p.paraformerModel.empty()) {
        std::string lower = ToLower(p.paraformerModel);
        if (lower.find("encoder_model") != std::string::npos ||
            lower.find("decoder_model") != std::string::npos ||
            lower.find("merged_decoder") != std::string::npos)
            p.paraformerModel.clear();
    }
    if (p.paraformerModel.empty())
        p.paraformerModel = FindLargestOnnxExcludingTokens(files, modelExcludes);
    p.ctcModel = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (!p.ctcModel.empty()) {
        std::string lower = ToLower(p.ctcModel);
        if (lower.find("encoder_model") != std::string::npos ||
            lower.find("decoder_model") != std::string::npos ||
            lower.find("merged_decoder") != std::string::npos)
            p.ctcModel.clear();
    }
    if (p.ctcModel.empty())
        p.ctcModel = FindLargestOnnxExcludingTokens(files, modelExcludes);
    if (!p.paraformerModel.empty() &&
        (p.paraformerModel == p.encoder || p.paraformerModel == p.decoder || p.paraformerModel == p.joiner))
        p.paraformerModel.clear();
    if (!p.ctcModel.empty() &&
        (p.ctcModel == p.encoder || p.ctcModel == p.decoder || p.ctcModel == p.joiner))
        p.ctcModel.clear();
    p.tokens = FindFileEndingWith(files, "tokens.txt");
    p.bpeVocab = FindFileByName(files, "bpe.vocab");
    p.encoderForV2 = p.encoder.empty() ? FindOnnxByAnyToken(files, {"encoder", "encoder_model"}, preferInt8) : p.encoder;
    return p;
}

static SttPathHints GetSttPathHints(const std::string& modelDir) {
    using namespace model_detect;
    SttPathHints h;
    std::string lower = ToLower(modelDir);
    h.isLikelyNemo = lower.find("nemo") != std::string::npos || lower.find("parakeet") != std::string::npos;
    h.isLikelyTdt = lower.find("tdt") != std::string::npos;
    h.isLikelyWenetCtc = lower.find("wenet") != std::string::npos;
    h.isLikelySenseVoice = lower.find("sense") != std::string::npos || lower.find("sensevoice") != std::string::npos;
    h.isLikelyFunAsrNano = lower.find("funasr") != std::string::npos || lower.find("funasr-nano") != std::string::npos;
    h.isLikelyZipformer = lower.find("zipformer") != std::string::npos;
    h.isLikelyMoonshine = lower.find("moonshine") != std::string::npos;
    h.isLikelyDolphin = lower.find("dolphin") != std::string::npos;
    h.isLikelyFireRedAsr = lower.find("fire_red") != std::string::npos || lower.find("fire-red") != std::string::npos;
    h.isLikelyCanary = lower.find("canary") != std::string::npos;
    h.isLikelyOmnilingual = lower.find("omnilingual") != std::string::npos;
    h.isLikelyMedAsr = lower.find("medasr") != std::string::npos;
    h.isLikelyTeleSpeech = lower.find("telespeech") != std::string::npos;
    // tone_ctc is for T-One models only (e.g. streaming-t-one-russian). WeNetSpeech CTC (yue, wu, etc.) uses wenet_ctc per sherpa-onnx docs.
    h.isLikelyToneCtc = lower.find("t-one") != std::string::npos || lower.find("t_one") != std::string::npos ||
                        ContainsWord(lower, "tone");
    h.isLikelyParaformer = lower.find("paraformer") != std::string::npos;
    h.isLikelyVad = lower.find("vad") != std::string::npos || lower.find("silero") != std::string::npos ||
                    lower.find("ten-vad") != std::string::npos;
    h.isLikelyTdnn = lower.find("tdnn") != std::string::npos;
    return h;
}

/** Error message when model is for unsupported hardware (RK35xx, Ascend, etc.). */
static const char* kHardwareSpecificUnsupportedMessage =
    "This model is built for hardware-specific acceleration (e.g. RK35xx, Ascend, CANN) and is not supported by the React Native SDK. Use an ONNX model for CPU/GPU or a QNN-capable model on supported devices.";

/** True if model dir name indicates a hardware-specific build (e.g. RK3588, Ascend). Not runnable on generic host. QNN is supported by the SDK. */
static bool IsHardwareSpecificModelDir(const std::string& modelDir) {
    using namespace model_detect;
    std::string lower = ToLower(modelDir);
    const char* tokens[] = {
        "rk3588", "rk3576", "rk3568", "rk3566", "rk3562", "rknn",
        "ascend", "cann", "910b", "910b2", "310p3"
    };
    for (const char* t : tokens) {
        if (lower.find(t) != std::string::npos)
            return true;
    }
    return false;
}

static SttCapabilities ComputeSttCapabilities(const SttCandidatePaths& paths, const SttPathHints& hints) {
    using namespace model_detect;
    SttCapabilities c;
    c.hasTransducer = !paths.encoder.empty() && !paths.decoder.empty() && !paths.joiner.empty();
    bool hasWhisperEnc = !paths.encoder.empty();
    bool hasWhisperDec = !paths.decoder.empty();
    c.hasWhisper = hasWhisperEnc && hasWhisperDec && paths.joiner.empty();
    bool hasFunAsrTok = !paths.funasrTokenizerDir.empty();
    c.hasFunAsrNano = !paths.funasrEncoderAdaptor.empty() && !paths.funasrLLM.empty() &&
                      !paths.funasrEmbedding.empty() && hasFunAsrTok;
    c.hasMoonshine = !paths.moonshinePreprocessor.empty() && !paths.moonshineUncachedDecoder.empty() &&
                     !paths.moonshineCachedDecoder.empty() && !paths.moonshineEncoder.empty();
    c.hasMoonshineV2 = !paths.moonshineMergedDecoder.empty() && !paths.encoderForV2.empty() && paths.joiner.empty();
    // Streaming paraformer uses encoder.onnx + decoder.onnx (no joiner, no single "model.onnx").
    c.hasParaformer = !paths.paraformerModel.empty() ||
        (hints.isLikelyParaformer && hasWhisperEnc && hasWhisperDec && paths.joiner.empty());
    c.hasDolphin = hints.isLikelyDolphin && !paths.ctcModel.empty();
    // Fire Red ASR: only encoder+decoder (two files). Single-file Fire Red (e.g. fire-red-asr2-ctc) uses CTC path to avoid native crash.
    c.hasFireRedAsr = (c.hasTransducer || (hasWhisperEnc && hasWhisperDec && paths.joiner.empty())) && hints.isLikelyFireRedAsr;
    c.hasFireRedCtc = hints.isLikelyFireRedAsr && paths.encoder.empty() && paths.decoder.empty() &&
        (!paths.ctcModel.empty() || !paths.paraformerModel.empty());
    c.hasCanary = hasWhisperEnc && hasWhisperDec && paths.joiner.empty() && hints.isLikelyCanary;
    c.hasOmnilingual = !paths.ctcModel.empty() && hints.isLikelyOmnilingual;
    c.hasMedAsr = !paths.ctcModel.empty() && hints.isLikelyMedAsr;
    c.hasTeleSpeechCtc = (!paths.ctcModel.empty() || !paths.paraformerModel.empty()) && hints.isLikelyTeleSpeech;
    c.hasToneCtc = !paths.ctcModel.empty() && hints.isLikelyToneCtc;
    return c;
}

static void CollectDetectedModels(
    std::vector<DetectedModel>& out,
    const SttCapabilities& cap,
    const SttPathHints& hints,
    const SttCandidatePaths& paths,
    const std::string& modelDir
) {
    if (cap.hasTransducer) {
        out.push_back({(hints.isLikelyNemo || hints.isLikelyTdt) ? "nemo_transducer" : "transducer", modelDir});
    }
    if (!paths.ctcModel.empty() && (hints.isLikelyNemo || hints.isLikelyWenetCtc || hints.isLikelySenseVoice || hints.isLikelyZipformer)) {
        if (hints.isLikelyNemo) out.push_back({"nemo_ctc", modelDir});
        else if (hints.isLikelyWenetCtc) out.push_back({"wenet_ctc", modelDir});
        else if (hints.isLikelySenseVoice) out.push_back({"sense_voice", modelDir});
        else out.push_back({"zipformer_ctc", modelDir});
    } else if (!paths.paraformerModel.empty()) {
        out.push_back({"paraformer", modelDir});
    }
    if (cap.hasWhisper) out.push_back({"whisper", modelDir});
    if (cap.hasFunAsrNano) out.push_back({"funasr_nano", modelDir});
    if (cap.hasMoonshine) out.push_back({"moonshine", modelDir});
    if (cap.hasMoonshineV2) out.push_back({"moonshine_v2", modelDir});
    if (cap.hasDolphin) out.push_back({"dolphin", modelDir});
    if (cap.hasFireRedAsr) out.push_back({"fire_red_asr", modelDir});
    if (cap.hasCanary) out.push_back({"canary", modelDir});
    if (cap.hasOmnilingual) out.push_back({"omnilingual", modelDir});
    if (cap.hasMedAsr) out.push_back({"medasr", modelDir});
    if (cap.hasTeleSpeechCtc) out.push_back({"telespeech_ctc", modelDir});
    if (cap.hasToneCtc) out.push_back({"tone_ctc", modelDir});
}

static SttModelKind ResolveSttKind(
    const std::optional<std::string>& modelType,
    const SttCapabilities& cap,
    const SttPathHints& hints,
    const SttCandidatePaths& paths,
    const std::string& modelDir,
    std::string& outError
) {
    outError.clear();
    if (hints.isLikelyVad) {
        outError = "VAD models are not yet supported by the React Native SDK.";
        return SttModelKind::kUnknown;
    }
    if (hints.isLikelyTdnn) {
        outError = "TDNN (keyword/yesno) models are not yet supported by the React Native SDK.";
        return SttModelKind::kUnknown;
    }
    if (modelType.has_value() && modelType.value() != "auto") {
        SttModelKind selected = ParseSttModelType(modelType.value());
        if (selected == SttModelKind::kUnknown) {
            outError = "Unknown model type: " + modelType.value();
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kTransducer && !cap.hasTransducer) {
            outError = "Transducer model requested but files not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kNemoTransducer && !cap.hasTransducer) {
            outError = "NeMo Transducer model requested but encoder/decoder/joiner not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kParaformer && !cap.hasParaformer) {
            outError = "Paraformer model requested but model file (or encoder+decoder for streaming) not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if ((selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
             selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc ||
             selected == SttModelKind::kToneCtc) && paths.ctcModel.empty()) {
            outError = "CTC model requested but model file not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kWhisper && !cap.hasWhisper) {
            outError = "Whisper model requested but encoder/decoder not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kFunAsrNano && !cap.hasFunAsrNano) {
            outError = "FunASR Nano model requested but required files not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kMoonshine && !cap.hasMoonshine) {
            outError = "Moonshine v1 model requested but preprocess/encode/uncached_decode/cached_decode not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kMoonshineV2 && !cap.hasMoonshineV2) {
            outError = "Moonshine v2 model requested but encoder/merged_decode not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kDolphin && !cap.hasDolphin) {
            outError = "Dolphin model requested but model not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kFireRedAsr && !cap.hasFireRedAsr) {
            outError = "FireRed ASR model requested but encoder/decoder not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kCanary && !cap.hasCanary) {
            outError = "Canary model requested but encoder/decoder not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kOmnilingual && !cap.hasOmnilingual) {
            outError = "Omnilingual model requested but model not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kMedAsr && !cap.hasMedAsr) {
            outError = "MedASR model requested but model not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kTeleSpeechCtc && !cap.hasTeleSpeechCtc) {
            outError = "TeleSpeech CTC model requested but model not found in " + modelDir;
            return SttModelKind::kUnknown;
        }
        if (selected == SttModelKind::kToneCtc && !cap.hasToneCtc) {
            outError = "Tone CTC model requested but path does not contain 'tone' (as a word), 't-one', or 't_one' (e.g. sherpa-onnx-streaming-t-one-*) in " + modelDir;
            return SttModelKind::kUnknown;
        }
        return selected;
    }

    // Auto: Priority 1 – resolve from folder name candidates; Priority 2 – file-based disambiguation.
    std::vector<SttModelKind> nameCandidates = GetKindsFromDirName(modelDir);
    if (!nameCandidates.empty()) {
        for (SttModelKind k : nameCandidates) {
            if (CapabilitySupportsKind(k, cap, hints, paths))
                return k;
        }
        // Name hinted at a model type but no candidate had required files; fall through to file-only.
    }

    // Fallback: no name-based candidates, or none supported – use file-only detection order.
    if (cap.hasTransducer) {
        return (hints.isLikelyNemo || hints.isLikelyTdt) ? SttModelKind::kNemoTransducer : SttModelKind::kTransducer;
    }
    if (hints.isLikelyMoonshine && cap.hasMoonshineV2) return SttModelKind::kMoonshineV2;
    if (hints.isLikelyMoonshine && cap.hasMoonshine) return SttModelKind::kMoonshine;
    if (!paths.ctcModel.empty() && (hints.isLikelyToneCtc || hints.isLikelyNemo || hints.isLikelyWenetCtc || hints.isLikelySenseVoice)) {
        if (hints.isLikelyToneCtc) return SttModelKind::kToneCtc;
        if (hints.isLikelyNemo) return SttModelKind::kNemoCtc;
        if (hints.isLikelyWenetCtc) return SttModelKind::kWenetCtc;
        return SttModelKind::kSenseVoice;
    }
    if (cap.hasFunAsrNano && hints.isLikelyFunAsrNano) return SttModelKind::kFunAsrNano;
    if (cap.hasFireRedCtc) return SttModelKind::kZipformerCtc;
    if (!paths.paraformerModel.empty()) return SttModelKind::kParaformer;
    if (cap.hasCanary) return SttModelKind::kCanary;
    if (cap.hasFireRedAsr) return SttModelKind::kFireRedAsr;
    if (cap.hasWhisper) return SttModelKind::kWhisper;
    if (cap.hasFunAsrNano) return SttModelKind::kFunAsrNano;
    if (cap.hasMoonshineV2) return SttModelKind::kMoonshineV2;
    if (cap.hasDolphin) return SttModelKind::kDolphin;
    if (cap.hasOmnilingual) return SttModelKind::kOmnilingual;
    if (cap.hasMedAsr) return SttModelKind::kMedAsr;
    if (cap.hasTeleSpeechCtc) return SttModelKind::kTeleSpeechCtc;
    if (cap.hasToneCtc) return SttModelKind::kToneCtc;
    if (!paths.ctcModel.empty()) return SttModelKind::kZipformerCtc;
    return SttModelKind::kUnknown;
}

static void ApplyPathsForSttKind(SttModelKind kind, const SttCandidatePaths& candidate, SttModelPaths& resultPaths) {
    switch (kind) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
            resultPaths.encoder = candidate.encoder;
            resultPaths.decoder = candidate.decoder;
            resultPaths.joiner = candidate.joiner;
            break;
        case SttModelKind::kParaformer:
            resultPaths.paraformerModel = candidate.paraformerModel;
            // Streaming paraformer: encoder.onnx + decoder.onnx (no single model.onnx).
            if (resultPaths.paraformerModel.empty() && !candidate.encoder.empty() && !candidate.decoder.empty()) {
                resultPaths.encoder = candidate.encoder;
                resultPaths.decoder = candidate.decoder;
            }
            break;
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kSenseVoice:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            resultPaths.ctcModel = candidate.ctcModel;
            break;
        case SttModelKind::kWhisper:
            resultPaths.whisperEncoder = candidate.encoder;
            resultPaths.whisperDecoder = candidate.decoder;
            break;
        case SttModelKind::kFunAsrNano:
            resultPaths.funasrEncoderAdaptor = candidate.funasrEncoderAdaptor;
            resultPaths.funasrLLM = candidate.funasrLLM;
            resultPaths.funasrEmbedding = candidate.funasrEmbedding;
            resultPaths.funasrTokenizer = candidate.funasrTokenizerDir;
            break;
        case SttModelKind::kMoonshine:
            resultPaths.moonshinePreprocessor = candidate.moonshinePreprocessor;
            resultPaths.moonshineEncoder = candidate.moonshineEncoder;
            resultPaths.moonshineUncachedDecoder = candidate.moonshineUncachedDecoder;
            resultPaths.moonshineCachedDecoder = candidate.moonshineCachedDecoder;
            break;
        case SttModelKind::kMoonshineV2:
            resultPaths.moonshineEncoder = candidate.encoderForV2;
            resultPaths.moonshineMergedDecoder = candidate.moonshineMergedDecoder;
            break;
        case SttModelKind::kDolphin:
            resultPaths.dolphinModel = candidate.ctcModel.empty() ? candidate.paraformerModel : candidate.ctcModel;
            break;
        case SttModelKind::kFireRedAsr: {
            std::string singleModel = candidate.paraformerModel.empty() ? candidate.ctcModel : candidate.paraformerModel;
            resultPaths.fireRedEncoder = candidate.encoder.empty() ? singleModel : candidate.encoder;
            resultPaths.fireRedDecoder = candidate.decoder.empty() ? singleModel : candidate.decoder;
            break;
        }
        case SttModelKind::kCanary:
            resultPaths.canaryEncoder = candidate.encoder;
            resultPaths.canaryDecoder = candidate.decoder;
            break;
        case SttModelKind::kOmnilingual:
            resultPaths.omnilingualModel = candidate.ctcModel;
            break;
        case SttModelKind::kMedAsr:
            resultPaths.medasrModel = candidate.ctcModel;
            break;
        case SttModelKind::kTeleSpeechCtc:
            resultPaths.telespeechCtcModel = candidate.ctcModel.empty() ? candidate.paraformerModel : candidate.ctcModel;
            break;
        default:
            break;
    }
}

} // namespace

SttDetectResult DetectSttModel(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType,
    bool debug /* = false */
) {
    using namespace model_detect;

    SttDetectResult result;

    LOGI("DetectSttModel: modelDir=%s, modelType=%s, preferInt8=%s",
         modelDir.c_str(),
         modelType.has_value() ? modelType->c_str() : "auto",
         preferInt8.has_value() ? (preferInt8.value() ? "true" : "false") : "unset");

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        LOGE("%s", result.error.c_str());
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }

    // Depth 4 supports layouts like root/data/lang_bpe_500/tokens.txt (icefall, k2)
    const int kMaxSearchDepth = 4;
    const auto files = ListFilesRecursive(modelDir, kMaxSearchDepth);
    bool verbose = debug;
    LOGI("DetectSttModel: Found %zu files in %s (verbose=%d)", files.size(), modelDir.c_str(), (int)verbose);
    if (verbose) {
        for (const auto& f : files) {
            LOGI("  file: %s (size=%llu)", f.path.c_str(), (unsigned long long)f.size);
        }
    } else {
        LOGI("(detailed file listing suppressed; enable by passing debug=true to initialize())");
    }

    SttCandidatePaths candidate = GatherSttCandidatePaths(files, modelDir, kMaxSearchDepth, preferInt8);
    SttPathHints hints = GetSttPathHints(modelDir);
    SttCapabilities cap = ComputeSttCapabilities(candidate, hints);
    if (debug) {
        LOGI("DetectSttModel: tokens=%s", EmptyOrPath(candidate.tokens));
        LOGI("DetectSttModel: transducer encoder=%s decoder=%s joiner=%s",
            EmptyOrPath(candidate.encoder), EmptyOrPath(candidate.decoder), EmptyOrPath(candidate.joiner));
        LOGI("DetectSttModel: paraformerModel=%s ctcModel=%s tokens=%s bpeVocab=%s",
            EmptyOrPath(candidate.paraformerModel), EmptyOrPath(candidate.ctcModel), EmptyOrPath(candidate.tokens), EmptyOrPath(candidate.bpeVocab));
        LOGI("DetectSttModel: moonshine preprocessor=%s encoder=%s uncachedDecoder=%s cachedDecoder=%s mergedDecoder=%s",
            EmptyOrPath(candidate.moonshinePreprocessor), EmptyOrPath(candidate.moonshineEncoder), EmptyOrPath(candidate.moonshineUncachedDecoder),
            EmptyOrPath(candidate.moonshineCachedDecoder), EmptyOrPath(candidate.moonshineMergedDecoder));
        LOGI("DetectSttModel: whisper encoder=%s decoder=%s (same as transducer; joiner empty => whisper)",
            EmptyOrPath(candidate.encoder), EmptyOrPath(candidate.decoder));
        LOGI("DetectSttModel: funasr encoderAdaptor=%s llm=%s embedding=%s tokenizerDir=%s",
            EmptyOrPath(candidate.funasrEncoderAdaptor), EmptyOrPath(candidate.funasrLLM), EmptyOrPath(candidate.funasrEmbedding), EmptyOrPath(candidate.funasrTokenizerDir));
        LOGI("DetectSttModel: hasTransducer=%d hasWhisper=%d hasMoonshine=%d hasMoonshineV2=%d hasParaformer=%d hasFunAsrNano=%d hasDolphin=%d hasFireRedAsr=%d hasFireRedCtc=%d hasCanary=%d hasOmnilingual=%d hasMedAsr=%d hasTeleSpeechCtc=%d hasToneCtc=%d",
            (int)cap.hasTransducer, (int)cap.hasWhisper, (int)cap.hasMoonshine, (int)cap.hasMoonshineV2,
            (int)cap.hasParaformer, (int)cap.hasFunAsrNano, (int)cap.hasDolphin, (int)cap.hasFireRedAsr, (int)cap.hasFireRedCtc,
            (int)cap.hasCanary, (int)cap.hasOmnilingual, (int)cap.hasMedAsr, (int)cap.hasTeleSpeechCtc, (int)cap.hasToneCtc);
        LOGI("DetectSttModel: hints isLikelyNemo=%d isLikelyTdt=%d isLikelyWenetCtc=%d isLikelySenseVoice=%d isLikelyFunAsrNano=%d isLikelyZipformer=%d isLikelyMoonshine=%d isLikelyDolphin=%d isLikelyFireRedAsr=%d isLikelyCanary=%d isLikelyOmnilingual=%d isLikelyMedAsr=%d isLikelyTeleSpeech=%d isLikelyToneCtc=%d isLikelyParaformer=%d isLikelyVad=%d isLikelyTdnn=%d",
             (int)hints.isLikelyNemo, (int)hints.isLikelyTdt, (int)hints.isLikelyWenetCtc, (int)hints.isLikelySenseVoice,
             (int)hints.isLikelyFunAsrNano, (int)hints.isLikelyZipformer, (int)hints.isLikelyMoonshine, (int)hints.isLikelyDolphin,
             (int)hints.isLikelyFireRedAsr, (int)hints.isLikelyCanary, (int)hints.isLikelyOmnilingual, (int)hints.isLikelyMedAsr,
             (int)hints.isLikelyTeleSpeech, (int)hints.isLikelyToneCtc, (int)hints.isLikelyParaformer, (int)hints.isLikelyVad, (int)hints.isLikelyTdnn);
    }

    CollectDetectedModels(result.detectedModels, cap, hints, candidate, modelDir);

    result.selectedKind = ResolveSttKind(modelType, cap, hints, candidate, modelDir, result.error);
    if (result.selectedKind == SttModelKind::kUnknown) {
        if (IsHardwareSpecificModelDir(modelDir)) {
            result.ok = false;
            result.isHardwareSpecificUnsupported = true;
            result.error = kHardwareSpecificUnsupportedMessage;
            LOGE("%s", result.error.c_str());
            return result;
        }
        if (!result.error.empty()) {
            LOGE("%s", result.error.c_str());
            return result;
        }
        result.error = "No compatible model type detected in " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }

    LOGI("DetectSttModel: selected kind=%d (%s)", static_cast<int>(result.selectedKind), KindToName(result.selectedKind));
    result.tokensRequired = (result.selectedKind != SttModelKind::kFunAsrNano);
    ApplyPathsForSttKind(result.selectedKind, candidate, result.paths);

    if (!candidate.tokens.empty() && FileExists(candidate.tokens)) {
        result.paths.tokens = candidate.tokens;
    } else if (result.tokensRequired) {
        result.error = "Tokens file not found in " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }
    if (!candidate.bpeVocab.empty() && FileExists(candidate.bpeVocab)) {
        result.paths.bpeVocab = candidate.bpeVocab;
    }

    // Log paths actually set for the selected kind (so we can verify nothing is missing).
    switch (result.selectedKind) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
            LOGI("DetectSttModel: paths set encoder=%s decoder=%s joiner=%s",
                 EmptyOrPath(result.paths.encoder), EmptyOrPath(result.paths.decoder), EmptyOrPath(result.paths.joiner));
            break;
        case SttModelKind::kParaformer:
            LOGI("DetectSttModel: paths set paraformerModel=%s", EmptyOrPath(result.paths.paraformerModel));
            break;
        case SttModelKind::kWhisper:
            LOGI("DetectSttModel: paths set whisperEncoder=%s whisperDecoder=%s",
                 EmptyOrPath(result.paths.whisperEncoder), EmptyOrPath(result.paths.whisperDecoder));
            break;
        case SttModelKind::kMoonshine:
            LOGI("DetectSttModel: paths set moonshine preprocessor=%s encoder=%s uncachedDecoder=%s cachedDecoder=%s",
                 EmptyOrPath(result.paths.moonshinePreprocessor), EmptyOrPath(result.paths.moonshineEncoder),
                 EmptyOrPath(result.paths.moonshineUncachedDecoder), EmptyOrPath(result.paths.moonshineCachedDecoder));
            break;
        case SttModelKind::kMoonshineV2:
            LOGI("DetectSttModel: paths set moonshine_v2 encoder=%s mergedDecoder=%s",
                 EmptyOrPath(result.paths.moonshineEncoder), EmptyOrPath(result.paths.moonshineMergedDecoder));
            break;
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kSenseVoice:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            LOGI("DetectSttModel: paths set ctcModel=%s", EmptyOrPath(result.paths.ctcModel));
            break;
        case SttModelKind::kFireRedAsr:
            LOGI("DetectSttModel: paths set fireRedEncoder=%s fireRedDecoder=%s",
                 EmptyOrPath(result.paths.fireRedEncoder), EmptyOrPath(result.paths.fireRedDecoder));
            break;
        case SttModelKind::kFunAsrNano:
            LOGI("DetectSttModel: paths set funasr adaptor=%s llm=%s embedding=%s tokenizer=%s",
                 EmptyOrPath(result.paths.funasrEncoderAdaptor), EmptyOrPath(result.paths.funasrLLM),
                 EmptyOrPath(result.paths.funasrEmbedding), EmptyOrPath(result.paths.funasrTokenizer));
            break;
        default:
            break;
    }
    LOGI("DetectSttModel: tokens=%s (required=%d)", EmptyOrPath(result.paths.tokens), (int)result.tokensRequired);
    LOGI("DetectSttModel: detection OK for %s", modelDir.c_str());
    result.ok = true;
    return result;
}

// Test-only: used by host-side model_detect_test; not used in production (Android/iOS use DetectSttModel).
SttDetectResult DetectSttModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType
) {
    using namespace model_detect;

    SttDetectResult result;
    const int kMaxSearchDepth = 4;

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        return result;
    }

    SttCandidatePaths candidate = GatherSttCandidatePaths(files, modelDir, kMaxSearchDepth, preferInt8);
    SttPathHints hints = GetSttPathHints(modelDir);
    SttCapabilities cap = ComputeSttCapabilities(candidate, hints);

    CollectDetectedModels(result.detectedModels, cap, hints, candidate, modelDir);

    result.selectedKind = ResolveSttKind(modelType, cap, hints, candidate, modelDir, result.error);
    if (result.selectedKind == SttModelKind::kUnknown) {
        if (IsHardwareSpecificModelDir(modelDir)) {
            result.ok = false;
            result.isHardwareSpecificUnsupported = true;
            result.error = kHardwareSpecificUnsupportedMessage;
            return result;
        }
        if (result.error.empty())
            result.error = "No compatible model type detected in " + modelDir;
        result.ok = false;
        return result;
    }

    result.tokensRequired = (result.selectedKind != SttModelKind::kFunAsrNano);
    ApplyPathsForSttKind(result.selectedKind, candidate, result.paths);

    result.paths.tokens = candidate.tokens;
    result.paths.bpeVocab = candidate.bpeVocab;

    if (result.tokensRequired && candidate.tokens.empty()) {
        result.error = "Tokens file not found in " + modelDir;
        result.ok = false;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace sherpaonnx
