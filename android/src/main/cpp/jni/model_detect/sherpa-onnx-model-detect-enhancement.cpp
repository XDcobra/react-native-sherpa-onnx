#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-enhancement.h"

#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::EnhancementModelKind ParseEnhancementModelType(const std::string& modelType) {
    if (modelType == "gtcrn") return sherpaonnx::EnhancementModelKind::kGtcrn;
    if (modelType == "dpdfnet") return sherpaonnx::EnhancementModelKind::kDpdfNet;
    return sherpaonnx::EnhancementModelKind::kUnknown;
}

sherpaonnx::EnhancementDetectResult DetectEnhancementModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::EnhancementDetectResult result;

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
    if (modelType == "auto" || modelType.empty()) {
        if (!gtcrnModel.empty()) {
            selected = sherpaonnx::EnhancementModelKind::kGtcrn;
        } else if (!dpdfnetModel.empty()) {
            selected = sherpaonnx::EnhancementModelKind::kDpdfNet;
        }
    } else {
        selected = ParseEnhancementModelType(modelType);
        if (selected == sherpaonnx::EnhancementModelKind::kUnknown) {
            result.error = "Enhancement: unknown model type: " + modelType;
            return result;
        }
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
    const std::string& modelDir,
    const std::string& modelType
) {
    EnhancementDetectResult result;

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
    return DetectEnhancementModelFromFiles(files, modelDir, modelType);
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
