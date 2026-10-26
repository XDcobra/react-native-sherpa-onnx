#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-catalog-metadata.h"
#include "sherpa-onnx-validate-ocr.h"
#include "model_language_catalog.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
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
    // doc_vlm aliases before doctr so "docvlm" / "docling" cannot fall through.
    if (t == "doc_vlm" || t == "docvlm" || t == "doc-vlm" ||
        t == "granite-docling" || t == "docling") {
        return sherpaonnx::OcrModelKind::kDocVlm;
    }
    if (t == "doctr" || t == "onnxtr" || t == "doc-tr" || t == "doc_tr") {
        return sherpaonnx::OcrModelKind::kDoctr;
    }
    if (t == "auto") return sherpaonnx::OcrModelKind::kUnknown;
    return sherpaonnx::OcrModelKind::kUnknown;
}

const char* OcrKindToTag(sherpaonnx::OcrModelKind kind) {
    switch (kind) {
        case sherpaonnx::OcrModelKind::kPpocr:
            return "ppocr";
        case sherpaonnx::OcrModelKind::kDoctr:
            return "doctr";
        case sherpaonnx::OcrModelKind::kDocVlm:
            return "doc_vlm";
        default:
            return "unknown";
    }
}

std::string FindDetOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
    return FindOnnxByAnyTokenExcluding(
        files,
        {"det", "detection", "dbnet", "db_"},
        {"rec", "recognition", "crnn", "svtr", "cls", "ori", "orientation",
         "angle"},
        quantization);
}

std::string FindRecOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
    return FindOnnxByAnyTokenExcluding(
        files,
        {"rec", "recognition", "crnn", "svtr"},
        {"det", "detection", "dbnet", "cls", "ori", "orientation", "angle"},
        quantization);
}

