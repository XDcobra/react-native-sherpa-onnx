#ifndef SHERPA_ONNX_MODEL_DETECT_HELPER_H
#define SHERPA_ONNX_MODEL_DETECT_HELPER_H

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {
namespace model_detect {

struct FileEntry {
    std::string path;
    std::string name;
    std::string nameLower;
    std::uint64_t size = 0;
};

bool FileExists(const std::string& path);
bool IsDirectory(const std::string& path);
std::vector<std::string> ListDirectories(const std::string& path);
std::vector<FileEntry> ListFiles(const std::string& path);
std::vector<FileEntry> ListFilesRecursive(const std::string& path, int maxDepth = 2);
std::string ToLower(std::string value);
std::string ResolveTokenizerDir(const std::string& modelDir);

std::string FindFileByName(const std::string& baseDir, const std::string& fileName, int maxDepth = 2);
std::string FindFileEndingWith(const std::string& baseDir, const std::string& suffix, int maxDepth = 2);
std::string FindDirectoryByName(const std::string& baseDir, const std::string& dirName, int maxDepth = 2);

std::string FindOnnxByToken(
    const std::vector<FileEntry>& files,
    const std::string& token,
    const std::optional<bool>& preferInt8
);

std::string FindOnnxByAnyToken(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& tokens,
    const std::optional<bool>& preferInt8
);

std::string FindLargestOnnx(
    const std::vector<FileEntry>& files
);

std::string FindLargestOnnxExcludingTokens(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens
);

} // namespace model_detect
} // namespace sherpaonnx

#endif // SHERPA_ONNX_MODEL_DETECT_HELPER_H
