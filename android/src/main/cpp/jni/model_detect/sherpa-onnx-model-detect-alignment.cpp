#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-alignment.h"

#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::AlignmentModelKind ParseAlignmentModelType(const std::string& modelType) {
    if (modelType == "wav2vec2") return sherpaonnx::AlignmentModelKind::kWav2Vec2;
    return sherpaonnx::AlignmentModelKind::kUnknown;
}

sherpaonnx::AlignmentDetectResult DetectAlignmentModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::AlignmentDetectResult result;

    const std::string wav2vec2Model =
        FindOnnxByAnyToken(files, {"wav2vec2", "model"}, std::nullopt);

    if (!wav2vec2Model.empty()) {
        result.detectedModels.push_back({"wav2vec2", modelDir});
    }

    sherpaonnx::AlignmentModelKind selected = sherpaonnx::AlignmentModelKind::kUnknown;
    if (modelType == "auto" || modelType.empty()) {
        if (!wav2vec2Model.empty()) {
            selected = sherpaonnx::AlignmentModelKind::kWav2Vec2;
        }
    } else {
        selected = ParseAlignmentModelType(modelType);
        if (selected == sherpaonnx::AlignmentModelKind::kUnknown) {
            result.error = "Alignment: unknown model type: " + modelType;
            return result;
        }
    }

    switch (selected) {
        case sherpaonnx::AlignmentModelKind::kWav2Vec2:
            result.paths.model = wav2vec2Model;
            break;
        default:
            result.error = "Alignment: no compatible model type detected in " +
                           modelDir;
            return result;
    }

    auto validation =
        sherpaonnx::ValidateAlignmentPaths(selected, result.paths, modelDir);
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

AlignmentDetectResult DetectAlignmentModel(
    const std::string& modelDir,
    const std::string& modelType
) {
    AlignmentDetectResult result;

    if (modelDir.empty()) {
        result.error = "Alignment: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "Alignment: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    return DetectAlignmentModelFromFiles(files, modelDir, modelType);
}

// Test-only: used by host-side model_detect_test; not used in production.
AlignmentDetectResult DetectAlignmentModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    AlignmentDetectResult result;
    if (modelDir.empty()) {
        result.error = "Alignment: model directory is empty";
        return result;
    }
    return DetectAlignmentModelFromFiles(files, modelDir, modelType);
}

} // namespace sherpaonnx
