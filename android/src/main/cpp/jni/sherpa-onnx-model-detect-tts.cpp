#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

namespace sherpaonnx {
namespace {

TtsModelKind ParseTtsModelType(const std::string& modelType) {
    if (modelType == "vits") return TtsModelKind::kVits;
    if (modelType == "matcha") return TtsModelKind::kMatcha;
    if (modelType == "kokoro") return TtsModelKind::kKokoro;
    if (modelType == "kitten") return TtsModelKind::kKitten;
    if (modelType == "zipvoice") return TtsModelKind::kZipvoice;
    return TtsModelKind::kUnknown;
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

    const auto files = ListFilesRecursive(modelDir, 2);

    std::string tokensFile = FindFileByName(modelDir, "tokens.txt", 2);
    std::string lexiconFile = FindFileByName(modelDir, "lexicon.txt", 2);
    std::string dataDirPath = FindDirectoryByName(modelDir, "espeak-ng-data", 2);
    std::string voicesFile = FindFileByName(modelDir, "voices.bin", 2);

    std::string acousticModel = FindOnnxByAnyToken(files, {"acoustic_model", "acoustic-model"}, std::nullopt);
    std::string vocoder = FindOnnxByAnyToken(files, {"vocoder"}, std::nullopt);
    std::string encoder = FindOnnxByAnyToken(files, {"encoder"}, std::nullopt);
    std::string decoder = FindOnnxByAnyToken(files, {"decoder"}, std::nullopt);

    std::vector<std::string> modelExcludes = {
        "acoustic",
        "vocoder",
        "encoder",
        "decoder",
        "joiner"
    };

    std::string ttsModel = FindOnnxByAnyToken(files, {"model"}, std::nullopt);
    if (ttsModel.empty()) {
        ttsModel = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    bool hasVits = !ttsModel.empty();
    bool hasMatcha = !acousticModel.empty() && !vocoder.empty();
    bool hasVoicesFile = !voicesFile.empty() && FileExists(voicesFile);
    bool hasZipvoice = !encoder.empty() && !decoder.empty() && !vocoder.empty();
    bool hasDataDir = !dataDirPath.empty() && IsDirectory(dataDirPath);

    std::string modelDirLower = ToLower(modelDir);
    bool isLikelyKitten = modelDirLower.find("kitten") != std::string::npos;
    bool isLikelyKokoro = modelDirLower.find("kokoro") != std::string::npos;

    if (hasMatcha) {
        result.detectedModels.push_back({"matcha", modelDir});
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
            if (isLikelyVits || voicesAmbiguous) {
                addVits = true;
            }
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
        if (hasMatcha) {
            selected = TtsModelKind::kMatcha;
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
    if ((selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten) && (!hasVits || !hasVoicesFile)) {
        result.error = "TTS: Kokoro/Kitten model requested but required files not found in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kZipvoice && !hasZipvoice) {
        result.error = "TTS: Zipvoice model requested but required files not found in " + modelDir;
        return result;
    }
    if ((selected == TtsModelKind::kVits || selected == TtsModelKind::kMatcha ||
         selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten ||
         selected == TtsModelKind::kZipvoice) &&
        !hasDataDir) {
        result.error = "TTS: espeak-ng-data not found in " + modelDir +
                       ". Copy espeak-ng-data into the model directory.";
        return result;
    }

    result.selectedKind = selected;
    result.paths.ttsModel = ttsModel;
    result.paths.tokens = tokensFile;
    result.paths.lexicon = !lexiconFile.empty() && FileExists(lexiconFile) ? lexiconFile : "";
    result.paths.dataDir = dataDirPath;
    result.paths.voices = voicesFile;
    result.paths.acousticModel = acousticModel;
    result.paths.vocoder = vocoder;
    result.paths.encoder = encoder;
    result.paths.decoder = decoder;

    if (tokensFile.empty() || !FileExists(tokensFile)) {
        result.error = "TTS: tokens.txt not found in " + modelDir;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace sherpaonnx
