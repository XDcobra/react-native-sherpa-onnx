/**
 * sherpa-onnx-model-detect-helper.cpp
 *
 * Purpose: Shared filesystem and string helpers for model detection (file/dir listing, token-based
 * ONNX search, path resolution). Used by sherpa-onnx-model-detect-stt.cpp and -tts.cpp on Android.
 */
#include "sherpa-onnx-model-detect-helper.h"

#include <algorithm>
#include <cctype>
#include <fstream>

#if __cplusplus >= 201703L && __has_include(<filesystem>)
#include <filesystem>
namespace fs = std::filesystem;
#elif __has_include(<experimental/filesystem>)
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#else
#include <dirent.h>
#include <sys/stat.h>
#endif

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

bool IsOnnxOrOrtFile(const FileEntry& entry) {
    return EndsWith(entry.nameLower, ".onnx") || EndsWith(entry.nameLower, ".ort");
}

std::string BaseName(const std::string& path) {
    size_t pos = path.find_last_of("/\\");
    if (pos == std::string::npos) return path;
    return path.substr(pos + 1);
}

std::string ChooseLargest(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens,
    bool onlyInt8,
    bool onlyNonInt8
) {
    std::string chosen;
    std::uint64_t bestSize = 0;

    for (const auto& entry : files) {
        if (!IsOnnxOrOrtFile(entry)) continue;

        bool hasExcluded = false;
        for (const auto& token : excludeTokens) {
            if (ContainsToken(entry.nameLower, token)) {
                hasExcluded = true;
                break;
            }
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
#if __cplusplus >= 201703L && __has_include(<filesystem>)
    return std::filesystem::exists(path);
#elif __has_include(<experimental/filesystem>)
    return std::experimental::filesystem::exists(path);
#else
    struct stat buffer;
    return (stat(path.c_str(), &buffer) == 0);
#endif
}

bool IsDirectory(const std::string& path) {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
    return std::filesystem::is_directory(path);
#elif __has_include(<experimental/filesystem>)
    return std::experimental::filesystem::is_directory(path);
#else
    struct stat buffer;
    if (stat(path.c_str(), &buffer) != 0) return false;
    return S_ISDIR(buffer.st_mode);
#endif
}

std::vector<std::string> ListDirectories(const std::string& path) {
    std::vector<std::string> results;
#if __cplusplus >= 201703L && __has_include(<filesystem>)
    try {
        for (const auto& entry : fs::directory_iterator(path)) {
            if (entry.is_directory()) {
                results.push_back(entry.path().string());
            }
        }
    } catch (const std::exception&) {
    }
#elif __has_include(<experimental/filesystem>)
    try {
        for (const auto& entry : fs::directory_iterator(path)) {
            if (entry.is_directory()) {
                results.push_back(entry.path().string());
            }
        }
    } catch (const std::exception&) {
    }
#else
    DIR* dir = opendir(path.c_str());
    if (!dir) return results;
    while (auto* entry = readdir(dir)) {
        if (!entry->d_name) continue;
        std::string name = entry->d_name;
        if (name == "." || name == "..") continue;
        std::string full = path + "/" + name;
        struct stat st;
        if (stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
            results.push_back(full);
        }
    }
    closedir(dir);
#endif
    return results;
}

std::vector<FileEntry> ListFiles(const std::string& path) {
    std::vector<FileEntry> results;
#if __cplusplus >= 201703L && __has_include(<filesystem>)
    try {
        for (const auto& entry : fs::directory_iterator(path)) {
            if (!entry.is_regular_file()) continue;
            FileEntry file;
            file.path = entry.path().string();
            file.name = entry.path().filename().string();
            file.nameLower = ToLower(file.name);
            file.size = static_cast<std::uint64_t>(entry.file_size());
            results.push_back(file);
        }
    } catch (const std::exception&) {
    }
#elif __has_include(<experimental/filesystem>)
    try {
        for (const auto& entry : fs::directory_iterator(path)) {
            if (!entry.is_regular_file()) continue;
            FileEntry file;
            file.path = entry.path().string();
            file.name = entry.path().filename().string();
            file.nameLower = ToLower(file.name);
            file.size = static_cast<std::uint64_t>(entry.file_size());
            results.push_back(file);
        }
    } catch (const std::exception&) {
    }
#else
    DIR* dir = opendir(path.c_str());
    if (!dir) return results;
    while (auto* entry = readdir(dir)) {
        if (!entry->d_name) continue;
        std::string name = entry->d_name;
        if (name == "." || name == "..") continue;
        std::string full = path + "/" + name;
        struct stat st;
        if (stat(full.c_str(), &st) == 0 && S_ISREG(st.st_mode)) {
            FileEntry file;
            file.path = full;
            file.name = name;
            file.nameLower = ToLower(name);
            file.size = static_cast<std::uint64_t>(st.st_size);
            results.push_back(file);
        }
    }
    closedir(dir);
#endif
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

std::string ToLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string FindFileByName(const std::vector<FileEntry>& files, const std::string& fileName) {
    std::string target = ToLower(fileName);
    for (const auto& entry : files) {
        if (entry.nameLower == target) {
            return entry.path;
        }
    }
    return "";
}

std::string FindFileEndingWith(const std::vector<FileEntry>& files, const std::string& suffix) {
    std::string targetSuffix = ToLower(suffix);
    for (const auto& entry : files) {
        if (entry.nameLower == targetSuffix) return entry.path;
    }
    for (const auto& entry : files) {
        if (targetSuffix.size() <= entry.nameLower.size() &&
            std::equal(targetSuffix.rbegin(), targetSuffix.rend(), entry.nameLower.rbegin())) {
            return entry.path;
        }
    }
    return "";
}

std::string FindOnnxByToken(
    const std::vector<FileEntry>& files,
    const std::string& token,
    const std::optional<bool>& preferInt8
) {
    std::vector<FileEntry> matches;
    std::string tokenLower = ToLower(token);
    for (const auto& entry : files) {
        if (!IsOnnxOrOrtFile(entry)) continue;
        if (ContainsToken(entry.nameLower, tokenLower)) {
            matches.push_back(entry);
        }
    }

    if (matches.empty()) return "";

    std::vector<std::string> emptyTokens;
    bool wantInt8 = preferInt8.has_value() && preferInt8.value();
    bool wantNonInt8 = preferInt8.has_value() && !preferInt8.value();

    std::string preferred = ChooseLargest(matches, emptyTokens, wantInt8, wantNonInt8);
    if (!preferred.empty()) return preferred;

    return ChooseLargest(matches, emptyTokens, false, false);
}

std::string FindOnnxByAnyToken(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& tokens,
    const std::optional<bool>& preferInt8
) {
    for (const auto& token : tokens) {
        std::string match = FindOnnxByToken(files, token, preferInt8);
        if (!match.empty()) return match;
    }
    return "";
}

std::string FindOnnxByAnyTokenExcluding(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& tokens,
    const std::vector<std::string>& excludeInName,
    const std::optional<bool>& preferInt8
) {
    for (const auto& token : tokens) {
        std::string tokenLower = ToLower(token);
        std::vector<FileEntry> matches;
        for (const auto& entry : files) {
            if (!IsOnnxOrOrtFile(entry)) continue;
            if (!ContainsToken(entry.nameLower, tokenLower)) continue;
            bool excluded = false;
            for (const auto& ex : excludeInName) {
                std::string exLower = ToLower(ex);
                if (ContainsToken(entry.nameLower, exLower)) {
                    excluded = true;
                    break;
                }
            }
            if (!excluded) matches.push_back(entry);
        }
        if (matches.empty()) continue;
        std::vector<std::string> emptyTokens;
        bool wantInt8 = preferInt8.has_value() && preferInt8.value();
        bool wantNonInt8 = preferInt8.has_value() && !preferInt8.value();
        std::string chosen = ChooseLargest(matches, emptyTokens, wantInt8, wantNonInt8);
        if (!chosen.empty()) return chosen;
        chosen = ChooseLargest(matches, emptyTokens, false, false);
        if (!chosen.empty()) return chosen;
    }
    return "";
}

std::string FindLargestOnnx(const std::vector<FileEntry>& files) {
    std::vector<std::string> emptyTokens;
    return ChooseLargest(files, emptyTokens, false, false);
}

std::string FindLargestOnnxExcludingTokens(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens
) {
    return ChooseLargest(files, excludeTokens, false, false);
}

bool ContainsWord(const std::string& haystack, const std::string& word) {
    if (word.empty()) return false;
    size_t pos = 0;
    auto isSep = [](char c) {
        return c == '\0' || c == '/' || c == '-' || c == '_' || c == '.' || c == ' ';
    };
    while ((pos = haystack.find(word, pos)) != std::string::npos) {
        char before = (pos == 0) ? '\0' : haystack[pos - 1];
        size_t afterPos = pos + word.size();
        char after = (afterPos >= haystack.size()) ? '\0' : haystack[afterPos];
        if (isSep(before) && isSep(after)) return true;
        pos++;
    }
    return false;
}

std::string FindDirectoryUnderRoot(
    const std::vector<FileEntry>& files,
    const std::string& rootDir,
    const std::string& dirName
) {
    if (dirName.empty()) return "";
    const std::string needle = "/" + dirName + "/";
    const size_t dirPathLen = 1 + dirName.size();
    for (const auto& entry : files) {
        if (entry.path.size() < rootDir.size() + needle.size()) continue;
        if (entry.path.compare(0, rootDir.size(), rootDir) != 0) continue;
        size_t pos = entry.path.find(needle, rootDir.size());
        if (pos != std::string::npos) {
            return entry.path.substr(0, pos + dirPathLen);
        }
    }
    return "";
}

std::vector<LexiconCandidate> FindLexiconCandidates(
    const std::vector<FileEntry>& files,
    const std::string& rootDir
) {
    std::vector<LexiconCandidate> candidates;
    const size_t rootLen = rootDir.size();
    for (const auto& entry : files) {
        if (entry.path.size() <= rootLen) continue;
        if (rootLen > 0) {
            if (entry.path.compare(0, rootLen, rootDir) != 0) continue;
            // Enforce path boundary: if rootDir doesn't end with '/', require '/' after it
            if (rootDir.back() != '/' && entry.path[rootLen] != '/') continue;
        }
        std::string base = BaseName(entry.path);
        if (base.empty()) continue;
        std::string baseLower = ToLower(base);
        if (baseLower == "lexicon.txt") {
            candidates.push_back({entry.path, "default"});
        } else if (baseLower.size() > 12 &&
                   baseLower.compare(0, 8, "lexicon-") == 0 &&
                   baseLower.compare(baseLower.size() - 4, 4, ".txt") == 0) {
            std::string languageId = baseLower.substr(8, baseLower.size() - 12);
            candidates.push_back({entry.path, languageId});
        }
    }
    std::sort(candidates.begin(), candidates.end(), [](const LexiconCandidate& a, const LexiconCandidate& b) {
        if (a.languageId == b.languageId) return a.path < b.path;
        if (a.languageId == "default") return true;
        if (b.languageId == "default") return false;
        return a.languageId < b.languageId;
    });
    return candidates;
}

} // namespace model_detect
} // namespace sherpaonnx
