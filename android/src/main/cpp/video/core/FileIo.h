#pragma once

#include <cstdint>
#include <string>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct FsSpace {
  int64_t availableBytes = 0;
  int64_t totalBytes = 0;
};

/** Injectable POSIX-ish IO so tests can inject ENOSPC / EIO. */
class FileIo {
 public:
  virtual ~FileIo() = default;
  virtual int Open(const char* path, int flags, int mode) = 0;
  virtual int Close(int fd) = 0;
  virtual int64_t Pread(int fd, void* buf, size_t n, int64_t offset) = 0;
  virtual int64_t Pwrite(int fd, const void* buf, size_t n, int64_t offset) = 0;
  virtual int Fsync(int fd) = 0;
  virtual int Ftruncate(int fd, int64_t length) = 0;
  virtual Status StatVfs(const char* path, FsSpace* out) = 0;
  virtual int Unlink(const char* path) = 0;
};

class PosixFileIo : public FileIo {
 public:
  int Open(const char* path, int flags, int mode) override;
  int Close(int fd) override;
  int64_t Pread(int fd, void* buf, size_t n, int64_t offset) override;
  int64_t Pwrite(int fd, const void* buf, size_t n, int64_t offset) override;
  int Fsync(int fd) override;
  int Ftruncate(int fd, int64_t length) override;
  Status StatVfs(const char* path, FsSpace* out) override;
  int Unlink(const char* path) override;
};

FileIo& DefaultFileIo();
void SetDefaultFileIoForTest(FileIo* io);  // nullptr restores PosixFileIo

}  // namespace video
}  // namespace sherpa_onnx
