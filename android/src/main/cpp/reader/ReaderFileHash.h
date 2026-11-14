#pragma once

#include "../fileio/SeekableSource.h"

#include <string>

namespace sherpa_onnx {
namespace reader {

/**
 * Lowercase hex SHA-256 of a file (documentKey). Reads `src.path`, or `src.fd`
 * with pread when the path is empty (the caller keeps ownership of the fd).
 */
bool Sha256HexOfSource(const fileio::SeekableSource& src, std::string* hex, std::string* error);

}  // namespace reader
}  // namespace sherpa_onnx
