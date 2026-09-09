#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-stt-online-guard.h"
#include "sherpa-onnx-catalog-metadata.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

void AppendUnique(
    std::vector<sherpaonnx::DetectionSource>& out,
    sherpaonnx::DetectionSource source) {
    if (std::find(out.begin(), out.end(), source) == out.end()) {
        out.push_back(source);
    }
}

sherpaonnx::KwsModelKind ParseKind(const std::string& modelType) {
    if (modelType == "transducer") {
        return sherpaonnx::KwsModelKind::kTransducer;
    }
    return sherpaonnx::KwsModelKind::kUnknown;
}

bool LooksLikeKwsName(const std::string& value) {
    const std::string lower = ToLower(value);
    return lower.find("kws") != std::string::npos ||
           lower.find("keyword") != std::string::npos;
}

sherpaonnx::KwsDetectResult DetectFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization) {
    sherpaonnx::KwsDetectResult result;
    const std::string requested = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        if (requested != "auto" && ParseKind(requested) == sherpaonnx::KwsModelKind::kUnknown) {
            result.error = "KWS: unknown model type: " + requested;
            return result;
        }
        if (requested == "auto" && !LooksLikeKwsName(modelDir)) {
            result.error = "KWS: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = sherpaonnx::KwsModelKind::kTransducer;
        result.detectedModels.push_back({"transducer", modelDir});
        AppendUnique(
            result.detectionSources,
            requested == "auto" ? sherpaonnx::DetectionSource::kDirName
                                : sherpaonnx::DetectionSource::kExplicitModelType);
        result.error =
            "KWS: heuristic name-only detection cannot validate model files; "
            "run filesystem-backed detection for full validation and metadata guard checks.";
        return result;
    }

    AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);
    if (requested != "auto") {
        if (ParseKind(requested) == sherpaonnx::KwsModelKind::kUnknown) {
            result.error = "KWS: unknown model type: " + requested;
            return result;
        }
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    } else if (LooksLikeKwsName(modelDir)) {
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
    } else {
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
    }

    result.paths.encoder = FindOnnxByAnyToken(files, {"encoder"}, quantization);
    result.paths.decoder = FindOnnxByAnyToken(files, {"decoder"}, quantization);
    result.paths.joiner = FindOnnxByAnyToken(files, {"joiner"}, quantization);
    result.paths.tokens = FindFileByName(files, "tokens.txt");
    // Intentionally recursive: the zh-en release keeps this under test_wavs/.
    result.paths.keywords = FindFileByName(files, "keywords.txt");

    if (result.paths.encoder.empty() || result.paths.decoder.empty() ||
        result.paths.joiner.empty() || result.paths.tokens.empty() ||
        result.paths.keywords.empty()) {
        result.error =
            "KWS: requires encoder, decoder, joiner ONNX files, tokens.txt, and keywords.txt";
        return result;
    }

    result.selectedKind = sherpaonnx::KwsModelKind::kTransducer;
    result.detectedModels.push_back({"transducer", modelDir});

    sherpaonnx::SttModelPaths guardPaths;
    guardPaths.encoder = result.paths.encoder;
    guardPaths.decoder = result.paths.decoder;
    guardPaths.joiner = result.paths.joiner;
    guardPaths.tokens = result.paths.tokens;
    const auto guard = sherpaonnx::stt::online_guard::RunOnlineCompatibilityGuard(
        sherpaonnx::SttModelKind::kTransducer, guardPaths, modelDir);
    if (!guard.passed) {
        result.isStreaming = false;
        result.error = "KWS: online Zipformer2 transducer guard failed: " + guard.error;
        return result;
    }

    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(
        result.derivedLanguages, result.quantization, ignoredSizeTier, modelDir);
    if ((result.quantization.empty() || result.quantization == "unknown")) {
        const std::string fileQuant =
            sherpaonnx::DeriveQuantization(BaseName(result.paths.encoder));
        if (fileQuant != "unknown") {
            result.quantization = fileQuant;
        }
    }
    result.ok = true;
    return result;
}

}  // namespace

namespace sherpaonnx {

KwsDetectResult DetectKwsModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType,
    const std::string& quantization) {
    if ((!model_dir_opt || model_dir_opt->empty()) &&
        (!asset_name_opt || asset_name_opt->empty())) {
        KwsDetectResult result;
        result.error = "KWS: modelDir and assetName are both empty";
        return result;
    }
    if (!model_dir_opt || model_dir_opt->empty()) {
        return DetectFromFiles(
            {}, std::string("m/") + *asset_name_opt, modelType, quantization);
    }
    const std::string& modelDir = *model_dir_opt;
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        KwsDetectResult result;
        result.error = "KWS: model directory does not exist or is not a directory: " + modelDir;
        return result;
    }
    auto result = DetectFromFiles(
        model_detect::ListFilesRecursive(modelDir, 4), modelDir, modelType, quantization);
    if (asset_name_opt && (result.quantization.empty() || result.quantization == "unknown")) {
        std::string ignoredSizeTier;
        FillDerivedCatalogMetadata(
            result.derivedLanguages, result.quantization, ignoredSizeTier, *asset_name_opt);
    }
    return result;
}

KwsDetectResult DetectKwsModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization) {
    return DetectFromFiles(files, modelDir, modelType, quantization);
}

}  // namespace sherpaonnx
