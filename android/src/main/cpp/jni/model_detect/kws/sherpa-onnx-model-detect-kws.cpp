#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-stt-online-guard.h"
#include "sherpa-onnx-catalog-metadata.h"
#include "sherpa-onnx-validate-kws.h"

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

/** True when keywords.txt is not at the model-dir root (e.g. test_wavs/keywords.txt). */
bool IsNestedKeywordsPath(const std::string& keywordsPath, const std::string& modelDir) {
    std::string rel = keywordsPath;
    if (!modelDir.empty() && keywordsPath.size() >= modelDir.size() &&
        keywordsPath.compare(0, modelDir.size(), modelDir) == 0) {
        size_t i = modelDir.size();
        if (i < keywordsPath.size() &&
            (keywordsPath[i] == '/' || keywordsPath[i] == '\\')) {
            ++i;
        }
        rel = keywordsPath.substr(i);
    }
    return rel.find('/') != std::string::npos || rel.find('\\') != std::string::npos;
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
        result.isStreaming = true;
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
    result.paths.keywords = FindFileByName(files, "keywords.txt");

    result.selectedKind = sherpaonnx::KwsModelKind::kTransducer;
    result.detectedModels.push_back({"transducer", modelDir});

    const auto validation =
        sherpaonnx::ValidateKwsPaths(result.selectedKind, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    // Nested keywords (e.g. test_wavs/keywords.txt in the zh-en release) are only
    // accepted when the pack name itself looks like KWS — otherwise an ASR
    // transducer with incidental nested keywords.txt would claim KWS before STT.
    if (IsNestedKeywordsPath(result.paths.keywords, modelDir) &&
        !LooksLikeKwsName(modelDir)) {
        result.error =
            "KWS: nested keywords.txt requires a KWS-like model directory/asset name "
            "(e.g. containing 'kws'); root-level keywords.txt is required otherwise";
        result.paths.keywords.clear();
        return result;
    }

    sherpaonnx::SttModelPaths guardPaths;
    guardPaths.encoder = result.paths.encoder;
    guardPaths.decoder = result.paths.decoder;
    guardPaths.joiner = result.paths.joiner;
    guardPaths.tokens = result.paths.tokens;
    const auto guard =
        sherpaonnx::stt::online_guard::GuardZipformer2TransducerOnlineCompatibility(
            guardPaths, modelDir);
    if (!guard.passed) {
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
    result.isStreaming = true;
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
