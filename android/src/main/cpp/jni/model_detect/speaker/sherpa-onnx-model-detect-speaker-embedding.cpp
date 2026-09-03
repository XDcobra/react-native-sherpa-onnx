#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-speaker-embedding-online-guard.h"
#include "sherpa-onnx-validate-speaker-embedding.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;
using sherpaonnx::speaker_embedding::online_guard::LooksLikeAbsolutePath;
using sherpaonnx::speaker_embedding::online_guard::RunOnlineCompatibilityGuard;

sherpaonnx::SpeakerEmbeddingModelKind ParseSpeakerEmbeddingModelType(
    const std::string& modelType
) {
    if (modelType == "wespeaker") return sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker;
    if (modelType == "3d-speaker" || modelType == "3dspeaker") {
        return sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker;
    }
    if (modelType == "nemo") return sherpaonnx::SpeakerEmbeddingModelKind::kNemo;
    return sherpaonnx::SpeakerEmbeddingModelKind::kUnknown;
}

const char* SpeakerEmbeddingKindToTag(sherpaonnx::SpeakerEmbeddingModelKind kind) {
    switch (kind) {
        case sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker:
            return "wespeaker";
        case sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker:
            return "3d-speaker";
        case sherpaonnx::SpeakerEmbeddingModelKind::kNemo:
            return "nemo";
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

std::vector<sherpaonnx::SpeakerEmbeddingModelKind> GetKindsFromDirNameSpeakerEmbedding(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::SpeakerEmbeddingModelKind> out;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    auto add = [&out](sherpaonnx::SpeakerEmbeddingModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };

    if (lower.find("wespeaker") != std::string::npos) {
        add(sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker);
    }
    if (lower.find("3dspeaker") != std::string::npos ||
        lower.find("3d-speaker") != std::string::npos) {
        add(sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker);
    }
    if (lower.find("nemo") != std::string::npos ||
        lower.find("titanet") != std::string::npos ||
        lower.find("speakernet") != std::string::npos) {
        add(sherpaonnx::SpeakerEmbeddingModelKind::kNemo);
    }
    return out;
}

sherpaonnx::SpeakerEmbeddingDetectResult DetectSpeakerEmbeddingModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::SpeakerEmbeddingDetectResult result;

    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::SpeakerEmbeddingModelKind> nameKinds =
            GetKindsFromDirNameSpeakerEmbedding(modelDir);
        for (sherpaonnx::SpeakerEmbeddingModelKind k : nameKinds) {
            result.detectedModels.push_back({SpeakerEmbeddingKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "SpeakerEmbedding: heuristic name-only detection cannot validate model files; "
            "run filesystem-backed detection for full validation and metadata guard checks.";
        if (requestedModelType != "auto") {
            sherpaonnx::SpeakerEmbeddingModelKind selected =
                ParseSpeakerEmbeddingModelType(requestedModelType);
            if (selected == sherpaonnx::SpeakerEmbeddingModelKind::kUnknown) {
                result.error = "SpeakerEmbedding: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            result.isStreaming = false;
            result.detectedModels.clear();
            result.detectedModels.push_back({SpeakerEmbeddingKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (nameKinds.empty()) {
            result.error =
                "SpeakerEmbedding: no model type inferred from directory name (name-only mode).";
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

    const std::string wespeakerModel =
        FindOnnxByAnyToken(files, {"wespeaker"}, std::nullopt);
    const std::string threeDSpeakerModel =
        FindOnnxByAnyToken(files, {"3dspeaker", "3d-speaker"}, std::nullopt);
    const std::string nemoModel =
        FindOnnxByAnyToken(files, {"nemo", "titanet", "speakernet"}, std::nullopt);

    if (!wespeakerModel.empty()) {
        result.detectedModels.push_back({"wespeaker", modelDir});
    }
    if (!threeDSpeakerModel.empty()) {
        result.detectedModels.push_back({"3d-speaker", modelDir});
    }
    if (!nemoModel.empty()) {
        result.detectedModels.push_back({"nemo", modelDir});
    }

    sherpaonnx::SpeakerEmbeddingModelKind selected =
        sherpaonnx::SpeakerEmbeddingModelKind::kUnknown;
    if (requestedModelType == "auto") {
        std::vector<sherpaonnx::SpeakerEmbeddingModelKind> nameKinds =
            GetKindsFromDirNameSpeakerEmbedding(modelDir);
        bool selectedFromDir = false;
        if (!nameKinds.empty()) {
            for (const auto kind : nameKinds) {
                if (kind == sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker &&
                    !wespeakerModel.empty()) {
                    selected = kind;
                    selectedFromDir = true;
                    break;
                }
                if (kind == sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker &&
                    !threeDSpeakerModel.empty()) {
                    selected = kind;
                    selectedFromDir = true;
                    break;
                }
                if (kind == sherpaonnx::SpeakerEmbeddingModelKind::kNemo && !nemoModel.empty()) {
                    selected = kind;
                    selectedFromDir = true;
                    break;
                }
            }
        }
        if (selectedFromDir) {
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        } else if (!wespeakerModel.empty()) {
            selected = sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker;
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        } else if (!threeDSpeakerModel.empty()) {
            selected = sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker;
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        } else if (!nemoModel.empty()) {
            selected = sherpaonnx::SpeakerEmbeddingModelKind::kNemo;
            AppendUniqueDetectionSource(
                result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
        }
    } else {
        selected = ParseSpeakerEmbeddingModelType(requestedModelType);
        if (selected == sherpaonnx::SpeakerEmbeddingModelKind::kUnknown) {
            result.error = "SpeakerEmbedding: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(
            result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    }

    result.selectedKind = selected;
    result.isStreaming = false;

    switch (selected) {
        case sherpaonnx::SpeakerEmbeddingModelKind::kWespeaker:
            result.paths.model = wespeakerModel;
            break;
        case sherpaonnx::SpeakerEmbeddingModelKind::k3dSpeaker:
            result.paths.model = threeDSpeakerModel;
            break;
        case sherpaonnx::SpeakerEmbeddingModelKind::kNemo:
            result.paths.model = nemoModel;
            break;
        default:
            result.error =
                "SpeakerEmbedding: no compatible model type detected in " + modelDir;
            return result;
    }

    auto validation =
        sherpaonnx::ValidateSpeakerEmbeddingPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    if (FileExists(result.paths.model)) {
        const auto guard = RunOnlineCompatibilityGuard(selected, result.paths.model);
        if (!guard.passed) {
            result.error = "SpeakerEmbedding: metadata compatibility guard failed for " +
                           std::string(SpeakerEmbeddingKindToTag(selected)) + " model '" +
                           result.paths.model + "': " +
                           (guard.error.empty() ? "unknown reason" : guard.error);
            return result;
        }
    } else if (LooksLikeAbsolutePath(result.paths.model)) {
        result.error =
            "SpeakerEmbedding: resolved model file does not exist: " + result.paths.model;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace

namespace sherpaonnx {

using namespace model_detect;

SpeakerEmbeddingDetectResult DetectSpeakerEmbeddingModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    SpeakerEmbeddingDetectResult result;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "SpeakerEmbedding: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        return DetectSpeakerEmbeddingModelFromFiles({}, syntheticDir, requestedModelType);
    }

    const std::string& modelDir = *model_dir_opt;

    if (modelDir.empty()) {
        result.error = "SpeakerEmbedding: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "SpeakerEmbedding: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    return DetectSpeakerEmbeddingModelFromFiles(files, modelDir, requestedModelType);
}

SpeakerEmbeddingDetectResult DetectSpeakerEmbeddingModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    SpeakerEmbeddingDetectResult result;
    if (modelDir.empty()) {
        result.error = "SpeakerEmbedding: model directory is empty";
        return result;
    }
    return DetectSpeakerEmbeddingModelFromFiles(files, modelDir, modelType);
}

} // namespace sherpaonnx
