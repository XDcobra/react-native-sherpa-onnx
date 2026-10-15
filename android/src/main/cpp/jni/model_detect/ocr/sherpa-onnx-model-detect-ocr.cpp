#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-catalog-metadata.h"
#include "sherpa-onnx-validate-ocr.h"
#include "model_language_catalog.h"

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace {

using namespace sherpaonnx::model_detect;

void AppendUniqueSource(std::vector<sherpaonnx::DetectionSource>& out,
                        sherpaonnx::DetectionSource s) {
    if (std::find(out.begin(), out.end(), s) == out.end()) {
        out.push_back(s);
    }
}

sherpaonnx::OcrModelKind ParseOcrModelTypeStrict(const std::string& modelType) {
    const std::string t = ToLower(modelType);
    if (t == "ppocr" || t == "paddleocr" || t == "pp-ocr") {
        return sherpaonnx::OcrModelKind::kPpocr;
    }
    if (t == "auto") return sherpaonnx::OcrModelKind::kUnknown;
    return sherpaonnx::OcrModelKind::kUnknown;
}

const char* OcrKindToTag(sherpaonnx::OcrModelKind kind) {
    switch (kind) {
        case sherpaonnx::OcrModelKind::kPpocr:
            return "ppocr";
        default:
            return "unknown";
    }
}

std::string PreferExactOnnx(const std::vector<FileEntry>& files,
                            const std::vector<std::string>& exactNames,
                            const std::string& quantization) {
    if (!quantization.empty() && quantization != "auto") {
        const std::string q = ToLower(quantization);
        for (const auto& base : exactNames) {
            // e.g. det.onnx → det.int8.onnx when quant requested
            const auto dot = base.rfind('.');
            if (dot == std::string::npos) continue;
            const std::string candidate =
                base.substr(0, dot) + "." + q + base.substr(dot);
            std::string hit = FindFileByName(files, candidate);
            if (!hit.empty()) return hit;
        }
    }
    for (const auto& name : exactNames) {
        std::string hit = FindFileByName(files, name);
        if (!hit.empty()) return hit;
    }
    return "";
}

std::string FindDetOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
    std::string exact =
        PreferExactOnnx(files, {"det.onnx", "det.int8.onnx", "det.fp16.onnx"},
                        quantization);
    if (!exact.empty()) return exact;
    return FindOnnxByAnyTokenExcluding(
        files,
        {"det", "detection", "dbnet", "db_"},
        {"rec", "recognition", "crnn", "svtr", "cls", "ori", "orientation",
         "angle"},
        quantization);
}

std::string FindRecOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
    std::string exact =
        PreferExactOnnx(files, {"rec.onnx", "rec.int8.onnx", "rec.fp16.onnx"},
                        quantization);
    if (!exact.empty()) return exact;
    return FindOnnxByAnyTokenExcluding(
        files,
        {"rec", "recognition", "crnn", "svtr"},
        {"det", "detection", "dbnet", "cls", "ori", "orientation", "angle"},
        quantization);
}

std::string FindClsOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
    std::string exact =
        PreferExactOnnx(files, {"cls.onnx", "cls.int8.onnx", "cls.fp16.onnx"},
                        quantization);
    if (!exact.empty()) return exact;
    return FindOnnxByAnyTokenExcluding(
        files,
        {"cls", "ori", "orientation", "angle"},
        {"det", "detection", "rec", "recognition", "crnn", "svtr", "dbnet"},
        quantization);
}

std::string FindRecDict(const std::vector<FileEntry>& files) {
    std::string hit = FindFileByName(files, "rec_inference.yml");
    if (!hit.empty()) return hit;
    hit = FindFileByName(files, "inference.yml");
    if (!hit.empty()) return hit;

    for (const auto& entry : files) {
        const bool isYml =
            entry.nameLower.size() > 4 &&
            entry.nameLower.substr(entry.nameLower.size() - 4) == ".yml";
        if (!isYml) continue;
        if (entry.nameLower.find("inference") != std::string::npos ||
            entry.nameLower.find("rec") != std::string::npos) {
            return entry.path;
        }
    }

    hit = FindFileByName(files, "dict.txt");
    if (!hit.empty()) return hit;
    hit = FindFileEndingWith(files, "dict.txt");
    if (!hit.empty()) return hit;

    for (const auto& entry : files) {
        if (entry.nameLower.find("ppocr_keys") != std::string::npos) {
            return entry.path;
        }
    }
    return "";
}

bool InferPpocrNameOnly(const std::string& nameHint) {
    const std::string lower = ToLower(nameHint);
    return lower.find("ppocr") != std::string::npos ||
           lower.find("paddleocr") != std::string::npos ||
           lower.find("pp-ocr") != std::string::npos;
}

/**
 * Future family hook (docTR / OnnxTR): different file co-occurrence.
 * Keep false until a DoctrBackend + pack layout exists.
 */
bool CanDoctrLayout(const std::vector<FileEntry>& /*files*/) {
    return false;
}

