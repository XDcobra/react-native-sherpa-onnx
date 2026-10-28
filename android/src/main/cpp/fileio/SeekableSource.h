#pragma once

#include <string>
#include <utility>

namespace sherpa_onnx {
namespace fileio {

/**
 * Seekable FileSource for document/ and pdf/: filesystem path or borrowed fd.
 * Native never closes the caller's original fd.
 */
struct SeekableSource {
  std::string path;
  int fd = -1;
};

inline SeekableSource MakeSeekableSource(std::string path, int fd) {
  SeekableSource src;
  src.path = std::move(path);
  src.fd = fd;
  return src;
}

}  // namespace fileio
}  // namespace sherpa_onnx
