#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-punctuation-catalog-metadata.h"
#include "sherpa-onnx-validate-punctuation.h"

#include <algorithm>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

sherpaonnx::PunctuationModelKind ParsePunctuationModelTypeStrict(const std::string& modelType) {
    const std::string t = ToLower(modelType);
    if (t == "ct_transformer" || t == "offline") return sherpaonnx::PunctuationModelKind::kCtTransformer;
    if (t == "cnn_bilstm" || t == "online") return sherpaonnx::PunctuationModelKind::kCnnBilstm;
    if (t == "auto") return sherpaonnx::PunctuationModelKind::kUnknown;
    return sherpaonnx::PunctuationModelKind::kUnknown;
}

const char* PunctuationKindToTag(sherpaonnx::PunctuationModelKind kind) {
    using K = sherpaonnx::PunctuationModelKind;
    switch (kind) {
        case K::kCtTransformer:
            return "ct_transformer";
        case K::kCnnBilstm:
            return "cnn_bilstm";
        default:
            return "unknown";
    }
}

void AppendUniqueSource(std::vector<sherpaonnx::DetectionSource>& out, sherpaonnx::DetectionSource s) {
    if (std::find(out.begin(), out.end(), s) == out.end()) {
        out.push_back(s);
    }
}

/**
 * If both bpe.vocab+onnx and tokens.json+onnx match, **online (bpe) wins** (see plan).
 */
std::string FindPrimaryOnnxForPunc(const std::vector<FileEntry>& files) {
    std::string a = FindFileByName(files, "model.int8.onnx");
    if (!a.empty()) {
        return a;
    }
    return FindFileByName(files, "model.onnx");
}

std::vector<sherpaonnx::PunctuationModelKind> InferKindsNameOnlyFromDir(
    const std::string& modelDir
) {
    size_t pos = modelDir.find_last_of("/\\");
    std::string base = (pos == std::string::npos) ? modelDir : modelDir.substr(pos + 1);
    std::string lower = ToLower(base);
    std::vector<sherpaonnx::PunctuationModelKind> out;
    if (lower.find("online") != std::string::npos && lower.find("punct") != std::string::npos) {
        out.push_back(sherpaonnx::PunctuationModelKind::kCnnBilstm);
    }
    if (lower.find("punct-ct") != std::string::npos || lower.find("ct-transformer") != std::string::npos) {
        out.push_back(sherpaonnx::PunctuationModelKind::kCtTransformer);
    }
    return out;
}

