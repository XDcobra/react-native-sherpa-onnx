/**
 * Incremental DocTags prefix acceptor for greedy decode.
 * Not a document walk — well-formed prefix + stack. OTSL cells are void
 * (unclosed `fcel` / `nl` / …); `</otsl>` / `</table>` pop leftovers.
 */
#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

enum class DocTagsPrefixKind { kPage, kElement };

class DocTagsPrefix {
 public:
  explicit DocTagsPrefix(DocTagsPrefixKind kind = DocTagsPrefixKind::kPage)
      : kind_(kind) {}
  /** Commit `piece` if the accumulated string stays a legal prefix. */
  bool Feed(std::string_view piece);
  bool closed_doctag() const { return closed_; }

 private:
  bool ConsumeAvailable();
  bool ApplyText(std::string_view text);
  bool ApplyOpen(const std::string& name);
  bool ApplyClose(const std::string& name);
  bool ApplyLoc();

  DocTagsPrefixKind kind_ = DocTagsPrefixKind::kPage;
  std::string pending_;
  std::vector<std::string> stack_;
  bool seen_doctag_ = false;
  bool closed_ = false;
};

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
