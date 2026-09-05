#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-diarization.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::DiarizationModelKind ParseDiarizationModelType(
    const std::string& modelType
) {
    if (modelType == "pyannote") return sherpaonnx::DiarizationModelKind::kPyannote;
    if (modelType == "reverb") return sherpaonnx::DiarizationModelKind::kReverb;
    if (modelType == "sortformer") return sherpaonnx::DiarizationModelKind::kSortformer;
    return sherpaonnx::DiarizationModelKind::kUnknown;
}

const char* DiarizationKindToTag(sherpaonnx::DiarizationModelKind kind) {
    switch (kind) {
        case sherpaonnx::DiarizationModelKind::kPyannote:
            return "pyannote";
        case sherpaonnx::DiarizationModelKind::kReverb:
            return "reverb";
        case sherpaonnx::DiarizationModelKind::kSortformer:
            return "sortformer";
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

std::string BasenameLower(const std::string& modelDir) {
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    return ToLower(base);
}

bool IsDiarizationPackName(const std::string& lowerBasename) {
    return lowerBasename.find("pyannote") != std::string::npos ||
           lowerBasename.find("reverb") != std::string::npos ||
           lowerBasename.find("sortformer") != std::string::npos ||
           lowerBasename.find("diarization") != std::string::npos ||
           lowerBasename.find("segmentation") != std::string::npos;
}

std::vector<sherpaonnx::DiarizationModelKind> GetKindsFromDirNameDiarization(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::DiarizationModelKind> out;
    const std::string lower = BasenameLower(modelDir);

    auto add = [&out](sherpaonnx::DiarizationModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };

    if (lower.find("pyannote") != std::string::npos) {
        add(sherpaonnx::DiarizationModelKind::kPyannote);
    }
    if (lower.find("reverb") != std::string::npos) {
        add(sherpaonnx::DiarizationModelKind::kReverb);
    }
    if (lower.find("sortformer") != std::string::npos) {
        add(sherpaonnx::DiarizationModelKind::kSortformer);
    }
    return out;
}

/** Prefer model.onnx over model.int8.onnx (same preference as punctuation inverted). */
std::string FindDiarizationModelOnnx(const std::vector<FileEntry>& files) {
    std::string fp = FindFileByName(files, "model.onnx");
    if (!fp.empty()) {
        return fp;
    }
    return FindFileByName(files, "model.int8.onnx");
}

sherpaonnx::DiarizationDetectResult DetectDiarizationModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::DiarizationDetectResult result;
    result.isStreaming = false;

    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::DiarizationModelKind> nameKinds =
            GetKindsFromDirNameDiarization(modelDir);
        for (sherpaonnx::DiarizationModelKind k : nameKinds) {
            result.detectedModels.push_back({DiarizationKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "Diarization: heuristic name-only detection cannot validate model files; "
            "run filesystem-backed detection for full validation.";
        if (requestedModelType != "auto") {
            sherpaonnx::DiarizationModelKind selected =
                ParseDiarizationModelType(requestedModelType);
            if (selected == sherpaonnx::DiarizationModelKind::kUnknown) {
                result.error = "Diarization: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.isStreaming = (selected == sherpaonnx::DiarizationModelKind::kSortformer);
            result.selectedKind = selected;
            result.detectedModels.clear();
            result.detectedModels.push_back({DiarizationKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (nameKinds.empty()) {
            result.error =
                "Diarization: no model type inferred from directory name "
                "(require pyannote, reverb, or sortformer in name; name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        result.isStreaming = (nameKinds[0] == sherpaonnx::DiarizationModelKind::kSortformer);
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    const std::string lowerBase = BasenameLower(modelDir);
    if (!IsDiarizationPackName(lowerBase)) {
        result.error =
            "Diarization: directory/asset name must indicate a diarization/segmentation pack "
            "(pyannote, reverb, diarization, or segmentation): " +
            modelDir;
        return result;
    }

    const std::string modelOnnx = FindDiarizationModelOnnx(files);
    if (modelOnnx.empty()) {
        result.error =
            "Diarization: no model.onnx or model.int8.onnx in " + modelDir;
        return result;
    }

    std::vector<sherpaonnx::DiarizationModelKind> nameKinds =
        GetKindsFromDirNameDiarization(modelDir);
    for (sherpaonnx::DiarizationModelKind k : nameKinds) {
        result.detectedModels.push_back({DiarizationKindToTag(k), modelDir});
    }

    sherpaonnx::DiarizationModelKind selected =
        sherpaonnx::DiarizationModelKind::kUnknown;
    if (requestedModelType == "auto") {
        if (nameKinds.empty()) {
            result.error =
                "Diarization: pack name matched but kind requires pyannote, reverb, or sortformer in "
                "directory/asset name: " +
                modelDir;
            return result;
        }
        selected = nameKinds[0];
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
    } else {
        selected = ParseDiarizationModelType(requestedModelType);
        if (selected == sherpaonnx::DiarizationModelKind::kUnknown) {
            result.error = "Diarization: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(
            result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
        if (result.detectedModels.empty()) {
            result.detectedModels.push_back({DiarizationKindToTag(selected), modelDir});
        }
    }

    result.selectedKind = selected;
    result.isStreaming = (selected == sherpaonnx::DiarizationModelKind::kSortformer);
    result.paths.model = modelOnnx;

    const std::string metadataJson = FindFileByName(files, "metadata.json");
    if (!metadataJson.empty()) {
        result.paths.metadata = metadataJson;
    }

    auto validation =
        sherpaonnx::ValidateDiarizationPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace

namespace sherpaonnx {

using namespace model_detect;

DiarizationDetectResult DetectDiarizationModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    DiarizationDetectResult result;
    result.isStreaming = false;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "Diarization: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        return DetectDiarizationModelFromFiles({}, syntheticDir, requestedModelType);
    }

    const std::string& modelDir = *model_dir_opt;

    if (modelDir.empty()) {
        result.error = "Diarization: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "Diarization: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    return DetectDiarizationModelFromFiles(files, modelDir, requestedModelType);
}

DiarizationDetectResult DetectDiarizationModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    DiarizationDetectResult result;
    result.isStreaming = false;
    if (modelDir.empty()) {
        result.error = "Diarization: model directory is empty";
        return result;
    }
    return DetectDiarizationModelFromFiles(files, modelDir, modelType);
}

} // namespace sherpaonnx
