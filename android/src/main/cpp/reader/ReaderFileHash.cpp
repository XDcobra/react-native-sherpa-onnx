#include "ReaderFileHash.h"

#include "../crypto/sha256.h"

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <vector>

namespace sherpa_onnx {
namespace reader {

bool Sha256HexOfSource(const fileio::SeekableSource& src, std::string* hex, std::string* error) {
  int fd = src.fd;
  bool own = false;
  if (!src.path.empty()) {
    fd = ::open(src.path.c_str(), O_RDONLY);
    own = true;
  }
  if (fd < 0) {
    if (error) *error = std::string("cannot open source: ") + std::strerror(errno);
    return false;
  }
  crypto::Sha256Context ctx;
  crypto::sha256_init(&ctx);
  std::vector<uint8_t> buf(1 << 16);
  off_t offset = 0;
  bool ok = true;
  for (;;) {
    const ssize_t n = ::pread(fd, buf.data(), buf.size(), offset);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (error) *error = std::string("read failed: ") + std::strerror(errno);
      ok = false;
      break;
    }
    if (n == 0) break;
    crypto::sha256_update(&ctx, buf.data(), static_cast<size_t>(n));
    offset += n;
  }
  if (own) ::close(fd);
  if (!ok) return false;
  uint8_t digest[32];
  crypto::sha256_final(&ctx, digest);
  static const char* kHex = "0123456789abcdef";
  hex->clear();
  hex->reserve(64);
  for (uint8_t b : digest) {
    hex->push_back(kHex[b >> 4]);
    hex->push_back(kHex[b & 0xF]);
  }
  return true;
}

}  // namespace reader
}  // namespace sherpa_onnx
