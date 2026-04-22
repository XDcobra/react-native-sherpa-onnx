#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-ort-guard-utils.h"
#include "sherpa-onnx-vad-catalog-metadata.h"
#include "sherpa-onnx-validate-vad.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::VadModelKind ParseVadModelType(const std::string& modelType) {
    if (modelType == "silero_vad") return sherpaonnx::VadModelKind::kSileroVad;
    if (modelType == "ten_vad") return sherpaonnx::VadModelKind::kTenVad;
    return sherpaonnx::VadModelKind::kUnknown;
}

const char* VadKindToTag(sherpaonnx::VadModelKind kind) {
    switch (kind) {
        case sherpaonnx::VadModelKind::kSileroVad:
            return "silero_vad";
        case sherpaonnx::VadModelKind::kTenVad:
            return "ten_vad";
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

std::vector<sherpaonnx::VadModelKind> GetKindsFromDirNameVad(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::VadModelKind> out;
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);

    auto add = [&out](sherpaonnx::VadModelKind k) {
        if (std::find(out.begin(), out.end(), k) == out.end()) {
            out.push_back(k);
        }
    };
    if (lower.find("silero") != std::string::npos ||
        lower.find("silero_vad") != std::string::npos) {
        add(sherpaonnx::VadModelKind::kSileroVad);
    }
    if (lower.find("ten-vad") != std::string::npos ||
        lower.find("ten_vad") != std::string::npos) {
        add(sherpaonnx::VadModelKind::kTenVad);
    }
    return out;
}

sherpaonnx::VadModelKind InferKindFromModelName(const std::string& modelPath) {
    std::string lower = ToLower(modelPath);
    if (lower.find("silero") != std::string::npos) {
        return sherpaonnx::VadModelKind::kSileroVad;
    }
    if (lower.find("ten-vad") != std::string::npos || lower.find("ten_vad") != std::string::npos) {
        return sherpaonnx::VadModelKind::kTenVad;
    }
    return sherpaonnx::VadModelKind::kUnknown;
}

sherpaonnx::VadDetectResult DetectVadModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    sherpaonnx::VadDetectResult result;
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (files.empty()) {
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        std::vector<sherpaonnx::VadModelKind> nameKinds = GetKindsFromDirNameVad(modelDir);
        for (sherpaonnx::VadModelKind k : nameKinds) {
            result.detectedModels.push_back({VadKindToTag(k), modelDir});
        }
        static constexpr const char* kNameOnlyErr =
            "VAD: heuristic name-only detection cannot validate model files; run filesystem-backed detection for full validation.";
        if (requestedModelType != "auto") {
            sherpaonnx::VadModelKind selected = ParseVadModelType(requestedModelType);
            if (selected == sherpaonnx::VadModelKind::kUnknown) {
                result.error = "VAD: unknown model type: " + requestedModelType;
                return result;
            }
            AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            // VAD is currently treated as streaming-only.
            // TODO(vad): Introduce RunOnlineCompatibilityGuard here once either
            // sherpa-onnx adds offline VAD support or we implement our own
            // dedicated VAD online compatibility guard in this SDK.
            result.isStreaming = true;
            result.detectedModels.clear();
            result.detectedModels.push_back({VadKindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            FillVadDerivedCatalogMetadata(result, modelDir);
            return result;
        }
        if (nameKinds.empty()) {
            result.error = "VAD: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        // VAD is currently treated as streaming-only.
        // TODO(vad): Introduce RunOnlineCompatibilityGuard here once either
        // sherpa-onnx adds offline VAD support or we implement our own
        // dedicated VAD online compatibility guard in this SDK.
        result.isStreaming = true;
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        FillVadDerivedCatalogMetadata(result, modelDir);
        return result;
    }

    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    std::vector<std::string> onnxCandidates;
    onnxCandidates.reserve(files.size());
    for (const auto& file : files) {
        if (file.nameLower.size() >= 5 &&
            file.nameLower.compare(file.nameLower.size() - 5, 5, ".onnx") == 0) {
            onnxCandidates.push_back(file.path);
        }
    }
    if (onnxCandidates.empty()) {
        result.error = "VAD: no .onnx model file found in " + modelDir;
        return result;
    }

    std::string selectedModel;
    sherpaonnx::VadModelKind selected = sherpaonnx::VadModelKind::kUnknown;

    if (requestedModelType == "auto") {
        std::vector<sherpaonnx::VadModelKind> nameKinds = GetKindsFromDirNameVad(modelDir);
        for (auto kind : nameKinds) {
            for (const auto& candidate : onnxCandidates) {
                if (InferKindFromModelName(candidate) == kind) {
                    selected = kind;
                    selectedModel = candidate;
                    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
                    break;
                }
            }
            if (!selectedModel.empty()) break;
        }
        if (selectedModel.empty()) {
            for (const auto& candidate : onnxCandidates) {
                const auto inferred = InferKindFromModelName(candidate);
                if (inferred != sherpaonnx::VadModelKind::kUnknown) {
                    selected = inferred;
                    selectedModel = candidate;
                    AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kFallbackOrder);
                    break;
                }
            }
        }
    } else {
        selected = ParseVadModelType(requestedModelType);
        if (selected == sherpaonnx::VadModelKind::kUnknown) {
            result.error = "VAD: unknown model type: " + requestedModelType;
            return result;
        }
        AppendUniqueDetectionSource(result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
        for (const auto& candidate : onnxCandidates) {
            const auto inferred = InferKindFromModelName(candidate);
            if (inferred == selected || inferred == sherpaonnx::VadModelKind::kUnknown) {
                selectedModel = candidate;
                break;
            }
        }
    }

    if (selected == sherpaonnx::VadModelKind::kUnknown) {
        result.error = "VAD: no compatible model type detected in " + modelDir;
        return result;
    }

    result.selectedKind = selected;
    result.paths.model = selectedModel;
    // VAD is currently treated as streaming-only.
    // TODO(vad): Introduce RunOnlineCompatibilityGuard here once either
    // sherpa-onnx adds offline VAD support or we implement our own
    // dedicated VAD online compatibility guard in this SDK.
    result.isStreaming = true;
    result.detectedModels.push_back({VadKindToTag(selected), modelDir});

    if (result.paths.model.empty()) {
        result.error = "VAD: no compatible model file selected in " + modelDir;
        return result;
    }

    const sherpaonnx::VadValidationResult validation =
        ValidateVadPaths(result.selectedKind, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    if (!FileExists(result.paths.model) &&
        sherpaonnx::ort_guard_utils::LooksLikeAbsolutePath(result.paths.model)) {
        result.error = "VAD: resolved model file does not exist: " + result.paths.model;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace

namespace sherpaonnx {

using namespace model_detect;

VadDetectResult DetectVadModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    VadDetectResult result;
    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();
    const std::string requestedModelType = modelType.empty() ? "auto" : modelType;

    if (!has_dir && !has_asset) {
        result.error = "VAD: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string syntheticDir = std::string("m/") + *asset_name_opt;
        auto detected = DetectVadModelFromFiles({}, syntheticDir, requestedModelType);
        FillVadDerivedCatalogMetadata(detected, *asset_name_opt);
        return detected;
    }

    const std::string& modelDir = *model_dir_opt;
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "VAD: model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const std::vector<FileEntry> files = ListFilesRecursive(modelDir, 4);
    auto detected = DetectVadModelFromFiles(files, modelDir, requestedModelType);
    if (has_asset) {
        FillVadDerivedCatalogMetadata(detected, *asset_name_opt);
    } else {
        FillVadDerivedCatalogMetadataUsingModelDirBasename(detected, modelDir);
    }
    return detected;
}

VadDetectResult DetectVadModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    VadDetectResult result;
    if (modelDir.empty()) {
        result.error = "VAD: model directory is empty";
        return result;
    }
    auto detected = DetectVadModelFromFiles(files, modelDir, modelType);
    FillVadDerivedCatalogMetadataUsingModelDirBasename(detected, modelDir);
    return detected;
}

} // namespace sherpaonnx
