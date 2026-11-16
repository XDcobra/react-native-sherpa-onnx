#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

/**
 * An archive kept open beyond one call, for images decoded on demand. Owns a
 * duplicate of a borrowed fd, so the caller may close its own; reads are
 * serialized. Shared by the loaders of a lazy image buffer.
 */
class SharedArchive {
 public:
  static std::shared_ptr<SharedArchive> Open(const DocumentSource& src, std::string* err_code,
                                             std::string* err_message);
  ~SharedArchive();
  SharedArchive(const SharedArchive&) = delete;
  SharedArchive& operator=(const SharedArchive&) = delete;

  /** The reader; use only before handing out loaders (not synchronized). */
  ArchiveReader& reader() { return ar_; }

  bool Read(const std::string& name, std::vector<uint8_t>* out, std::string* err_code,
            std::string* err_message);

 private:
  SharedArchive() = default;
  int owned_fd_ = -1;
  std::mutex mu_;
  ArchiveReader ar_;
};

}  // namespace document
}  // namespace sherpa_onnx
