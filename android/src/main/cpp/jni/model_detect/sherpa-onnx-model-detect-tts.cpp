/**
 * sherpa-onnx-model-detect-tts.cpp
 *
 * Purpose: Detects TTS model type and fills TtsModelPaths from a model directory. Used by
 * nativeDetectTtsModel (module-jni). Supports Vits, Matcha, Kokoro, Kitten, Pocket, Zipvoice.
 *
 * --- Detection pipeline (overview) ---
 *
 * 1. Gather files in modelDir (recursive), then map file names to logical paths (ttsModel,
 *    acousticModel, vocoder, encoder, decoder, lmFlow, lmMain, textConditioner, tokens, lexicon,
 *    dataDir, voices, vocabJson, tokenScoresJson). Path hints from directory name (isLikelyVits,
 *    isLikelyKitten, isLikelyKokoro).
 *
 * 2. Capabilities (hasVits, hasMatcha, hasPocket, hasZipvoice, hasVoicesFile, hasDataDir): which
 *    model types are *possible* given the paths. Multiple can be true (e.g. voices.bin can satisfy
 *    both Kokoro and Kitten).
 *
 * 3. detectedModels (for UI "Select model type"): built from capabilities only. Every kind with
 *    the corresponding has* == true is added (with existing rules: zipvoice only if !hasMatcha,
 *    vits when hasVits and no voices or ambiguous folder name).
 *
 * 4. selectedKind: from ResolveTtsKind(). If modelType is explicit, use it if capabilities allow.
 *    If modelType == "auto": Priority 1 = folder name (GetKindsFromDirNameTts: tokens like "vits",
 *    "matcha", "kokoro" in dir name --> candidate kinds). Priority 2 = among those candidates, pick
 *    the first that CapabilitySupportsTtsKind(). Fallback = file-only order (matcha --> pocket -->
 *    zipvoice --> kokoro/kitten --> vits).
 *
 * 5. paths: all gathered paths are written into result.paths; the selected kind determines which
 *    engine is used at runtime.
 *
 * Result to caller: ok, error, detectedModels (list), selectedKind (single), paths.
 */
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include <algorithm>
#include <string>
#include <vector>
#ifdef __ANDROID__
#include <android/log.h>
#define LOG_TAG "TtsModelDetect"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

namespace sherpaonnx {
namespace {

TtsModelKind ParseTtsModelType(const std::string& modelType) {
    if (modelType == "vits") return TtsModelKind::kVits;
    if (modelType == "matcha") return TtsModelKind::kMatcha;
    if (modelType == "kokoro") return TtsModelKind::kKokoro;
    if (modelType == "kitten") return TtsModelKind::kKitten;
    if (modelType == "pocket") return TtsModelKind::kPocket;
    if (modelType == "zipvoice") return TtsModelKind::kZipvoice;
    return TtsModelKind::kUnknown;
}

/** Returns true if the given kind is supported by the current paths and hints (required files present).
 *  data_dir (espeak-ng-data) is required only for Kitten and Kokoro (sherpa-onnx config Validate());
 *  VITS, Matcha, Zipvoice use it optionally; Pocket does not use it. */
static bool CapabilitySupportsTtsKind(
    TtsModelKind kind,
    bool hasVits,
    bool hasMatcha,
    bool hasPocket,
    bool hasZipvoice,
    bool hasVoicesFile,
    bool hasDataDir
) {
    switch (kind) {
        case TtsModelKind::kVits:
            return hasVits;
        case TtsModelKind::kMatcha:
            return hasMatcha;
        case TtsModelKind::kKokoro:
        case TtsModelKind::kKitten:
            return hasVoicesFile && hasDataDir;
        case TtsModelKind::kPocket:
            return hasPocket;
        case TtsModelKind::kZipvoice:
            return hasZipvoice;
        default:
            return false;
    }
}

/**
 * Priority 1: Collect candidate TTS kinds from the model directory name (last path component).
 * Tokens like "vits", "matcha", "kokoro" are matched case-insensitively. Returns candidates in a
 * fixed priority order for file-based disambiguation when multiple names match.
 */
static std::vector<TtsModelKind> GetKindsFromDirNameTts(const std::string& modelDir) {
    using namespace model_detect;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    std::vector<TtsModelKind> out;
    auto add = [&out](TtsModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end())
            out.push_back(k);
    };

    if (lower.find("matcha") != std::string::npos) add(TtsModelKind::kMatcha);
    if (lower.find("pocket") != std::string::npos) add(TtsModelKind::kPocket);
    if (lower.find("zipvoice") != std::string::npos) add(TtsModelKind::kZipvoice);
    if (lower.find("kokoro") != std::string::npos) add(TtsModelKind::kKokoro);
    if (lower.find("kitten") != std::string::npos) add(TtsModelKind::kKitten);
    if (lower.find("vits") != std::string::npos) add(TtsModelKind::kVits);

