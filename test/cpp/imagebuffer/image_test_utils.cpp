#include "image_test_utils.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <vector>

#include <sys/stat.h>
#include <utime.h>

namespace sherpa_onnx {
namespace image {
namespace testutil {

namespace fs = std::filesystem;

std::string FixturePath(const char* name) {
  return std::string("test/fixtures/imagebuffer/") + name;
}

std::string MakeTempCacheDir(const char* prefix) {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::ostringstream oss;
  oss << fs::temp_directory_path().string() << "/" << prefix << "_"
      << std::hex << rng();
  const std::string path = oss.str();
  fs::create_directories(path);
  return path;
}

void RemoveDirRecursive(const std::string& path) {
  std::error_code ec;
  fs::remove_all(path, ec);
}

RgbFrame MakeSolidRgb(int width, int height, uint8_t r, uint8_t g, uint8_t b) {
  RgbFrame frame;
  frame.width = width;
  frame.height = height;
  frame.rgb.assign(static_cast<size_t>(width) * static_cast<size_t>(height) * 3u, 0);
  for (size_t i = 0; i < frame.rgb.size(); i += 3) {
    frame.rgb[i] = r;
    frame.rgb[i + 1] = g;
    frame.rgb[i + 2] = b;
  }
  return frame;
}

std::vector<uint8_t> ReadFileBytes(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(in),
                              std::istreambuf_iterator<char>());
}

bool FileExists(const std::string& path) {
  std::error_code ec;
  return fs::is_regular_file(path, ec);
}

bool SetFileAgeMs(const std::string& path, int64_t ageMs) {
  const auto now = std::chrono::system_clock::now();
  const auto mtime = now - std::chrono::milliseconds(ageMs);
  const std::time_t t = std::chrono::system_clock::to_time_t(mtime);
  struct utimbuf times {};
  times.actime = t;
  times.modtime = t;
  return ::utime(path.c_str(), &times) == 0;
}

}  // namespace testutil
}  // namespace image
}  // namespace sherpa_onnx
