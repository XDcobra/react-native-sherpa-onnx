#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-enhancement.h"

#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {
namespace {

using namespace model_detect;

EnhancementModelKind ParseEnhancementModelType(const std::string& modelType) {
    if (modelType == "gtcrn") return EnhancementModelKind::kGtcrn;
    if (modelType == "dpdfnet") return EnhancementModelKind::kDpdfNet;
    return EnhancementModelKind::kUnknown;
}

} // namespace

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

    const std::vector<FileEntry> files = ListFilesRecursive(modelDir, 4);
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

    EnhancementModelKind selected = EnhancementModelKind::kUnknown;
    if (modelType == "auto" || modelType.empty()) {
        if (!gtcrnModel.empty()) {
            selected = EnhancementModelKind::kGtcrn;
        } else if (!dpdfnetModel.empty()) {
            selected = EnhancementModelKind::kDpdfNet;
        }
    } else {
        selected = ParseEnhancementModelType(modelType);
        if (selected == EnhancementModelKind::kUnknown) {
            result.error = "Enhancement: unknown model type: " + modelType;
            return result;
        }
    }

    switch (selected) {
        case EnhancementModelKind::kGtcrn:
            result.paths.model = gtcrnModel;
            break;
        case EnhancementModelKind::kDpdfNet:
            result.paths.model = dpdfnetModel;
            break;
        default:
            result.error = "Enhancement: no compatible model type detected in " +
                           modelDir;
            return result;
    }

    auto validation =
        ValidateEnhancementPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.selectedKind = selected;
    result.ok = true;
    return result;
}

} // namespace sherpaonnx
