/**
 * Incremental DocTags prefix acceptor for greedy decode.
 * Not a document walk — only well-formed prefix + stack.
 */
#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

class DocTagsPrefix {
 public:
  /** Commit `piece` if the accumulated string stays a legal prefix. */
  bool Feed(std::string_view piece);
  bool closed_doctag() const { return closed_; }

 private:
  bool ConsumeAvailable();
  bool ApplyText(std::string_view text);
  bool ApplyOpen(const std::string& name);
  bool ApplyClose(const std::string& name);
  bool ApplyLoc();

  std::string pending_;
  std::vector<std::string> stack_;
  bool seen_doctag_ = false;
  bool closed_ = false;
};

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
