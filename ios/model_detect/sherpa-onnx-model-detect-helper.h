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
    std::string nameLower;
    std::uint64_t size = 0;
};

bool FileExists(const std::string& path);
bool IsDirectory(const std::string& path);
std::vector<std::string> ListDirectories(const std::string& path);
std::vector<FileEntry> ListFiles(const std::string& path);
std::vector<FileEntry> ListFilesRecursive(const std::string& path, int maxDepth);
std::string ToLower(std::string value);
std::string ResolveTokenizerDir(const std::string& modelDir);

std::string FindFileByName(const std::string& baseDir, const std::string& fileName, int maxDepth);
/** Find file whose name equals or ends with suffix (e.g. tokens.txt, tiny-tokens.txt) in a pre-built file list. */
std::string FindFileEndingWith(const std::vector<FileEntry>& files, const std::string& suffix);
std::string FindDirectoryByName(const std::string& baseDir, const std::string& dirName, int maxDepth);

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
std::string FindLargestOnnxExcludingTokens(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens
);

/** Returns true if \p word appears in \p haystack as a standalone token (surrounded by separators: / - _ . space). */
bool ContainsWord(const std::string& haystack, const std::string& word);

} // namespace model_detect
} // namespace sherpaonnx

#endif // SHERPA_ONNX_MODEL_DETECT_HELPER_H
