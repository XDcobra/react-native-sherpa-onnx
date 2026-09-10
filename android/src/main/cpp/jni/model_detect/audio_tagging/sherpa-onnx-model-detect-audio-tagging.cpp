#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-catalog-metadata.h"
#include "sherpa-onnx-audio-tagging-catalog-metadata.h"
#include "sherpa-onnx-validate-audio-tagging.h"

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

sherpaonnx::AudioTaggingModelKind ParseKind(const std::string& modelType) {
    const std::string t = ToLower(modelType);
    if (t == "ced") return sherpaonnx::AudioTaggingModelKind::kCed;
    if (t == "zipformer") return sherpaonnx::AudioTaggingModelKind::kZipformer;
    return sherpaonnx::AudioTaggingModelKind::kUnknown;
}

const char* KindToTag(sherpaonnx::AudioTaggingModelKind kind) {
    switch (kind) {
        case sherpaonnx::AudioTaggingModelKind::kCed:
            return "ced";
        case sherpaonnx::AudioTaggingModelKind::kZipformer:
            return "zipformer";
        default:
            return "unknown";
    }
}

std::string DirBasename(const std::string& modelDir) {
    size_t pos = modelDir.find_last_of("/\\");
    return (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
}

/**
 * Infer kind from directory/asset name.
 * CED wins when "ced" is present; otherwise zipformer if "zipformer" or
 * "audio-tagging"/"audiotagging" tokens appear.
 */
sherpaonnx::AudioTaggingModelKind InferKindFromDir(const std::string& modelDir) {
    const std::string lower = ToLower(DirBasename(modelDir));
    if (lower.find("ced") != std::string::npos) {
        return sherpaonnx::AudioTaggingModelKind::kCed;
    }
    if (lower.find("zipformer") != std::string::npos ||
        lower.find("audio-tagging") != std::string::npos ||
        lower.find("audiotagging") != std::string::npos) {
        return sherpaonnx::AudioTaggingModelKind::kZipformer;
    }
    return sherpaonnx::AudioTaggingModelKind::kUnknown;
}

std::vector<sherpaonnx::AudioTaggingModelKind> GetKindsFromDirName(
    const std::string& modelDir
) {
    std::vector<sherpaonnx::AudioTaggingModelKind> out;
    const auto kind = InferKindFromDir(modelDir);
    if (kind != sherpaonnx::AudioTaggingModelKind::kUnknown) {
        out.push_back(kind);
    }
    return out;
}

sherpaonnx::AudioTaggingDetectResult DetectFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization) {
    sherpaonnx::AudioTaggingDetectResult result;
    result.isStreaming = false;
    const std::string requested = modelType.empty() ? "auto" : modelType;
    const bool isAuto = ToLower(requested) == "auto";

    if (files.empty()) {
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kNameOnly);
        static constexpr const char* kNameOnlyErr =
            "AudioTagging: heuristic name-only detection cannot validate model files; "
            "run filesystem-backed detection for full validation.";
        if (!isAuto) {
            const auto selected = ParseKind(requested);
            if (selected == sherpaonnx::AudioTaggingModelKind::kUnknown) {
                result.error = "AudioTagging: unknown model type: " + requested;
                return result;
            }
            AppendUnique(
                result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
            result.selectedKind = selected;
            result.detectedModels.push_back({KindToTag(selected), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        std::vector<sherpaonnx::AudioTaggingModelKind> nameKinds =
            GetKindsFromDirName(modelDir);
        if (nameKinds.empty()) {
            result.error =
                "AudioTagging: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        for (const auto k : nameKinds) {
            result.detectedModels.push_back({KindToTag(k), modelDir});
        }
        AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kFileListing);

    const std::string labels = FindFileByName(files, "class_labels_indices.csv");
    std::string model = FindOnnxByAnyToken(files, {"model"}, quantization);
    const std::string encoder = FindOnnxByAnyToken(files, {"encoder"}, quantization);
    const std::string decoder = FindOnnxByAnyToken(files, {"decoder"}, quantization);
    const std::string joiner = FindOnnxByAnyToken(files, {"joiner"}, quantization);

    if (!encoder.empty() && !decoder.empty() && !joiner.empty()) {
        result.error = "AudioTagging: not audio tagging (transducer layout)";
        return result;
    }

    if (model.empty() && labels.empty()) {
        result.error = "AudioTagging: no model.onnx or class_labels_indices.csv in " + modelDir;
        return result;
    }

    // Fail closed: ONNX without dedicated AT labels is not audio tagging
    // (avoids stealing enhancement / generic single-ONNX packs).
    if (!model.empty() && labels.empty()) {
        result.error =
            "AudioTagging: model onnx present but class_labels_indices.csv missing in " +
            modelDir;
        return result;
    }

    if (model.empty() && !labels.empty()) {
        result.error =
            "AudioTagging: class_labels_indices.csv present but model onnx missing in " +
            modelDir;
        return result;
    }

    sherpaonnx::AudioTaggingModelKind selected =
        sherpaonnx::AudioTaggingModelKind::kUnknown;
    if (!isAuto) {
        selected = ParseKind(requested);
        if (selected == sherpaonnx::AudioTaggingModelKind::kUnknown) {
            result.error = "AudioTagging: unknown model type: " + requested;
            return result;
        }
        AppendUnique(
            result.detectionSources, sherpaonnx::DetectionSource::kExplicitModelType);
    } else {
        selected = InferKindFromDir(modelDir);
        if (selected != sherpaonnx::AudioTaggingModelKind::kUnknown) {
            AppendUnique(result.detectionSources, sherpaonnx::DetectionSource::kDirName);
        } else {
            // labels + model without kind cues → fail closed
            result.paths.model = model;
            result.paths.labels = labels;
            result.error =
                "AudioTagging: cannot infer kind from directory name "
                "(need 'ced', 'zipformer', or 'audio-tagging') in " +
                modelDir;
            return result;
        }
    }

    result.selectedKind = selected;
    result.detectedModels.push_back({KindToTag(selected), modelDir});
    result.paths.model = model;
    result.paths.labels = labels;

    const auto validation =
        sherpaonnx::ValidateAudioTaggingPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    if ((result.quantization.empty() || result.quantization == "unknown") &&
        !result.paths.model.empty()) {
        const std::string fileQuant =
            sherpaonnx::DeriveQuantization(BaseName(result.paths.model));
        if (fileQuant != "unknown") {
            result.quantization = fileQuant;
        }
    }

    result.isStreaming = false;
    result.ok = true;
    return result;
}

}  // namespace

namespace sherpaonnx {

AudioTaggingDetectResult DetectAudioTaggingModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType,
    const std::string& quantization) {
    AudioTaggingDetectResult result;
    result.isStreaming = false;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();

    if (!has_dir && !has_asset) {
        result.error = "AudioTagging: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        result = DetectFromFiles({}, syntheticDir, modelType, quantization);
        FillAudioTaggingDerivedCatalogMetadata(result, assetName);
        return result;
    }

    const std::string& modelDir = *model_dir_opt;
    if (modelDir.empty()) {
        result.error = "AudioTagging: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error =
            "AudioTagging: model directory does not exist or is not a directory: " +
            modelDir;
        return result;
    }

    result = DetectFromFiles(
        model_detect::ListFilesRecursive(modelDir, 4),
        modelDir,
        modelType,
        quantization);
    if (has_asset) {
        FillAudioTaggingDerivedCatalogMetadata(result, *asset_name_opt);
    } else {
        FillAudioTaggingDerivedCatalogMetadataUsingModelDirBasename(result, modelDir);
    }
    return result;
}

AudioTaggingDetectResult DetectAudioTaggingModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization) {
    AudioTaggingDetectResult result;
    result.isStreaming = false;
    if (modelDir.empty()) {
        result.error = "AudioTagging: model directory is empty";
        return result;
    }
    return DetectFromFiles(files, modelDir, modelType, quantization);
}

}  // namespace sherpaonnx
