#pragma once

#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

class CodecRuntime {
 public:
  static CodecRuntime& Instance();

  void Init(int64_t totalRamBytes);
  Status Configure(const PolicyConfig& incoming,
                   const std::vector<std::pair<ResourceClass, int>>& budgets,
                   bool replaceAllPolicies);

  /** Null / empty policy strings are left unchanged. Budget 0 = omit. */
  Status ConfigureFromNative(const char* videoDecode, const char* videoDisplay,
                             const char* videoEncode, const char* imageDecode,
                             const int budgets[6]);

  PolicyConfig policies() const;
  Policy GlobalVideo(Use use) const;
  Policy GlobalImage() const;
  Policy ResolveVideo(Use use, std::optional<Policy> operation,
                      std::optional<Policy> buffer) const;
  Policy ResolveImage(std::optional<Policy> operation,
                      std::optional<Policy> buffer) const;

  std::string InfoJson() const;
  void ResetForTest();

 private:
  CodecRuntime() = default;
  mutable std::mutex mu_;
  PolicyConfig policies_{};
  bool inited_ = false;
};

}  // namespace codec
}  // namespace sherpa_onnx
