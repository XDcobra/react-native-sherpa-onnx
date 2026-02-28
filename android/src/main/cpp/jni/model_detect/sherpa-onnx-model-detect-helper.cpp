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

bool IsOnnxFile(const FileEntry& entry) {
    return EndsWith(entry.nameLower, ".onnx");
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
        if (!IsOnnxFile(entry)) continue;

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

std::string FindFileByName(const std::string& baseDir, const std::string& fileName, int maxDepth) {
    std::string target = ToLower(fileName);
    auto files = ListFilesRecursive(baseDir, maxDepth);
    for (const auto& entry : files) {
        if (entry.nameLower == target) {
            return entry.path;
        }
    }
    return "";
}

std::string FindFileEndingWith(const std::string& baseDir, const std::string& suffix, int maxDepth) {
    std::string targetSuffix = ToLower(suffix);
    auto files = ListFilesRecursive(baseDir, maxDepth);
    // 1) exact match (e.g. "tokens.txt")
    for (const auto& entry : files) {
        if (entry.nameLower == targetSuffix) {
            return entry.path;
        }
    }

    // 2) true suffix match (preferred over substring to avoid false positives
    //    like "tokens.txt.bak" or "mytokens.txt.tmp").
    for (const auto& entry : files) {
        if (EndsWith(entry.nameLower, targetSuffix)) {
            return entry.path;
        }
    }

    // 3) If we are looking for tokens, fallback to inspecting .txt files' contents.
    //    Heuristic: many token files are plain text with lines like "token <index>".
    if (targetSuffix.find("tokens") != std::string::npos) {
        auto IsLikelyTokensFile = [](const std::string& path) -> bool {
            std::ifstream ifs(path);
            if (!ifs.is_open()) return false;
            std::string line;
            int total = 0;
            int matched = 0;
            const int maxLines = 2000;

            while (total < maxLines && std::getline(ifs, line)) {
                ++total;
                if (line.empty()) continue;
                // Trim trailing CR if present
                if (!line.empty() && line.back() == '\r') line.pop_back();

                // Check if the line ends with an integer index (common token format)
                size_t sp = line.find_last_of(" \t");
                if (sp != std::string::npos && sp + 1 < line.size()) {
                    std::string idx = line.substr(sp + 1);
                    bool allDigits = !idx.empty();
                    for (char c : idx) {
                        if (!std::isdigit(static_cast<unsigned char>(c))) { allDigits = false; break; }
                    }
                    if (allDigits) ++matched;
                }
            }

            ifs.close();
            if (total < 2) return false;
            // Heuristic: at least half of non-empty lines should match the token pattern
            return matched >= std::max(1, total / 2);
        };

        for (const auto& entry : files) {
            if (EndsWith(entry.nameLower, ".txt")) {
                if (IsLikelyTokensFile(entry.path)) {
                    return entry.path;
                }
            }
        }
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
            std::string name = dir;
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            try {
                name = fs::path(dir).filename().string();
            } catch (const std::exception&) {
            }
#elif __has_include(<experimental/filesystem>)
            try {
                name = fs::path(dir).filename().string();
            } catch (const std::exception&) {
            }
#else
            name = BaseName(dir);
#endif
            if (ToLower(name) == target) {
                return dir;
            }
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

    std::vector<std::string> toVisit = ListDirectories(modelDir);
    int depth = 0;
    while (!toVisit.empty() && depth <= 2) {
        std::vector<std::string> next;
        for (const auto& dir : toVisit) {
            std::string dirName = dir;
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            try {
                dirName = fs::path(dir).filename().string();
            } catch (const std::exception&) {
            }
#elif __has_include(<experimental/filesystem>)
            try {
                dirName = fs::path(dir).filename().string();
            } catch (const std::exception&) {
            }
#else
            dirName = BaseName(dir);
#endif
            std::string dirNameLower = ToLower(dirName);
            if (dirNameLower.find("qwen3") != std::string::npos) {
                std::string vocabPath = dir + "/vocab.json";
                if (FileExists(vocabPath)) {
                    return dir;
                }
            }

            if (depth < 2) {
                auto nested = ListDirectories(dir);
                next.insert(next.end(), nested.begin(), nested.end());
            }
        }
        toVisit.swap(next);
        depth += 1;
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
        if (!IsOnnxFile(entry)) continue;
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

} // namespace model_detect
} // namespace sherpaonnx
