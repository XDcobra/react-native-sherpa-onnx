#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-slid.h"
#include "sherpa-onnx-catalog-metadata.h"
#include "model_language_catalog.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::LanguageIdModelKind ParseLanguageIdModelType(
    const std::string& modelType
) {
    if (modelType == "whisper") return sherpaonnx::LanguageIdModelKind::kWhisper;
    return sherpaonnx::LanguageIdModelKind::kUnknown;
}

const char* LanguageIdKindToTag(sherpaonnx::LanguageIdModelKind kind) {
    switch (kind) {
        case sherpaonnx::LanguageIdModelKind::kWhisper:
            return "whisper";
        default:
            return "unknown";
    }
}

void AppendUniqueDetectionSource(
    std::vector<sherpaonnx::DetectionSource>& out,
    sherpaonnx::DetectionSource s
) {
    if (std::find(out.begin(), out.end(), s) == out.end()) {
        out.push_back(s);
    }
}

std::vector<sherpaonnx::LanguageIdModelKind> GetKindsFromDirNameLanguageId(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::LanguageIdModelKind> out;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    auto add = [&out](sherpaonnx::LanguageIdModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };

    if (lower.find("whisper") != std::string::npos ||
        lower.find("slid") != std::string::npos ||
        lower.find("langid") != std::string::npos ||
        lower.find("language-id") != std::string::npos ||
        lower.find("language_id") != std::string::npos) {
        add(sherpaonnx::LanguageIdModelKind::kWhisper);
    }
    return out;
}

sherpaonnx::LanguageIdDetectResult DetectLanguageIdModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization
) {
    sherpaonnx::LanguageIdDetectResult result;

    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::LanguageIdModelKind> nameKinds =
            GetKindsFromDirNameLanguageId(modelDir);
        for (sherpaonnx::LanguageIdModelKind k : nameKinds) {
            result.detectedModels.push_back({LanguageIdKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "LanguageId: heuristic name-only detection cannot validate model files; "
            "run filesystem-backed detection for full validation and metadata guard checks.";
        if (requestedModelType != "auto") {
            sherpaonnx::LanguageIdModelKind selected =
                ParseLanguageIdModelType(requestedModelType);
            if (selected == sherpaonnx::LanguageIdModelKind::kUnknown) {
                result.error = "LanguageId: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            result.isStreaming = false;
            result.detectedModels.clear();
            result.detectedModels.push_back({LanguageIdKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (nameKinds.empty()) {
            result.error =
                "LanguageId: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        result.isStreaming = false;
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    std::string encoder = FindOnnxByAnyToken(files, {"encoder"}, quantization);
    std::string decoder = FindOnnxByAnyToken(files, {"decoder"}, quantization);

    if (!encoder.empty() && !decoder.empty()) {
        result.detectedModels.push_back({"whisper", modelDir});
    }

    sherpaonnx::LanguageIdModelKind selected = sherpaonnx::LanguageIdModelKind::kUnknown;
    if (requestedModelType == "auto") {
        if (!encoder.empty() && !decoder.empty()) {
            selected = sherpaonnx::LanguageIdModelKind::kWhisper;
            std::vector<sherpaonnx::LanguageIdModelKind> nameKinds =
                GetKindsFromDirNameLanguageId(modelDir);
            if (!nameKinds.empty() && nameKinds[0] == sherpaonnx::LanguageIdModelKind::kWhisper) {
                AppendUniqueDetectionSource(
                    result.detectionSources, sherpaonnx::DetectionSource::kDirName);
            } else {
                AppendUniqueDetectionSource(
                    result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
            }
        }
    } else {
        selected = ParseLanguageIdModelType(requestedModelType);
        if (selected == sherpaonnx::LanguageIdModelKind::kUnknown) {
            result.error = "LanguageId: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(
            result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    }

    result.selectedKind = selected;
    result.isStreaming = false;

    switch (selected) {
        case sherpaonnx::LanguageIdModelKind::kWhisper:
            result.paths.encoder = encoder;
            result.paths.decoder = decoder;
            break;
        default:
            result.error =
                "LanguageId: no compatible model type detected in " + modelDir;
            return result;
    }

    const auto vr = sherpaonnx::ValidateLanguageIdPaths(result.selectedKind, result.paths, modelDir);
    if (!vr.ok) {
        result.error = vr.error;
        return result;
    }

    std::string ignoredSizeTier;
    FillDerivedCatalogMetadataFromBasename(
        result.derivedLanguages, result.quantization, ignoredSizeTier, modelDir);
    if ((result.quantization.empty() || result.quantization == "unknown") && !result.paths.encoder.empty()) {
        std::string fileQuant = sherpaonnx::DeriveQuantization(sherpaonnx::model_detect::BaseName(result.paths.encoder));
        if (fileQuant != "unknown") {
            result.quantization = fileQuant;
        }
    }

    // Populate Whisper multilingual languages from curated catalog
    sherpaonnx::AppendCuratedLanguageRowsIfEmpty(
        sherpaonnx::ModelLanguageDomain::kStt,
        "whisper",
        modelDir,
        true,
        false,
        result.derivedLanguages,
        result.detectionSources
    );

    result.ok = true;
    return result;
}

} // namespace

namespace sherpaonnx {

using namespace model_detect;

LanguageIdDetectResult DetectLanguageIdModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType,
    const std::string& quantization
) {
    LanguageIdDetectResult result;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "LanguageId: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        result = DetectLanguageIdModelFromFiles({}, syntheticDir, requestedModelType, quantization);
        std::string ignoredSizeTier;
        FillDerivedCatalogMetadata(result.derivedLanguages, result.quantization, ignoredSizeTier, assetName);
        return result;
    }

    const std::string& modelDir = *model_dir_opt;

    if (modelDir.empty()) {
        result.error = "LanguageId: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "LanguageId: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    result = DetectLanguageIdModelFromFiles(files, modelDir, requestedModelType, quantization);
    if (has_asset && (result.quantization.empty() || result.quantization == "unknown")) {
        std::string ignoredSizeTier;
        FillDerivedCatalogMetadata(result.derivedLanguages, result.quantization, ignoredSizeTier, *asset_name_opt);
    }
    return result;
}

LanguageIdDetectResult DetectLanguageIdModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization
) {
    LanguageIdDetectResult result;
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    result = DetectLanguageIdModelFromFiles(files, modelDir, requestedModelType, quantization);
    return result;
}

} // namespace sherpaonnx
