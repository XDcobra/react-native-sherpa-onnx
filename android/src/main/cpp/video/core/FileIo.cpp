#include "core/FileIo.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(_WIN32)
#include <sys/statvfs.h>
#endif

namespace sherpa_onnx {
namespace video {
namespace {

PosixFileIo g_posix;
FileIo* g_override = nullptr;

}  // namespace

int PosixFileIo::Open(const char* path, int flags, int mode) {
  return ::open(path, flags, mode);
}

int PosixFileIo::Close(int fd) { return ::close(fd); }

int64_t PosixFileIo::Pread(int fd, void* buf, size_t n, int64_t offset) {
  const ssize_t got = ::pread(fd, buf, n, static_cast<off_t>(offset));
  return static_cast<int64_t>(got);
}

int64_t PosixFileIo::Pwrite(int fd, const void* buf, size_t n, int64_t offset) {
  const ssize_t put = ::pwrite(fd, buf, n, static_cast<off_t>(offset));
  return static_cast<int64_t>(put);
}

int PosixFileIo::Fsync(int fd) { return ::fsync(fd); }

int PosixFileIo::Ftruncate(int fd, int64_t length) {
  return ::ftruncate(fd, static_cast<off_t>(length));
}

Status PosixFileIo::StatVfs(const char* path, FsSpace* out) {
  if (path == nullptr || out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "StatVfs null");
  }
#if defined(_WIN32)
  (void)path;
  out->availableBytes = INT64_MAX;
  out->totalBytes = INT64_MAX;
  return Status::Ok();
#else
  struct statvfs st {};
  if (::statvfs(path, &st) != 0) {
    return Status::Fail(kErrSpoolIo, std::string("statvfs: ") + std::strerror(errno));
  }
  const int64_t frsize = static_cast<int64_t>(st.f_frsize);
  out->availableBytes = frsize * static_cast<int64_t>(st.f_bavail);
  out->totalBytes = frsize * static_cast<int64_t>(st.f_blocks);
  return Status::Ok();
#endif
}

int PosixFileIo::Unlink(const char* path) { return ::unlink(path); }

FileIo& DefaultFileIo() {
  return g_override != nullptr ? *g_override : g_posix;
}

void SetDefaultFileIoForTest(FileIo* io) { g_override = io; }

}  // namespace video
}  // namespace sherpa_onnx
