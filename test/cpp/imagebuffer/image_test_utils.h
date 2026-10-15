#pragma once

#include "ImageTypes.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace image {
namespace testutil {

/** Absolute path to test/fixtures/imagebuffer/<name> (cwd = repo root). */
std::string FixturePath(const char* name);

/** Unique temp directory for SetCacheDir; caller should remove when done. */
std::string MakeTempCacheDir(const char* prefix);

void RemoveDirRecursive(const std::string& path);

/** Solid RGB8 frame (row-major). */
RgbFrame MakeSolidRgb(int width, int height, uint8_t r, uint8_t g, uint8_t b);

/** Read entire file into memory. */
std::vector<uint8_t> ReadFileBytes(const std::string& path);

/** True if path exists as a regular file. */
bool FileExists(const std::string& path);

/** Touch mtime of path to now - ageMs. */
bool SetFileAgeMs(const std::string& path, int64_t ageMs);

}  // namespace testutil
}  // namespace image
}  // namespace sherpa_onnx
