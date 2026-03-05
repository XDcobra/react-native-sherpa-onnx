/**
 * sherpa-onnx-model-detect-tts.mm
 *
 * Purpose: Detects TTS (text-to-speech) model type and fills TtsModelPaths from a model directory.
 * Used by the TTS wrapper on iOS. Supports Vits, Matcha, Kokoro, Kitten, Pocket, Zipvoice.
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

namespace sherpaonnx {
namespace {

using namespace model_detect;

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

} // namespace

TtsDetectResult DetectTtsModel(const std::string& modelDir, const std::string& modelType) {
    using namespace model_detect;

    TtsDetectResult result;

    if (modelDir.empty()) {
        result.error = "TTS: Model directory is empty";
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "TTS: Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const int kMaxSearchDepth = 4;
    const std::vector<FileEntry> files = ListFilesRecursive(modelDir, kMaxSearchDepth);

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

    std::vector<std::string> modelExcludes = {"acoustic", "vocoder", "encoder", "decoder", "joiner"};
    std::string ttsModel = FindOnnxByAnyToken(files, {"model"}, std::nullopt);
    if (ttsModel.empty()) {
        ttsModel = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    bool hasVits = !ttsModel.empty();
    std::string modelDirLower = ToLower(modelDir);
    bool isLikelyMatcha = modelDirLower.find("matcha") != std::string::npos;
    bool hasMatcha = (!acousticModel.empty() && !vocoder.empty())
        || (isLikelyMatcha && !ttsModel.empty() && !tokensFile.empty());
    if (hasMatcha && acousticModel.empty())
        acousticModel = ttsModel;  // single-file Matcha: model.onnx is the acoustic model
    bool hasVoicesFile = !voicesFile.empty();
    bool isLikelyZipvoice = modelDirLower.find("zipvoice") != std::string::npos;
    bool hasZipvoice = !encoder.empty() && !decoder.empty() && !vocoder.empty();
    if (isLikelyZipvoice && !encoder.empty() && !decoder.empty() && vocoder.empty()) {
        result.ok = false;
        result.error = "TTS: Zipvoice distill variant (no vocoder) is not supported. Use a full Zipvoice model with vocoder or add vocos_24khz.onnx separately.";
        return result;
    }
    bool hasPocket = !lmFlow.empty() && !lmMain.empty() && !encoder.empty() && !decoder.empty() &&
                     !textConditioner.empty() && !vocabJsonFile.empty() && !tokenScoresJsonFile.empty();
    bool hasDataDir = !dataDirPath.empty();

    bool isLikelyKitten = modelDirLower.find("kitten") != std::string::npos;
    bool isLikelyKokoro = modelDirLower.find("kokoro") != std::string::npos;

    if (hasMatcha) {
        result.detectedModels.push_back({"matcha", modelDir});
    }
    if (hasPocket) {
        result.detectedModels.push_back({"pocket", modelDir});
    }
    if (hasZipvoice && !hasMatcha) {
        result.detectedModels.push_back({"zipvoice", modelDir});
    }
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
        bool addVits = false;
        if (!hasVoicesFile) {
            addVits = true;
        } else {
            if (isLikelyVits || voicesAmbiguous) addVits = true;
        }
        if (addVits) {
            result.detectedModels.push_back({"vits", modelDir});
        }
    }

    TtsModelKind selected = TtsModelKind::kUnknown;
    if (modelType != "auto") {
        selected = ParseTtsModelType(modelType);
        if (selected == TtsModelKind::kUnknown) {
            result.error = "TTS: Unknown model type: " + modelType;
            return result;
        }
    } else {
        // Auto: Priority 1 – folder name candidates; Priority 2 – file-based disambiguation.
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
        // Fallback: no name-based candidates or none supported – use file-only order.
        if (selected == TtsModelKind::kUnknown) {
            if (hasMatcha) {
                selected = TtsModelKind::kMatcha;
            } else if (hasPocket) {
                selected = TtsModelKind::kPocket;
            } else if (hasZipvoice) {
                selected = TtsModelKind::kZipvoice;
            } else if (hasVoicesFile) {
                if (isLikelyKitten && !isLikelyKokoro) {
                    selected = TtsModelKind::kKitten;
                } else if (isLikelyKokoro && !isLikelyKitten) {
                    selected = TtsModelKind::kKokoro;
                } else {
                    selected = TtsModelKind::kKokoro;
                }
            } else if (hasVits) {
                selected = TtsModelKind::kVits;
            }
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

} // namespace sherpaonnx