std::string FindClsOnnx(const std::vector<FileEntry>& files,
                        const std::string& quantization) {
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

bool InferDocVlmNameOnly(const std::string& nameHint) {
    const std::string lower = ToLower(nameHint);
    return lower.find("docvlm") != std::string::npos ||
           lower.find("doc-vlm") != std::string::npos ||
           lower.find("doc_vlm") != std::string::npos ||
           lower.find("granite-docling") != std::string::npos ||
           lower.find("docling") != std::string::npos;
}

bool InferPpocrNameOnly(const std::string& nameHint) {
    const std::string lower = ToLower(nameHint);
    return lower.find("ppocr") != std::string::npos ||
           lower.find("paddleocr") != std::string::npos ||
           lower.find("pp-ocr") != std::string::npos;
}

bool InferDoctrNameOnly(const std::string& nameHint) {
    const std::string lower = ToLower(nameHint);
    return lower.find("doctr") != std::string::npos ||
           lower.find("onnxtr") != std::string::npos ||
           lower.find("doc-tr") != std::string::npos ||
           lower.find("doc_tr") != std::string::npos;
}

std::string FindOcrManifest(const std::vector<FileEntry>& files) {
    return FindFileByName(files, "ocr_manifest.json");
}

/**
 * DocTR / OnnxTR layout: det + rec ONNX plus ocr_manifest.json (family discriminator).
 * Distinct from ppocr which requires rec_inference.yml / dict.
 */
bool CanDoctrLayout(const std::vector<FileEntry>& files,
                    const std::string& quantization) {
    const std::string det = FindDetOnnx(files, quantization);
    const std::string rec = FindRecOnnx(files, quantization);
    const std::string manifest = FindOcrManifest(files);
    return !det.empty() && !rec.empty() && !manifest.empty();
}

bool EndsWithOnnxGraph(const std::string& nameLower) {
    const std::string kOnnx = ".onnx";
    if (nameLower.size() < kOnnx.size()) return false;
    if (nameLower.compare(nameLower.size() - kOnnx.size(), kOnnx.size(), kOnnx) !=
        0) {
        return false;
    }
    const std::string kData = ".onnx_data";
    if (nameLower.size() >= kData.size() &&
        nameLower.compare(nameLower.size() - kData.size(), kData.size(), kData) ==
            0) {
        return false;
    }
    return true;
}

std::string OnnxSuffixAfterStem(const std::string& nameLower,
                                const std::string& stem) {
    const std::string kOnnx = ".onnx";
    if (nameLower.size() < stem.size() + kOnnx.size()) return {};
    if (nameLower.compare(0, stem.size(), stem) != 0) return {};
    if (nameLower.compare(nameLower.size() - kOnnx.size(), kOnnx.size(), kOnnx) !=
        0) {
        return {};
    }
    return nameLower.substr(stem.size(),
                            nameLower.size() - stem.size() - kOnnx.size());
}

std::uint64_t FileSizeByPath(const std::vector<FileEntry>& files,
                             const std::string& path) {
    for (const auto& entry : files) {
        if (entry.path == path) return entry.size;
    }
    return 0;
}

struct DocVlmGroup {
    std::string suffix;
    std::string vision;
    std::string vision_data;
    std::string embed;
    std::string embed_data;
    std::string decoder;
    std::string decoder_data;
    std::uint64_t decoder_size = 0;
};

bool TryCompleteDocVlmGroup(const std::vector<FileEntry>& files,
                            const std::string& suffix, DocVlmGroup& out) {
    const std::string vision = FindFileByName(files, "vision_encoder" + suffix + ".onnx");
    const std::string vision_data =
        FindFileByName(files, "vision_encoder" + suffix + ".onnx_data");
    const std::string embed = FindFileByName(files, "embed_tokens" + suffix + ".onnx");
    const std::string embed_data =
        FindFileByName(files, "embed_tokens" + suffix + ".onnx_data");
    const std::string decoder =
        FindFileByName(files, "decoder_model_merged" + suffix + ".onnx");
    const std::string decoder_data =
        FindFileByName(files, "decoder_model_merged" + suffix + ".onnx_data");
    if (vision.empty() || vision_data.empty() || embed.empty() ||
        embed_data.empty() || decoder.empty() || decoder_data.empty()) {
        return false;
    }
    out.suffix = suffix;
    out.vision = vision;
    out.vision_data = vision_data;
    out.embed = embed;
    out.embed_data = embed_data;
    out.decoder = decoder;
    out.decoder_data = decoder_data;
    out.decoder_size = FileSizeByPath(files, decoder);
    return true;
}

std::vector<DocVlmGroup> CollectDocVlmGroups(const std::vector<FileEntry>& files) {
    static const std::string kVisionStem = "vision_encoder";
    std::vector<std::string> suffixes;
    for (const auto& entry : files) {
        if (!EndsWithOnnxGraph(entry.nameLower)) continue;
        if (entry.nameLower.size() < kVisionStem.size() + 5) continue;
        if (entry.nameLower.compare(0, kVisionStem.size(), kVisionStem) != 0) {
            continue;
        }
        const std::string suffix =
            OnnxSuffixAfterStem(entry.nameLower, kVisionStem);
        if (std::find(suffixes.begin(), suffixes.end(), suffix) == suffixes.end()) {
            suffixes.push_back(suffix);
        }
    }

    std::vector<DocVlmGroup> groups;
    for (const auto& suffix : suffixes) {
        DocVlmGroup group;
        if (TryCompleteDocVlmGroup(files, suffix, group)) {
            groups.push_back(std::move(group));
        }
    }
    return groups;
}

bool FlattenFolderAccepts(const std::string& quantization,
                          const std::string& modelDir) {
    const std::string q = ToLower(quantization);
    if (q.empty() || q == "auto") return true;
    const std::string derived =
        sherpaonnx::DeriveQuantization(BaseName(modelDir));
    if (derived == q) return true;
    if ((derived.empty() || derived == "unknown") && q == "fp32") return true;
    return false;
}

const DocVlmGroup* SelectDocVlmGroup(const std::vector<DocVlmGroup>& groups,
                                     const std::string& quantization,
                                     const std::string& modelDir) {
    if (groups.empty()) return nullptr;

    const bool onlyUnsuffixed =
        groups.size() == 1 && groups.front().suffix.empty();
    if (onlyUnsuffixed) {
        return FlattenFolderAccepts(quantization, modelDir) ? &groups.front()
                                                            : nullptr;
    }

    std::vector<const DocVlmGroup*> matching;
    for (const auto& group : groups) {
        if (MatchesQuantization(ToLower(BaseName(group.vision)), quantization)) {
            matching.push_back(&group);
        }
    }
    if (matching.empty()) return nullptr;
    const DocVlmGroup* best = matching.front();
    for (const auto* group : matching) {
        if (group->decoder_size > best->decoder_size) best = group;
    }
    return best;
}

size_t SkipJsonWs(const std::string& s, size_t pos) {
    while (pos < s.size() &&
           (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' || s[pos] == '\r')) {
        ++pos;
    }
    return pos;
}

bool ParseJsonString(const std::string& s, size_t& pos, std::string& out) {
    if (pos >= s.size() || s[pos] != '"') return false;
    ++pos;
    out.clear();
    while (pos < s.size() && s[pos] != '"') {
        if (s[pos] == '\\' && pos + 1 < s.size()) {
            ++pos;
            out.push_back(s[pos]);
        } else {
            out.push_back(s[pos]);
        }
        ++pos;
    }
    if (pos >= s.size() || s[pos] != '"') return false;
    ++pos;
    return true;
}

bool SkipJsonValue(const std::string& s, size_t& pos) {
    pos = SkipJsonWs(s, pos);
    if (pos >= s.size()) return false;
    if (s[pos] == '"') {
        std::string ignored;
        return ParseJsonString(s, pos, ignored);
    }
    if (s[pos] == '{' || s[pos] == '[') {
        int depth = 0;
        do {
            if (s[pos] == '"') {
                std::string ignored;
                if (!ParseJsonString(s, pos, ignored)) return false;
                continue;
            }
            if (s[pos] == '{' || s[pos] == '[') {
                ++depth;
            } else if (s[pos] == '}' || s[pos] == ']') {
                --depth;
            }
            ++pos;
        } while (pos < s.size() && depth > 0);
        return depth == 0;
    }
    while (pos < s.size() && s[pos] != ',' && s[pos] != '}' && s[pos] != ']' &&
           s[pos] != ' ' && s[pos] != '\n' && s[pos] != '\r' && s[pos] != '\t') {
        ++pos;
    }
    return true;
}

enum class ManifestFamilyStatus {
    kUnavailable,
    kKnown,
    kUnsupported
};

struct ManifestFamilyRead {
    ManifestFamilyStatus status = ManifestFamilyStatus::kUnavailable;
    sherpaonnx::OcrModelKind kind = sherpaonnx::OcrModelKind::kUnknown;
};

/**
 * Read `"family"` from ocr_manifest.json when the path is a real file.
 * Missing file, files over 1 MiB, and JSON with no family string are unavailable
 * so fixture listings still resolve by layout. A present but unknown family string
 * is unsupported and must not fall through to filename guessing.
 */
ManifestFamilyRead ReadManifestFamily(const std::string& manifestPath) {
    ManifestFamilyRead out;
    if (manifestPath.empty() || !FileExists(manifestPath)) return out;

    std::ifstream in(manifestPath, std::ios::binary | std::ios::ate);
    if (!in) return out;
    const std::streamoff len = static_cast<std::streamoff>(in.tellg());
    constexpr std::streamoff kMaxBytes = 1024 * 1024;
    if (len < 0 || len > kMaxBytes) return out;
    in.seekg(0);
    std::string json(static_cast<std::size_t>(len), '\0');
    if (len > 0 && !in.read(&json[0], static_cast<std::streamsize>(len))) {
        return out;
    }

    size_t pos = SkipJsonWs(json, 0);
    if (pos >= json.size() || json[pos] != '{') return out;
    ++pos;

    bool sawFamily = false;
    std::string family;
    while (true) {
        pos = SkipJsonWs(json, pos);
        if (pos >= json.size() || json[pos] == '}') break;
        std::string key;
        if (!ParseJsonString(json, pos, key)) return out;
        pos = SkipJsonWs(json, pos);
        if (pos >= json.size() || json[pos] != ':') return out;
        ++pos;
        pos = SkipJsonWs(json, pos);
        if (key == "family") {
            if (pos >= json.size() || json[pos] != '"') return out;
            if (!ParseJsonString(json, pos, family)) return out;
            sawFamily = true;
            break;
        }
        if (!SkipJsonValue(json, pos)) return out;
        pos = SkipJsonWs(json, pos);
        if (pos < json.size() && json[pos] == ',') ++pos;
    }
    if (!sawFamily) return out;

    const auto kind = ParseOcrModelTypeStrict(family);
    if (kind == sherpaonnx::OcrModelKind::kUnknown) {
        out.status = ManifestFamilyStatus::kUnsupported;
        return out;
    }
    out.status = ManifestFamilyStatus::kKnown;
    out.kind = kind;
    return out;
}

void FillDocVlmPaths(sherpaonnx::OcrModelPaths& paths,
                     const std::vector<FileEntry>& files,
                     const DocVlmGroup& group, const std::string& manifest) {
    paths.vision_encoder = group.vision;
    paths.vision_encoder_data = group.vision_data;
    paths.embed_tokens = group.embed;
    paths.embed_tokens_data = group.embed_data;
    paths.decoder = group.decoder;
    paths.decoder_data = group.decoder_data;
    paths.tokenizer = FindFileByName(files, "tokenizer.json");
    paths.manifest =
        manifest.empty() ? FindFileByName(files, "ocr_manifest.json") : manifest;
}

bool LayoutPresent(sherpaonnx::OcrModelKind kind, bool canDocVlm, bool canPpocr,
                   bool canDoctr) {
    switch (kind) {
        case sherpaonnx::OcrModelKind::kDocVlm:
            return canDocVlm;
        case sherpaonnx::OcrModelKind::kPpocr:
            return canPpocr;
        case sherpaonnx::OcrModelKind::kDoctr:
            return canDoctr;
        default:
            return false;
    }
}

std::string LayoutMissingError(sherpaonnx::OcrModelKind kind,
                               const std::string& modelDir) {
    return std::string("OCR: ") + OcrKindToTag(kind) + " layout not found in " +
           modelDir;
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
        if (InferDocVlmNameOnly(modelDir)) {
            result.selectedKind = OK::kDocVlm;
            result.detectedModels.push_back({"doc_vlm", modelDir});
        } else if (InferPpocrNameOnly(modelDir)) {
            result.selectedKind = OK::kPpocr;
            result.detectedModels.push_back({"ppocr", modelDir});
        } else if (InferDoctrNameOnly(modelDir)) {
            result.selectedKind = OK::kDoctr;
            result.detectedModels.push_back({"doctr", modelDir});
        } else {
            result.error =
                "OCR: no model type inferred from directory/asset name "
                "(name-only mode).";
            return result;
        }
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
    const std::string manifest = FindOcrManifest(files);
    const std::string tokenizer = FindFileByName(files, "tokenizer.json");

    const auto docVlmGroups = CollectDocVlmGroups(files);
    const DocVlmGroup* docVlmGroup =
        (!tokenizer.empty() && !manifest.empty())
            ? SelectDocVlmGroup(docVlmGroups, quantization, modelDir)
            : nullptr;
    const bool canDocVlm = docVlmGroup != nullptr;
    const bool canPpocr = !det.empty() && !rec.empty() && !recDict.empty();
    const bool canDoctr = CanDoctrLayout(files, quantization) && !manifest.empty();

    if (canDocVlm) {
        result.detectedModels.push_back({"doc_vlm", modelDir});
    }
    if (canPpocr) {
        result.detectedModels.push_back({"ppocr", modelDir});
    }
    if (canDoctr) {
        result.detectedModels.push_back({"doctr", modelDir});
    }

    OK selected = OK::kUnknown;
    if (!isAuto) {
        if (requestedExplicit == OK::kUnknown) {
            result.error = "OCR: unknown model type: " + reqRaw;
            return result;
        }
        selected = requestedExplicit;
        AppendUniqueSource(result.detectionSources, DS::kExplicitModelType);
        if (!LayoutPresent(selected, canDocVlm, canPpocr, canDoctr)) {
            result.error = LayoutMissingError(selected, modelDir);
            return result;
        }
    } else {
        const ManifestFamilyRead family = ReadManifestFamily(manifest);
        if (family.status == ManifestFamilyStatus::kUnsupported) {
            result.error =
                "OCR: ocr_manifest.json family is not a supported OCR family";
            return result;
        }
        if (family.status == ManifestFamilyStatus::kKnown) {
            selected = family.kind;
            if (!LayoutPresent(selected, canDocVlm, canPpocr, canDoctr)) {
                result.error = LayoutMissingError(selected, modelDir);
                return result;
            }
        } else if (canDocVlm) {
            selected = OK::kDocVlm;
            AppendUniqueSource(result.detectionSources, DS::kFallbackOrder);
        } else if (canPpocr) {
            selected = OK::kPpocr;
            AppendUniqueSource(result.detectionSources, DS::kFallbackOrder);
        } else if (canDoctr) {
            selected = OK::kDoctr;
            AppendUniqueSource(result.detectionSources, DS::kFallbackOrder);
        } else {
            result.error =
                "OCR: unrecognized pack layout (need a complete doc_vlm "
                "vision/embed/decoder triple plus tokenizer.json and "
                "ocr_manifest.json, or det + rec ONNX and either a rec "
                "dictionary yml/txt for ppocr, or ocr_manifest.json for "
                "doctr) in " +
                modelDir;
            return result;
        }
    }

    result.selectedKind = selected;
    if (selected == OK::kDocVlm) {
        if (docVlmGroup == nullptr) {
            result.error = LayoutMissingError(selected, modelDir);
            return result;
        }
        FillDocVlmPaths(result.paths, files, *docVlmGroup, manifest);
    } else if (selected == OK::kPpocr) {
        result.paths.det = det;
        result.paths.rec = rec;
        result.paths.cls = cls;
        result.paths.rec_dict = recDict;
    } else if (selected == OK::kDoctr) {
        result.paths.det = det;
        result.paths.rec = rec;
        result.paths.cls = cls;
        result.paths.manifest = manifest;
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
    if (result.quantization.empty() || result.quantization == "unknown") {
        std::string graphPath = result.paths.vision_encoder;
        if (graphPath.empty()) graphPath = result.paths.det;
        if (graphPath.empty()) graphPath = result.paths.rec;
        if (!graphPath.empty()) {
            std::string fileQuant =
                sherpaonnx::DeriveQuantization(BaseName(graphPath));
            if (fileQuant != "unknown") {
                result.quantization = fileQuant;
            }
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
