#include "core/FileIo.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#include <vector>

#include <gtest/gtest.h>

using sherpa_onnx::video::DefaultFileIo;
using sherpa_onnx::video::FileIo;
using sherpa_onnx::video::FsSpace;
using sherpa_onnx::video::PosixFileIo;
using sherpa_onnx::video::SetDefaultFileIoForTest;
using sherpa_onnx::video::Status;
using sherpa_onnx::video::kErrSpoolIo;

namespace {

class EnospcFileIo : public PosixFileIo {
 public:
  int64_t Pwrite(int fd, const void* buf, size_t n, int64_t offset) override {
    (void)fd;
    (void)buf;
    (void)n;
    (void)offset;
    errno = ENOSPC;
    return -1;
  }
  Status StatVfs(const char* path, FsSpace* out) override {
    (void)path;
    if (out != nullptr) {
      out->availableBytes = 0;
      out->totalBytes = 1;
    }
    return Status::Fail(kErrSpoolIo, "ENOSPC injected");
  }
};

}  // namespace

TEST(FileIo, RoundTripPwritePread) {
  char tmpl[] = "/tmp/vid_fileio_XXXXXX";
  int fd = mkstemp(tmpl);
  ASSERT_GE(fd, 0);
  std::vector<uint8_t> src(256);
  for (size_t i = 0; i < src.size(); ++i) {
    src[i] = static_cast<uint8_t>(i);
  }
  auto& io = DefaultFileIo();
  ASSERT_EQ(io.Pwrite(fd, src.data(), src.size(), 0),
            static_cast<int64_t>(src.size()));
  ASSERT_EQ(io.Fsync(fd), 0);
  std::vector<uint8_t> dst(src.size());
  ASSERT_EQ(io.Pread(fd, dst.data(), dst.size(), 0),
            static_cast<int64_t>(dst.size()));
  EXPECT_EQ(src, dst);
  io.Close(fd);
  io.Unlink(tmpl);
}

TEST(FileIo, InjectEnospc) {
  EnospcFileIo fake;
  SetDefaultFileIoForTest(&fake);
  errno = 0;
  EXPECT_EQ(DefaultFileIo().Pwrite(3, "x", 1, 0), -1);
  EXPECT_EQ(errno, ENOSPC);
  FsSpace space;
  auto st = DefaultFileIo().StatVfs("/", &space);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrSpoolIo);
  SetDefaultFileIoForTest(nullptr);
}