sherpaonnx::PunctuationDetectResult DetectPunctuationModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    using DS = sherpaonnx::DetectionSource;
    using PK = sherpaonnx::PunctuationModelKind;
    sherpaonnx::PunctuationDetectResult result;
    result.isStreaming = false;

    const std::string reqRaw = modelType.empty() ? "auto" : modelType;
    const std::string reqLower = ToLower(reqRaw);
    const bool isAuto = (reqLower == "auto");
    const PK requestedExplicit = isAuto ? PK::kUnknown : ParsePunctuationModelTypeStrict(reqRaw);

    if (files.empty()) {
        AppendUniqueSource(result.detectionSources, DS::kNameOnly);
        static constexpr const char* kNameOnlyErr =
            "Punctuation: name-only heuristics cannot validate files; use directory-backed detection.";
        if (!isAuto) {
            if (requestedExplicit == PK::kUnknown) {
                result.error = "Punctuation: unknown model type: " + reqRaw;
                return result;
            }
            AppendUniqueSource(result.detectionSources, DS::kExplicitModelType);
            result.selectedKind = requestedExplicit;
            result.detectedModels.push_back(
                {PunctuationKindToTag(result.selectedKind), modelDir}
            );
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }

        std::vector<PK> nameKinds = InferKindsNameOnlyFromDir(modelDir);
        if (nameKinds.empty()) {
            result.error = "Punctuation: no model type inferred from directory name (name-only mode).";
            return result;
        }
        result.selectedKind = nameKinds[0];
        for (const PK k : nameKinds) {
            result.detectedModels.push_back({PunctuationKindToTag(k), modelDir});
        }
        AppendUniqueSource(result.detectionSources, DS::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueSource(result.detectionSources, DS::kFileListing);

    const std::string bpe = FindFileByName(files, "bpe.vocab");
    const std::string tokens = FindFileByName(files, "tokens.json");
    const std::string onnx = FindPrimaryOnnxForPunc(files);

    // Online wins if bpe + onnx; else CT if tokens + onnx and no bpe (if bpe exists, we already take online).
    const bool canOnline = !bpe.empty() && !onnx.empty();
    const bool canCt = !tokens.empty() && !onnx.empty() && bpe.empty();

    if (canOnline) {
        result.detectedModels.push_back(
            {PunctuationKindToTag(PK::kCnnBilstm), modelDir}
        );
    }
    if (canCt) {
        result.detectedModels.push_back(
            {PunctuationKindToTag(PK::kCtTransformer), modelDir}
        );
    }

    if (!canOnline && !canCt) {
        if (onnx.empty()) {
            result.error = "Punctuation: no model.onnx or model.int8.onnx in " + modelDir;
        } else {
            result.error = "Punctuation: folder must have (bpe.vocab + model onnx) for online, or "
                           "(tokens.json + model onnx) without bpe for offline CT in " + modelDir;
        }
        return result;
    }

    PK selected = PK::kUnknown;
    if (isAuto) {
        if (canOnline) {
            selected = PK::kCnnBilstm;
            AppendUniqueSource(result.detectionSources, DS::kFallbackOrder);
        } else {
            selected = PK::kCtTransformer;
            AppendUniqueSource(result.detectionSources, DS::kDirName);
        }
    } else {
        if (requestedExplicit == PK::kUnknown) {
            result.error = "Punctuation: unknown model type: " + reqRaw;
            return result;
        }
        selected = requestedExplicit;
        AppendUniqueSource(result.detectionSources, DS::kExplicitModelType);
        if (selected == PK::kCnnBilstm && !canOnline) {
            result.error = "Punctuation: cnn_bilstm layout not found in " + modelDir;
            return result;
        }
        if (selected == PK::kCtTransformer && !canCt) {
            result.error = "Punctuation: ct_transformer layout not found in " + modelDir;
            return result;
        }
    }

    result.selectedKind = selected;
    if (selected == PK::kCnnBilstm) {
        result.paths.cnn_bilstm = onnx;
        result.paths.bpe_vocab = bpe;
    } else {
        result.paths.ct_transformer = onnx;
    }

    auto validation = sherpaonnx::ValidatePunctuationPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.isStreaming = false;
    result.ok = true;
    return result;
}

}  // namespace

namespace sherpaonnx {

using namespace model_detect;

PunctuationDetectResult DetectPunctuationModel(
    const std::optional<std::string>& model_dir_opt,
    const std::optional<std::string>& asset_name_opt,
    const std::string& modelType
) {
    PunctuationDetectResult result;
    result.isStreaming = false;

    const bool has_dir = model_dir_opt && !model_dir_opt->empty();
    const bool has_asset = asset_name_opt && !asset_name_opt->empty();

    if (!has_dir && !has_asset) {
        result.error = "Punctuation: modelDir and assetName are both empty";
        return result;
    }

    if (!has_dir && has_asset) {
        const std::string& assetName = *asset_name_opt;
        const std::string syntheticDir = std::string("m/") + assetName;
        result = DetectPunctuationModelFromFiles({}, syntheticDir, modelType);
        FillPunctuationDerivedCatalogMetadata(result, assetName);
        return result;
    }

    const std::string& modelDir = *model_dir_opt;
    if (modelDir.empty()) {
        result.error = "Punctuation: model directory is empty";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Punctuation: model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const std::vector<model_detect::FileEntry> files = ListFilesRecursive(modelDir, 4);
    result = DetectPunctuationModelFromFiles(files, modelDir, modelType);
    if (has_asset) {
        FillPunctuationDerivedCatalogMetadata(result, *asset_name_opt);
    } else {
        FillPunctuationDerivedCatalogMetadataUsingModelDirBasename(result, modelDir);
    }
    return result;
}

PunctuationDetectResult DetectPunctuationModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType
) {
    PunctuationDetectResult result;
    result.isStreaming = false;
    if (modelDir.empty()) {
        result.error = "Punctuation: model directory is empty";
        return result;
    }
    return DetectPunctuationModelFromFiles(files, modelDir, modelType);
}

}  // namespace sherpaonnx
