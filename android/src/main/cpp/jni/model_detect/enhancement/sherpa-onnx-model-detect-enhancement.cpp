#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-enhancement-catalog-metadata.h"
#include "sherpa-onnx-validate-enhancement.h"

#include <optional>
#include <string>
#include <vector>
#include <algorithm>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::EnhancementModelKind ParseEnhancementModelType(const std::string& modelType) {
    if (modelType == "gtcrn") return sherpaonnx::EnhancementModelKind::kGtcrn;
    if (modelType == "dpdfnet") return sherpaonnx::EnhancementModelKind::kDpdfNet;
    return sherpaonnx::EnhancementModelKind::kUnknown;
}

const char* EnhancementKindToTag(sherpaonnx::EnhancementModelKind kind) {
    switch (kind) {
        case sherpaonnx::EnhancementModelKind::kGtcrn:
            return "gtcrn";
        case sherpaonnx::EnhancementModelKind::kDpdfNet:
            return "dpdfnet";
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

std::vector<sherpaonnx::EnhancementModelKind> GetKindsFromDirNameEnhancement(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::EnhancementModelKind> out;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    auto add = [&out](sherpaonnx::EnhancementModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };

    if (lower.find("gtcrn") != std::string::npos) {
        add(sherpaonnx::EnhancementModelKind::kGtcrn);
    }
    if (lower.find("dpdfnet") != std::string::npos || lower.find("dpcrn") != std::string::npos) {
        add(sherpaonnx::EnhancementModelKind::kDpdfNet);
    }
    return out;
}

sherpaonnx::EnhancementDetectResult DetectEnhancementModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::EnhancementDetectResult result;

    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::EnhancementModelKind> nameKinds =
            GetKindsFromDirNameEnhancement(modelDir);
        for (sherpaonnx::EnhancementModelKind k : nameKinds) {
            result.detectedModels.push_back({EnhancementKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "Enhancement: Name-only detection cannot validate files; run a full directory scan before createEnhancement.";
        if (requestedModelType != "auto") {
            sherpaonnx::EnhancementModelKind selected = ParseEnhancementModelType(requestedModelType);
            if (selected == sherpaonnx::EnhancementModelKind::kUnknown) {
                result.error = "Enhancement: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            result.detectedModels.clear();
            result.detectedModels.push_back({EnhancementKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (nameKinds.empty()) {
            result.error = "Enhancement: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    const std::string gtcrnModel =
        FindOnnxByAnyToken(files, {"gtcrn"}, std::nullopt);
    const std::string dpdfnetModel =
        FindOnnxByAnyToken(files, {"dpdfnet"}, std::nullopt);

    if (!gtcrnModel.empty()) {
        result.detectedModels.push_back({"gtcrn", modelDir});
    }
    if (!dpdfnetModel.empty()) {
        result.detectedModels.push_back({"dpdfnet", modelDir});
    }

    sherpaonnx::EnhancementModelKind selected = sherpaonnx::EnhancementModelKind::kUnknown;
    if (requestedModelType == "auto") {
        std::vector<sherpaonnx::EnhancementModelKind> nameKinds =
            GetKindsFromDirNameEnhancement(modelDir);
        bool selectedFromDir = false;
        if (!nameKinds.empty()) {
            for (const auto kind : nameKinds) {
                if (kind == sherpaonnx::EnhancementModelKind::kGtcrn && !gtcrnModel.empty()) {
                    selected = kind;
                    selectedFromDir = true;
                    break;
                }
                if (kind == sherpaonnx::EnhancementModelKind::kDpdfNet && !dpdfnetModel.empty()) {
                    selected = kind;
                    selectedFromDir = true;
                    break;
                }
            }
        }
        if (selectedFromDir) {
            AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        } else if (!gtcrnModel.empty()) {
            selected = sherpaonnx::EnhancementModelKind::kGtcrn;
            AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        } else if (!dpdfnetModel.empty()) {
            selected = sherpaonnx::EnhancementModelKind::kDpdfNet;
            AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        }
    } else {
        selected = ParseEnhancementModelType(requestedModelType);
        if (selected == sherpaonnx::EnhancementModelKind::kUnknown) {
            result.error = "Enhancement: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    }

    switch (selected) {
        case sherpaonnx::EnhancementModelKind::kGtcrn:
            result.paths.model = gtcrnModel;
            break;
        case sherpaonnx::EnhancementModelKind::kDpdfNet:
            result.paths.model = dpdfnetModel;
            break;
        default:
            result.error = "Enhancement: no compatible model type detected in " +
                           modelDir;
            return result;
    }

    auto validation =
        sherpaonnx::ValidateEnhancementPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.selectedKind = selected;
    result.ok = true;
    return result;
}

} // namespace

namespace sherpaonnx {

using namespace model_detect;

EnhancementDetectResult DetectEnhancementModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    EnhancementDetectResult result;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "Enhancement: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        result = DetectEnhancementModelFromFiles({}, syntheticDir, requestedModelType);
        FillEnhancementDerivedCatalogMetadata(result, assetName);
        return result;
    }

    const std::string& modelDir = *model_dir_opt;

    if (modelDir.empty()) {
        result.error = "Enhancement: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "Enhancement: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    result = DetectEnhancementModelFromFiles(files, modelDir, requestedModelType);
    if (has_asset) {
        FillEnhancementDerivedCatalogMetadata(result, *asset_name_opt);
    } else {
        FillEnhancementDerivedCatalogMetadataUsingModelDirBasename(result, modelDir);
    }
    return result;
}

// Test-only: used by host-side model_detect_test; not used in production.
EnhancementDetectResult DetectEnhancementModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    EnhancementDetectResult result;
    if (modelDir.empty()) {
        result.error = "Enhancement: model directory is empty";
        return result;
    }
    return DetectEnhancementModelFromFiles(files, modelDir, modelType);
}

} // namespace sherpaonnx
