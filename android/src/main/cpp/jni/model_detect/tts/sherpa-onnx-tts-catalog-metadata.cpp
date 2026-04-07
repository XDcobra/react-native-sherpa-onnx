/**
 * sherpa-onnx-tts-catalog-metadata.cpp
 *
 * Derives catalog-style hints (languages, quantization, size tier) from model id strings.
 * Used by TTS model detection; no filesystem access.
 */
#include "sherpa-onnx-tts-catalog-metadata.h"
#include "sherpa-onnx-model-detect-helper.h"
#include <algorithm>
#include <cctype>
#include <regex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpaonnx {
namespace {

using model_detect::ToLower;

static std::string BasenameLastPathComponent(const std::string& path) {
    size_t pos = path.find_last_of("/\\");
    return (pos == std::string::npos) ? path : path.substr(pos + 1);
}

static const char* kQuantUnknown = "unknown";
static const char* kSizeUnknown = "unknown";

static std::string DeriveQuantization(const std::string& id) {
    std::string lower = ToLower(id);
    if (lower.find("int8") != std::string::npos && lower.find("quant") != std::string::npos) {
        return "int8-quantized";
    }
    if (lower.find("int8") != std::string::npos) return "int8";
    if (lower.find("fp16") != std::string::npos) return "fp16";
    return kQuantUnknown;
}

static std::string DeriveSizeTier(const std::string& id) {
    std::string lower = ToLower(id);
    if (lower.find("tiny") != std::string::npos) return "tiny";
    if (lower.find("small") != std::string::npos) return "small";
    if (lower.find("medium") != std::string::npos) return "medium";
    if (lower.find("large") != std::string::npos) return "large";
    if (lower.find("low") != std::string::npos) return "small";
    return kSizeUnknown;
}

static std::vector<std::string> SplitByChar(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == sep) {
            if (!cur.empty()) {
                out.push_back(cur);
                cur.clear();
            }
        } else {
            cur += c;
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

static std::vector<std::string> SplitDashesUnderscoresCatalog(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == '-' || c == '_') {
            if (!cur.empty()) {
                out.push_back(cur);
                cur.clear();
            }
        } else {
            cur += c;
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

static std::string CollapseLocaleLanguageRegionUnderscore(const std::string& id) {
    try {
        std::regex re("([a-z]{2})_([A-Z]{2})");
        return std::regex_replace(id, re, "$1");
    } catch (...) {
        return id;
    }
}

static bool IsFalsePositiveTwoLetter(const std::string& tok) {
    return tok == "hf" || tok == "ll";
}

static bool AllLowerAscii2(const std::string& t) {
    return t.size() == 2 && std::isalpha(static_cast<unsigned char>(t[0])) &&
           std::isalpha(static_cast<unsigned char>(t[1])) &&
           std::islower(static_cast<unsigned char>(t[0])) && std::islower(static_cast<unsigned char>(t[1]));
}

static bool IsLlCcPattern(const std::string& t) {
    return t.size() == 4 && std::islower(static_cast<unsigned char>(t[0])) && std::islower(static_cast<unsigned char>(t[1])) &&
           std::isupper(static_cast<unsigned char>(t[2])) && std::isupper(static_cast<unsigned char>(t[3]));
}

static bool IsLlHyphenCcPattern(const std::string& t) {
    return t.size() == 5 && t[2] == '-' && std::islower(static_cast<unsigned char>(t[0])) &&
           std::islower(static_cast<unsigned char>(t[1])) && std::isupper(static_cast<unsigned char>(t[3])) &&
           std::isupper(static_cast<unsigned char>(t[4]));
}

static void PushUniqueLang(std::vector<std::string>& out, const std::string& lang) {
    if (std::find(out.begin(), out.end(), lang) == out.end()) out.push_back(lang);
}

static std::vector<std::string> CollectLanguagesFromTokens(const std::string& id) {
    std::vector<std::string> tokens = SplitDashesUnderscoresCatalog(id);
    std::vector<std::string> out;
    for (const std::string& token : tokens) {
        if (AllLowerAscii2(token)) {
            if (!IsFalsePositiveTwoLetter(token)) PushUniqueLang(out, token);
            continue;
        }
        if (IsLlCcPattern(token)) {
            PushUniqueLang(out, ToLower(token.substr(0, 2)));
            continue;
        }
        if (IsLlHyphenCcPattern(token)) {
            PushUniqueLang(out, ToLower(token.substr(0, 2)));
        }
    }
    return out;
}

static const char* MmsIso639_2To1(const std::string& key) {
    static const std::unordered_map<std::string, const char*> m = {
        {"deu", "de"}, {"eng", "en"}, {"fra", "fr"}, {"rus", "ru"}, {"spa", "es"},
        {"tha", "th"}, {"ukr", "uk"},
    };
    auto it = m.find(key);
    return it == m.end() ? nullptr : it->second;
}

static std::vector<std::string> DeriveLanguagesFromModelId(const std::string& id) {
    std::string lower = ToLower(id);

    if (lower.size() >= 11 && lower.compare(0, 11, "vits-coqui-") == 0) {
        auto parts = SplitByChar(id, '-');
        if (parts.size() > 2) {
            const std::string& segment = parts[2];
            if (segment.size() == 2 && std::isalpha(static_cast<unsigned char>(segment[0])) &&
                std::isalpha(static_cast<unsigned char>(segment[1]))) {
                return {ToLower(segment)};
            }
        }
    }

    if (lower.size() >= 9 && lower.compare(0, 9, "vits-mms-") == 0) {
        auto parts = SplitByChar(id, '-');
        if (parts.size() > 2) {
            std::string key = ToLower(parts[2]);
            const char* mapped = MmsIso639_2To1(key);
            if (mapped) return {std::string(mapped)};
            if (key == "nan") return {"nan"};
        }
    }

    std::string normalized = CollapseLocaleLanguageRegionUnderscore(id);
    return CollectLanguagesFromTokens(normalized);
}

} // namespace

void FillTtsDerivedCatalogMetadata(TtsDetectResult& r, const std::string& idForHeuristics) {
    if (idForHeuristics.empty()) {
        return;
    }
    r.derivedLanguages = DeriveLanguagesFromModelId(idForHeuristics);
    r.quantization = DeriveQuantization(idForHeuristics);
    r.sizeTier = DeriveSizeTier(idForHeuristics);
}

void FillTtsDerivedCatalogMetadataUsingModelDirBasename(TtsDetectResult& r, const std::string& modelDir) {
    FillTtsDerivedCatalogMetadata(r, BasenameLastPathComponent(modelDir));
}

} // namespace sherpaonnx
