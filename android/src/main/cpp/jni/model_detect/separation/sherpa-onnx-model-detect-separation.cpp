#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-separation.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::SeparationModelKind ParseSeparationModelType(const std::string& modelType) {
    if (modelType == "spleeter") return sherpaonnx::SeparationModelKind::kSpleeter;
    if (modelType == "uvr") return sherpaonnx::SeparationModelKind::kUvr;
    return sherpaonnx::SeparationModelKind::kUnknown;
}

const char* SeparationKindToTag(sherpaonnx::SeparationModelKind kind) {
    switch (kind) {
        case sherpaonnx::SeparationModelKind::kSpleeter:
            return "spleeter";
        case sherpaonnx::SeparationModelKind::kUvr:
            return "uvr";
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

std::vector<sherpaonnx::SeparationModelKind> GetKindsFromDirNameSeparation(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::SeparationModelKind> out;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    auto add = [&out](sherpaonnx::SeparationModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };

    if (lower.find("spleeter") != std::string::npos) {
        add(sherpaonnx::SeparationModelKind::kSpleeter);
    }
    if (lower.find("uvr") != std::string::npos) {
        add(sherpaonnx::SeparationModelKind::kUvr);
    }
    return out;
}

bool HasSpleeterLayout(const std::string& vocals, const std::string& accompaniment) {
    return !vocals.empty() && !accompaniment.empty();
}

sherpaonnx::SeparationDetectResult DetectSeparationModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::SeparationDetectResult result;

    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::SeparationModelKind> nameKinds =
            GetKindsFromDirNameSeparation(modelDir);
        for (sherpaonnx::SeparationModelKind k : nameKinds) {
            result.detectedModels.push_back({SeparationKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "Separation: heuristic name-only detection cannot validate model files; run filesystem-backed detection for full validation.";
        if (requestedModelType != "auto") {
            sherpaonnx::SeparationModelKind selected = ParseSeparationModelType(requestedModelType);
            if (selected == sherpaonnx::SeparationModelKind::kUnknown) {
                result.error = "Separation: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            result.detectedModels.clear();
            result.detectedModels.push_back({SeparationKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (nameKinds.empty()) {
            result.error =
                "Separation: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    const std::string vocalsOnnx = FindOnnxByToken(files, "vocals", std::nullopt);
    const std::string accompanimentOnnx =
        FindOnnxByToken(files, "accompaniment", std::nullopt);
    const std::string uvrOnnx = FindOnnxByToken(files, "uvr", std::nullopt);

    if (HasSpleeterLayout(vocalsOnnx, accompanimentOnnx)) {
        result.detectedModels.push_back({"spleeter", modelDir});
    }
    if (!uvrOnnx.empty()) {
        result.detectedModels.push_back({"uvr", modelDir});
    }

    sherpaonnx::SeparationModelKind selected = sherpaonnx::SeparationModelKind::kUnknown;
    if (requestedModelType == "auto") {
        if (HasSpleeterLayout(vocalsOnnx, accompanimentOnnx)) {
            selected = sherpaonnx::SeparationModelKind::kSpleeter;
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        } else if (!uvrOnnx.empty()) {
            selected = sherpaonnx::SeparationModelKind::kUvr;
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        } else {
            std::vector<sherpaonnx::SeparationModelKind> nameKinds =
                GetKindsFromDirNameSeparation(modelDir);
            if (!nameKinds.empty()) {
                selected = nameKinds[0];
                AppendUniqueDetectionSource(
                    result.detectionSources, sherpaonnx::DetectionSource::kDirName);
            }
        }
    } else {
        selected = ParseSeparationModelType(requestedModelType);
        if (selected == sherpaonnx::SeparationModelKind::kUnknown) {
            result.error = "Separation: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(
            result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    }

    result.selectedKind = selected;

    switch (selected) {
        case sherpaonnx::SeparationModelKind::kSpleeter:
            result.paths.vocals = vocalsOnnx;
            result.paths.accompaniment = accompanimentOnnx;
            break;
        case sherpaonnx::SeparationModelKind::kUvr:
            result.paths.model = uvrOnnx;
            break;
        default:
            result.error = "Separation: no compatible model type detected in " + modelDir;
            return result;
    }

    auto validation =
        sherpaonnx::ValidateSeparationPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.ok = true;
    return result;
}

}  // namespace

namespace sherpaonnx {

using namespace model_detect;

SeparationDetectResult DetectSeparationModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    SeparationDetectResult result;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "Separation: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        return DetectSeparationModelFromFiles({}, syntheticDir, requestedModelType);
    }

    const std::string& modelDir = *model_dir_opt;

    if (modelDir.empty()) {
        result.error = "Separation: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "Separation: model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const std::vector<FileEntry> files = ListFilesRecursive(modelDir, 4);
    return DetectSeparationModelFromFiles(files, modelDir, requestedModelType);
}

SeparationDetectResult DetectSeparationModelFromFileList(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    SeparationDetectResult result;
    if (modelDir.empty()) {
        result.error = "Separation: model directory is empty";
        return result;
    }
    return DetectSeparationModelFromFiles(files, modelDir, modelType);
}

}  // namespace sherpaonnx
