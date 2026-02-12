#include "sherpa-onnx-model-detect-helper.h"

#include <algorithm>
#include <cctype>

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

} // namespace model_detect
} // namespace sherpaonnx
