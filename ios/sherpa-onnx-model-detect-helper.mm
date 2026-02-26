#include "sherpa-onnx-model-detect-helper.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace sherpaonnx {
namespace model_detect {

namespace {

bool EndsWith(const std::string& value, const std::string& suffix) {
    if (suffix.size() > value.size()) return false;
    return std::equal(suffix.rbegin(), suffix.rend(), value.rbegin());
}

bool ContainsToken(const std::string& value, const std::string& token) {
    return value.find(token) != std::string::npos;
}

std::string ChooseLargest(const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens, bool onlyInt8, bool onlyNonInt8) {
    std::string chosen;
    std::uint64_t bestSize = 0;
    for (const auto& entry : files) {
        if (!EndsWith(entry.nameLower, ".onnx")) continue;
        bool hasExcluded = false;
        for (const auto& token : excludeTokens) {
            if (ContainsToken(entry.nameLower, token)) { hasExcluded = true; break; }
        }
        if (hasExcluded) continue;
        bool isInt8 = ContainsToken(entry.nameLower, "int8");
        if (onlyInt8 && !isInt8) continue;
        if (onlyNonInt8 && isInt8) continue;
        if (entry.size >= bestSize) {
            bestSize = entry.size;
            chosen = entry.path;
        }
    }
    return chosen;
}

} // namespace

bool FileExists(const std::string& path) {
    return fs::exists(path);
}

bool IsDirectory(const std::string& path) {
    return fs::is_directory(path);
}

std::string ToLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::vector<std::string> ListDirectories(const std::string& path) {
    std::vector<std::string> results;
    try {
        for (const auto& entry : fs::directory_iterator(path)) {
            if (entry.is_directory()) results.push_back(entry.path().string());
        }
    } catch (const std::exception&) {}
    return results;
}

std::vector<FileEntry> ListFiles(const std::string& dir) {
    std::vector<FileEntry> results;
    try {
        for (const auto& entry : fs::directory_iterator(dir)) {
            if (!entry.is_regular_file()) continue;
            FileEntry file;
            file.path = entry.path().string();
            std::string name = entry.path().filename().string();
            file.nameLower = ToLower(name);
            file.size = static_cast<std::uint64_t>(entry.file_size());
            results.push_back(file);
        }
    } catch (const std::exception&) {}
    return results;
}

std::vector<FileEntry> ListFilesRecursive(const std::string& path, int maxDepth) {
    std::vector<FileEntry> results = ListFiles(path);
    if (maxDepth <= 0) return results;
    for (const auto& dir : ListDirectories(path)) {
        auto nested = ListFilesRecursive(dir, maxDepth - 1);
        results.insert(results.end(), nested.begin(), nested.end());
    }
    return results;
}

std::string FindLargestOnnxExcludingTokens(const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens) {
    return ChooseLargest(files, excludeTokens, false, false);
}

std::string FindOnnxByToken(const std::vector<FileEntry>& files,
    const std::string& token, const std::optional<bool>& preferInt8) {
    std::string tokenLower = ToLower(token);
    std::vector<FileEntry> matches;
    for (const auto& entry : files) {
        if (!EndsWith(entry.nameLower, ".onnx")) continue;
        if (ContainsToken(entry.nameLower, tokenLower)) matches.push_back(entry);
    }
    if (matches.empty()) return "";
    std::vector<std::string> emptyTokens;
    bool wantInt8 = preferInt8.has_value() && preferInt8.value();
    bool wantNonInt8 = preferInt8.has_value() && !preferInt8.value();
    std::string preferred = ChooseLargest(matches, emptyTokens, wantInt8, wantNonInt8);
    if (!preferred.empty()) return preferred;
    return ChooseLargest(matches, emptyTokens, false, false);
}

std::string FindOnnxByAnyToken(const std::vector<FileEntry>& files,
    const std::vector<std::string>& tokens, const std::optional<bool>& preferInt8) {
    for (const auto& token : tokens) {
        std::string match = FindOnnxByToken(files, token, preferInt8);
        if (!match.empty()) return match;
    }
    return "";
}

std::string FindFileEndingWith(const std::vector<FileEntry>& files, const std::string& suffix) {
    std::string targetSuffix = ToLower(suffix);
    for (const auto& entry : files) {
        if (entry.nameLower == targetSuffix) return entry.path;
    }
    for (const auto& entry : files) {
        if (EndsWith(entry.nameLower, targetSuffix)) return entry.path;
    }
    return "";
}

std::string FindFileByName(const std::string& baseDir, const std::string& fileName, int maxDepth) {
    std::string target = ToLower(fileName);
    auto files = ListFilesRecursive(baseDir, maxDepth);
    for (const auto& entry : files) {
        if (entry.nameLower == target) return entry.path;
    }
    return "";
}

std::string FindDirectoryByName(const std::string& baseDir, const std::string& dirName, int maxDepth) {
    std::string target = ToLower(dirName);
    std::vector<std::string> toVisit = ListDirectories(baseDir);
    int depth = 0;
    while (!toVisit.empty() && depth <= maxDepth) {
        std::vector<std::string> next;
        for (const auto& dir : toVisit) {
            std::string name = fs::path(dir).filename().string();
            if (ToLower(name) == target) return dir;
            if (depth < maxDepth) {
                auto nested = ListDirectories(dir);
                next.insert(next.end(), nested.begin(), nested.end());
            }
        }
        toVisit.swap(next);
        depth += 1;
    }
    return "";
}

std::string ResolveTokenizerDir(const std::string& modelDir) {
    std::string vocabInMain = modelDir + "/vocab.json";
    if (FileExists(vocabInMain)) {
        return modelDir;
    }

    try {
        for (const auto& entry : fs::directory_iterator(modelDir)) {
            if (entry.is_directory()) {
                std::string dirName = entry.path().filename().string();
                std::string dirNameLower = ToLower(dirName);
                if (dirNameLower.find("qwen3") != std::string::npos) {
                    std::string vocabPath = entry.path().string() + "/vocab.json";
                    if (FileExists(vocabPath)) {
                        return entry.path().string();
                    }
                }
            }
        }
    } catch (const std::exception&) {
    }

    std::string commonPath = modelDir + "/Qwen3-0.6B";
    if (FileExists(commonPath + "/vocab.json")) {
        return commonPath;
    }

    return "";
}

} // namespace model_detect
} // namespace sherpaonnx
