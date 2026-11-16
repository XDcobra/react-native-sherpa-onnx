#include "DocArchiveSource.h"

#include <unistd.h>

namespace sherpa_onnx {
namespace document {

std::shared_ptr<SharedArchive> SharedArchive::Open(const DocumentSource& src,
                                                   std::string* err_code,
                                                   std::string* err_message) {
  std::shared_ptr<SharedArchive> out(new SharedArchive());
  DocumentSource own = src;
  if (src.fd >= 0) {
    // A borrowed fd (and any path derived from it) goes away after the call.
    out->owned_fd_ = ::dup(src.fd);
    if (out->owned_fd_ < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Failed to duplicate the archive file descriptor";
      return nullptr;
    }
    own.path.clear();
    own.fd = out->owned_fd_;
  }
  if (!ArchiveReader::Open(own, &out->ar_, err_code, err_message)) return nullptr;
  return out;
}

SharedArchive::~SharedArchive() {
  // ArchiveReader keeps no archive open between reads; the fd is free to close.
  if (owned_fd_ >= 0) ::close(owned_fd_);
}

bool SharedArchive::Read(const std::string& name, std::vector<uint8_t>* out,
                         std::string* err_code, std::string* err_message) {
  std::lock_guard<std::mutex> lock(mu_);
  return ar_.ReadNamed(name, out, err_code, err_message);
}

}  // namespace document
}  // namespace sherpa_onnx