sherpaonnx::OcrDetectResult DetectOcrModelFromFiles(
    const std::vector<FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization
) {
    using DS = sherpaonnx::DetectionSource;
    using OK = sherpaonnx::OcrModelKind;
    sherpaonnx::OcrDetectResult result;

    const std::string reqRaw = modelType.empty() ? "auto" : modelType;
    const std::string reqLower = ToLower(reqRaw);
    const bool isAuto = (reqLower == "auto");
    const OK requestedExplicit =
        isAuto ? OK::kUnknown : ParseOcrModelTypeStrict(reqRaw);

    if (files.empty()) {
        AppendUniqueSource(result.detectionSources, DS::kNameOnly);
        static constexpr const char* kNameOnlyErr =
            "OCR: name-only heuristics cannot validate files; use "
            "directory-backed detection.";
        if (!isAuto) {
            if (requestedExplicit == OK::kUnknown) {
                result.error = "OCR: unknown model type: " + reqRaw;
                return result;
            }
            AppendUniqueSource(result.detectionSources, DS::kExplicitModelType);
            result.selectedKind = requestedExplicit;
            result.detectedModels.push_back(
                {OcrKindToTag(result.selectedKind), modelDir});
            result.ok = false;
            result.error = kNameOnlyErr;
            return result;
        }
        if (!InferPpocrNameOnly(modelDir)) {
            result.error =
                "OCR: no model type inferred from directory/asset name "
                "(name-only mode).";
            return result;
        }
        result.selectedKind = OK::kPpocr;
        result.detectedModels.push_back({"ppocr", modelDir});
        AppendUniqueSource(result.detectionSources, DS::kDirName);
        result.ok = false;
        result.error = kNameOnlyErr;
        return result;
    }

    AppendUniqueSource(result.detectionSources, DS::kFileListing);

    const std::string det = FindDetOnnx(files, quantization);
    const std::string rec = FindRecOnnx(files, quantization);
    const std::string cls = FindClsOnnx(files, quantization);
    const std::string recDict = FindRecDict(files);

    const bool canPpocr = !det.empty() && !rec.empty() && !recDict.empty();
    const bool canDoctr = CanDoctrLayout(files);

    if (canPpocr) {
        result.detectedModels.push_back({"ppocr", modelDir});
    }
    if (canDoctr) {
        result.detectedModels.push_back({"doctr", modelDir});
    }

    if (!canPpocr && !canDoctr) {
        result.error =
            "OCR: unrecognized pack layout (need det + rec ONNX and a "
            "rec dictionary yml/txt) in " +
            modelDir;
        return result;
    }

    OK selected = OK::kUnknown;
    if (isAuto) {
        if (canPpocr) {
            selected = OK::kPpocr;
            AppendUniqueSource(result.detectionSources, DS::kFallbackOrder);
        } else {
            // canDoctr only (future)
            result.error = "OCR: no supported family detected in " + modelDir;
            return result;
        }
    } else {
        if (requestedExplicit == OK::kUnknown) {
            result.error = "OCR: unknown model type: " + reqRaw;
            return result;
        }
        selected = requestedExplicit;
        AppendUniqueSource(result.detectionSources, DS::kExplicitModelType);
        if (selected == OK::kPpocr && !canPpocr) {
            result.error = "OCR: ppocr layout not found in " + modelDir;
            return result;
        }
    }

    result.selectedKind = selected;
    if (selected == OK::kPpocr) {
        result.paths.det = det;
        result.paths.rec = rec;
        result.paths.cls = cls;
        result.paths.rec_dict = recDict;
    }

    auto validation =
        sherpaonnx::ValidateOcrPaths(selected, result.paths, modelDir);
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.ok = true;
    return result;
}

void FillOcrCatalogHeuristics(sherpaonnx::OcrDetectResult& result,
                              const std::string& nameHint) {
    sherpaonnx::FillDerivedCatalogMetadataFromBasename(
        result.derivedLanguages, result.quantization, result.sizeTier,
        nameHint);
    if ((result.quantization.empty() || result.quantization == "unknown") &&
        !result.paths.rec.empty()) {
        std::string fileQuant =
            sherpaonnx::DeriveQuantization(BaseName(result.paths.rec));
        if (fileQuant != "unknown") {
            result.quantization = fileQuant;
        }
    }
    // Basename heuristics first; curated pack/family rows only when empty.
    sherpaonnx::AppendCuratedOcrLanguageRowsIfEmpty(result, BaseName(nameHint));
}

}  // namespace

namespace sherpaonnx {

using namespace model_detect;

OcrDetectResult DetectOcrModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name,
    const std::string& modelType,
    const std::string& quantization
) {
    OcrDetectResult result;

    const bool hasDir = model_dir.has_value() && !model_dir->empty();
    const bool hasAsset = asset_name.has_value() && !asset_name->empty();
    if (!hasDir && !hasAsset) {
        result.error = "OCR: model directory and asset name are both empty";
        return result;
    }

    std::string scanKey;
    std::vector<FileEntry> files;

    if (hasDir && FileExists(*model_dir) && IsDirectory(*model_dir)) {
        scanKey = *model_dir;
        files = ListFilesRecursive(*model_dir, 4);
    } else if (hasAsset) {
        // Name-only catalog path: synthetic empty listing + basename hint.
        scanKey = *asset_name;
        files.clear();
    } else if (hasDir) {
        // Non-directory string used as name hint (e.g. unified detect with asset key).
        scanKey = *model_dir;
        files.clear();
    }

    result = DetectOcrModelFromFiles(files, scanKey, modelType, quantization);
    FillOcrCatalogHeuristics(result, scanKey);
    return result;
}

OcrDetectResult DetectOcrModelFromFileList(
    const std::vector<model_detect::FileEntry>& files,
    const std::string& modelDir,
    const std::string& modelType,
    const std::string& quantization
) {
    OcrDetectResult result;
    if (modelDir.empty()) {
        result.error = "OCR: model directory is empty";
        return result;
    }
    result = DetectOcrModelFromFiles(files, modelDir, modelType, quantization);
    FillOcrCatalogHeuristics(result, modelDir);
    return result;
}

}  // namespace sherpaonnx
