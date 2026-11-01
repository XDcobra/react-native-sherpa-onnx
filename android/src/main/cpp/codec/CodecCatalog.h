#pragma once

#include <mutex>
#include <string>
#include <vector>

#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

class CodecCatalog {
 public:
  CodecCatalog() = default;
  static CodecCatalog& Instance();

  void Clear();
  void Register(Provider p);
  void SetRank(const std::string& name, int rank);

  std::vector<const Provider*> Find(Media media, Direction dir,
                                    const std::string& codec) const;
  std::vector<Provider> All() const;

  /** Test helper: replace the singleton contents. */
  void ReplaceAll(std::vector<Provider> providers);

 private:
  mutable std::mutex mu_;
  std::vector<Provider> providers_;
};

}  // namespace codec
}  // namespace sherpa_onnx
