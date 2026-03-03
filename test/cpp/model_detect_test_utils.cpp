/**
 * model_detect_test_utils.cpp
 *
 * Test-only implementations: fixture parsing and SttModelKind mapping.
 * Do not use in production code.
 */

#include "model_detect_test_utils.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

namespace model_detect_test {

using namespace sherpaonnx;

static std::string Trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end == std::string::npos ? std::string::npos : end - start + 1);
}

static std::string ToLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

static std::string BaseName(const std::string& path) {
    size_t pos = path.find_last_of("/\\");
    if (pos == std::string::npos) return path;
    return path.substr(pos + 1);
}

std::vector<AssetBlock> ParseAsrStructureFile(const std::string& filePath, std::string* outError) {
    std::vector<AssetBlock> blocks;
    std::ifstream in(filePath);
    if (!in.is_open()) {
        if (outError) *outError = "Cannot open structure file: " + filePath;
        return blocks;
    }
    std::string line;
    AssetBlock* current = nullptr;
    while (std::getline(in, line)) {
        line = Trim(line);
        if (line.empty()) continue;
        const std::string assetPrefix = "# Asset:";
        if (line.size() >= assetPrefix.size() &&
            line.compare(0, assetPrefix.size(), assetPrefix) == 0) {
            std::string assetName = Trim(line.substr(assetPrefix.size()));
            blocks.push_back({});
            current = &blocks.back();
            current->assetName = assetName;
            current->modelDir.clear();
            current->pathLines.clear();
            continue;
        }
        if (!current) continue;
        current->pathLines.push_back(line);
        if (current->modelDir.empty() && !line.empty()) {
            std::string dir = line;
            if (dir.size() > 0 && (dir.back() == '/' || dir.back() == '\\'))
                dir.pop_back();
            current->modelDir = dir;
        }
    }
    return blocks;
}

std::map<std::string, std::string> ParseAsrExpectedCsv(const std::string& filePath, std::string* outError) {
    std::map<std::string, std::string> map;
    std::ifstream in(filePath);
    if (!in.is_open()) {
        if (outError) *outError = "Cannot open CSV file: " + filePath;
        return map;
    }
    std::string line;
    if (!std::getline(in, line) || Trim(line) != "asset_name,model_type") {
        if (outError) *outError = "Expected header asset_name,model_type in " + filePath;
        return map;
    }
    while (std::getline(in, line)) {
        line = Trim(line);
        if (line.empty()) continue;
        size_t comma = line.find(',');
        if (comma == std::string::npos) continue;
        std::string assetName = Trim(line.substr(0, comma));
        std::string modelType = Trim(line.substr(comma + 1));
        if (!assetName.empty())
            map[assetName] = modelType;
    }
    return map;
}

std::vector<sherpaonnx::model_detect::FileEntry> BuildFileEntriesFromPathLines(
    const std::string& modelDir,
    const std::vector<std::string>& pathLines) {
    std::vector<sherpaonnx::model_detect::FileEntry> entries;
    for (const auto& path : pathLines) {
        if (path.empty()) continue;
        if (path.size() >= 1 && (path.back() == '/' || path.back() == '\\'))
            continue;
        sherpaonnx::model_detect::FileEntry e;
        e.path = path;
        std::string name = BaseName(path);
        e.name = name;
        e.nameLower = ToLower(name);
        e.size = 1;
        entries.push_back(e);
    }
    return entries;
}

SttModelKind SttKindFromString(const std::string& modelType) {
    std::string t = ToLower(Trim(modelType));
    if (t == "transducer" || t == "zipformer") return SttModelKind::kTransducer;
    if (t == "nemo_transducer") return SttModelKind::kNemoTransducer;
    if (t == "paraformer") return SttModelKind::kParaformer;
    if (t == "nemo_ctc") return SttModelKind::kNemoCtc;
    if (t == "wenet_ctc") return SttModelKind::kWenetCtc;
    if (t == "sense_voice") return SttModelKind::kSenseVoice;
    if (t == "zipformer_ctc" || t == "ctc") return SttModelKind::kZipformerCtc;
    if (t == "whisper") return SttModelKind::kWhisper;
    if (t == "funasr_nano") return SttModelKind::kFunAsrNano;
    if (t == "fire_red_asr") return SttModelKind::kFireRedAsr;
    if (t == "moonshine") return SttModelKind::kMoonshine;
    if (t == "moonshine_v2") return SttModelKind::kMoonshineV2;
    if (t == "dolphin") return SttModelKind::kDolphin;
    if (t == "canary") return SttModelKind::kCanary;
    if (t == "omnilingual") return SttModelKind::kOmnilingual;
    if (t == "medasr") return SttModelKind::kMedAsr;
    if (t == "telespeech_ctc") return SttModelKind::kTeleSpeechCtc;
    if (t == "tone_ctc") return SttModelKind::kToneCtc;
    return SttModelKind::kUnknown;
}

std::string SttKindToString(SttModelKind kind) {
    switch (kind) {
        case SttModelKind::kTransducer: return "transducer";
        case SttModelKind::kNemoTransducer: return "nemo_transducer";
        case SttModelKind::kParaformer: return "paraformer";
        case SttModelKind::kNemoCtc: return "nemo_ctc";
        case SttModelKind::kWenetCtc: return "wenet_ctc";
        case SttModelKind::kSenseVoice: return "sense_voice";
        case SttModelKind::kZipformerCtc: return "zipformer_ctc";
        case SttModelKind::kWhisper: return "whisper";
        case SttModelKind::kFunAsrNano: return "funasr_nano";
        case SttModelKind::kFireRedAsr: return "fire_red_asr";
        case SttModelKind::kMoonshine: return "moonshine";
        case SttModelKind::kMoonshineV2: return "moonshine_v2";
        case SttModelKind::kDolphin: return "dolphin";
        case SttModelKind::kCanary: return "canary";
        case SttModelKind::kOmnilingual: return "omnilingual";
        case SttModelKind::kMedAsr: return "medasr";
        case SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
        case SttModelKind::kToneCtc: return "tone_ctc";
        default: return "unknown";
    }
}

}  // namespace model_detect_test
