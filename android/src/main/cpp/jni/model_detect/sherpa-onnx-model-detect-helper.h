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

/** Find file in \p files whose name equals \p fileName (case-insensitive). Uses file tree only, no filesystem. */
std::string FindFileByName(const std::vector<FileEntry>& files, const std::string& fileName);
/** Find file in \p files whose name equals or ends with \p suffix (e.g. tokens.txt). Case-insensitive. */
std::string FindFileEndingWith(const std::vector<FileEntry>& files, const std::string& suffix);

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

/** Like FindOnnxByAnyToken but skips any file whose nameLower contains any of \p excludeInName. */
std::string FindOnnxByAnyTokenExcluding(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& tokens,
    const std::vector<std::string>& excludeInName,
    const std::optional<bool>& preferInt8
);

std::string FindLargestOnnx(
    const std::vector<FileEntry>& files
);

std::string FindLargestOnnxExcludingTokens(
    const std::vector<FileEntry>& files,
    const std::vector<std::string>& excludeTokens
);

/** Returns true if \p word appears in \p haystack as a standalone token (surrounded by separators: / - _ . space). */
bool ContainsWord(const std::string& haystack, const std::string& word);

/**
 * Find a directory with the given name anywhere under \p rootDir in the file tree.
 * Searches \p files for any path that starts with \p rootDir and contains "/dirName/".
 * Returns the full path to that directory (e.g. rootDir/inner/dirName) or empty if not found.
 * Used e.g. to find espeak-ng-data in modelDir or in modelDir/inner-model-dir/.
 */
std::string FindDirectoryUnderRoot(
    const std::vector<FileEntry>& files,
    const std::string& rootDir,
    const std::string& dirName
);

} // namespace model_detect
} // namespace sherpaonnx

#endif // SHERPA_ONNX_MODEL_DETECT_HELPER_H