    return out;
}

/** Shared detection logic: runs on a pre-built file list. No filesystem access, no logging. */
static TtsDetectResult DetectTtsModelFromFiles(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    using namespace model_detect;

    TtsDetectResult result;

    std::string tokensFile = FindFileByName(files, "tokens.txt");
    std::string lexiconFile = FindFileByName(files, "lexicon.txt");
    std::string dataDirPath = FindDirectoryUnderRoot(files, modelDir, "espeak-ng-data");
    std::string voicesFile = FindFileByName(files, "voices.bin");

    std::string acousticModel = FindOnnxByAnyToken(files, {"acoustic_model", "acoustic-model"}, std::nullopt);
    std::string vocoder = FindOnnxByAnyToken(files, {"vocoder", "vocos"}, std::nullopt);
    std::string encoder = FindOnnxByAnyToken(files, {"encoder"}, std::nullopt);
    std::string decoder = FindOnnxByAnyToken(files, {"decoder"}, std::nullopt);
    std::string lmFlow = FindOnnxByAnyToken(files, {"lm_flow", "lm-flow"}, std::nullopt);
    std::string lmMain = FindOnnxByAnyToken(files, {"lm_main", "lm-main"}, std::nullopt);
    std::string textConditioner = FindOnnxByAnyToken(files, {"text_conditioner", "text-conditioner"}, std::nullopt);
    std::string vocabJsonFile = FindFileByName(files, "vocab.json");
    std::string tokenScoresJsonFile = FindFileByName(files, "token_scores.json");

    std::vector<std::string> modelExcludes = {
        "acoustic", "vocoder", "encoder", "decoder", "joiner"
    };
    std::string ttsModel = FindOnnxByAnyToken(files, {"model"}, std::nullopt);
    if (ttsModel.empty()) {
        ttsModel = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    bool hasVits = !ttsModel.empty();
    bool hasMatcha = !acousticModel.empty() && !vocoder.empty();
    bool hasVoicesFile = !voicesFile.empty();
    bool hasZipvoice = !encoder.empty() && !decoder.empty() && !vocoder.empty();
    bool hasPocket = !lmFlow.empty() && !lmMain.empty() && !encoder.empty() && !decoder.empty() &&
                     !textConditioner.empty() && !vocabJsonFile.empty() && !tokenScoresJsonFile.empty();
    bool hasDataDir = !dataDirPath.empty();

    std::string modelDirLower = ToLower(modelDir);
    bool isLikelyKitten = modelDirLower.find("kitten") != std::string::npos;
    bool isLikelyKokoro = modelDirLower.find("kokoro") != std::string::npos;

    if (hasMatcha) result.detectedModels.push_back({"matcha", modelDir});
    if (hasPocket) result.detectedModels.push_back({"pocket", modelDir});
    if (hasZipvoice && !hasMatcha) result.detectedModels.push_back({"zipvoice", modelDir});
    if (hasVoicesFile) {
        if (isLikelyKitten && !isLikelyKokoro) {
            result.detectedModels.push_back({"kitten", modelDir});
        } else if (isLikelyKokoro && !isLikelyKitten) {
            result.detectedModels.push_back({"kokoro", modelDir});
        } else {
            result.detectedModels.push_back({"kokoro", modelDir});
            result.detectedModels.push_back({"kitten", modelDir});
        }
    }
    if (hasVits) {
        bool isLikelyVits = modelDirLower.find("vits") != std::string::npos;
        bool voicesAmbiguous = !isLikelyKitten && !isLikelyKokoro;
        bool addVits = !hasVoicesFile || isLikelyVits || voicesAmbiguous;
        if (addVits) result.detectedModels.push_back({"vits", modelDir});
    }

    TtsModelKind selected = TtsModelKind::kUnknown;
    if (modelType != "auto") {
        selected = ParseTtsModelType(modelType);
        if (selected == TtsModelKind::kUnknown) {
            result.error = "TTS: Unknown model type: " + modelType;
            return result;
        }
    } else {
        std::vector<TtsModelKind> nameCandidates = GetKindsFromDirNameTts(modelDir);
        if (!nameCandidates.empty()) {
            for (TtsModelKind k : nameCandidates) {
                if (CapabilitySupportsTtsKind(k, hasVits, hasMatcha, hasPocket, hasZipvoice,
                                              hasVoicesFile, hasDataDir)) {
                    selected = k;
                    break;
                }
            }
        }
        if (selected == TtsModelKind::kUnknown) {
            if (hasMatcha) selected = TtsModelKind::kMatcha;
            else if (hasPocket) selected = TtsModelKind::kPocket;
            else if (hasZipvoice) selected = TtsModelKind::kZipvoice;
            else if (hasVoicesFile) {
                if (isLikelyKitten && !isLikelyKokoro) selected = TtsModelKind::kKitten;
                else if (isLikelyKokoro && !isLikelyKitten) selected = TtsModelKind::kKokoro;
                else selected = TtsModelKind::kKokoro;
            } else if (hasVits) selected = TtsModelKind::kVits;
        }
    }

    if (selected == TtsModelKind::kUnknown) {
        result.error = "TTS: No compatible model type detected in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kVits && !hasVits) {
        result.error = "TTS: VITS model requested but model file not found in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kMatcha && !hasMatcha) {
        result.error = "TTS: Matcha model requested but required files not found in " + modelDir;
        return result;
    }
    if ((selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten) && !hasVoicesFile) {
        result.error = "TTS: Kokoro/Kitten model requested but required files not found in " + modelDir;
        return result;
    }
    if ((selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten) && !hasDataDir) {
        result.error = "TTS: espeak-ng-data not found in " + modelDir +
                       ". Copy espeak-ng-data into the model directory.";
        return result;
    }
    if (selected == TtsModelKind::kPocket && !hasPocket) {
        result.error = "TTS: Pocket model requested but required files not found in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kZipvoice && !hasZipvoice) {
        result.error = "TTS: Zipvoice model requested but required files not found in " + modelDir;
        return result;
    }

    result.selectedKind = selected;
    result.paths.ttsModel = ttsModel;
    result.paths.tokens = tokensFile;
    result.paths.lexicon = !lexiconFile.empty() ? lexiconFile : "";
    result.paths.dataDir = dataDirPath;
    result.paths.voices = voicesFile;
    result.paths.acousticModel = acousticModel;
    result.paths.vocoder = vocoder;
    result.paths.encoder = encoder;
    result.paths.decoder = decoder;
    result.paths.lmFlow = lmFlow;
    result.paths.lmMain = lmMain;
    result.paths.textConditioner = textConditioner;
    result.paths.vocabJson = vocabJsonFile;
    result.paths.tokenScoresJson = tokenScoresJsonFile;

    if (selected != TtsModelKind::kPocket && tokensFile.empty()) {
        result.error = "TTS: tokens.txt not found in " + modelDir;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace

TtsDetectResult DetectTtsModel(const std::string& modelDir, const std::string& modelType) {
    using namespace model_detect;

    TtsDetectResult result;

    LOGI("DetectTtsModel: modelDir=%s, modelType=%s", modelDir.c_str(), modelType.c_str());

    if (modelDir.empty()) {
        result.error = "TTS: Model directory is empty";
        LOGE("%s", result.error.c_str());
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "TTS: Model directory does not exist or is not a directory: " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }

    const auto files = ListFilesRecursive(modelDir, 4);
    LOGI("DetectTtsModel: Found %zu files in %s", files.size(), modelDir.c_str());
    for (const auto& f : files) {
        LOGI("  file: %s (size=%llu)", f.path.c_str(), (unsigned long long)f.size);
    }

    result = DetectTtsModelFromFiles(files, modelDir, modelType);
    if (!result.ok) {
        if (!result.error.empty()) LOGE("%s", result.error.c_str());
        return result;
    }
    LOGI("DetectTtsModel: tokens=%s, lexicon=%s, dataDir=%s, voices=%s",
         result.paths.tokens.c_str(), result.paths.lexicon.c_str(),
         result.paths.dataDir.c_str(), result.paths.voices.c_str());
    LOGI("DetectTtsModel: selected kind=%d, ttsModel=%s",
         static_cast<int>(result.selectedKind), result.paths.ttsModel.c_str());
    LOGI("DetectTtsModel: final paths — tokens=%s, dataDir=%s",
         result.paths.tokens.c_str(), result.paths.dataDir.c_str());
    LOGI("DetectTtsModel: detection OK for %s", modelDir.c_str());
    return result;
}

// Test-only: used by host-side model_detect_test; not used in production (Android/iOS use DetectTtsModel).
TtsDetectResult DetectTtsModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    TtsDetectResult result;
    if (modelDir.empty()) {
        result.error = "TTS: Model directory is empty";
        return result;
    }
    return DetectTtsModelFromFiles(files, modelDir, modelType);
}

} // namespace sherpaonnx
