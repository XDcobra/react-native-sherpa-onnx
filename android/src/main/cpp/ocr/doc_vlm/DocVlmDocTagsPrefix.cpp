#include "DocVlmDocTagsPrefix.h"

#include <cctype>
#include <string_view>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

bool IsNameChar(char c) {
  return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_';
}

bool IsAsciiWs(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool OnlyAsciiWs(std::string_view text) {
  for (char c : text) {
    if (!IsAsciiWs(c)) return false;
  }
  return true;
}

bool IsLocName(const std::string& name) {
  if (name.size() <= 4 || name.compare(0, 4, "loc_") != 0) return false;
  for (size_t i = 4; i < name.size(); ++i) {
    if (!std::isdigit(static_cast<unsigned char>(name[i]))) return false;
  }
  return true;
}

bool IsRowColName(std::string_view name) {
  if (name.size() < 9 || name.compare(0, 4, "row_") != 0) return false;
  size_t i = 4;
  if (i >= name.size() || std::isdigit(static_cast<unsigned char>(name[i])) == 0) {
    return false;
  }
  while (i < name.size() && std::isdigit(static_cast<unsigned char>(name[i])) != 0) {
    ++i;
  }
  if (name.size() < i + 5 || name.compare(i, 5, "_col_") != 0) return false;
  i += 5;
  if (i >= name.size() || std::isdigit(static_cast<unsigned char>(name[i])) == 0) {
    return false;
  }
  while (i < name.size() && std::isdigit(static_cast<unsigned char>(name[i])) != 0) {
    ++i;
  }
  return i == name.size();
}

bool IsPromptOnlyInner(std::string_view inner) {
  if (!inner.empty() && inner[0] == '/') inner.remove_prefix(1);
  return inner == "image" || inner == "fake_token_around_image" ||
         inner == "global-img" || inner == "|start_of_role|" ||
         inner == "|end_of_role|" || IsRowColName(inner);
}

}  // namespace

bool DocTagsPrefix::Feed(std::string_view piece) {
  if (piece.empty()) return true;
  DocTagsPrefix next = *this;
  next.pending_.append(piece.data(), piece.size());
  if (!next.ConsumeAvailable()) return false;
  *this = std::move(next);
  return true;
}

bool DocTagsPrefix::ConsumeAvailable() {
  while (!pending_.empty()) {
    if (pending_[0] != '<') {
      size_t n = 0;
      while (n < pending_.size() && pending_[n] != '<') ++n;
      if (!ApplyText(std::string_view(pending_.data(), n))) return false;
      pending_.erase(0, n);
      continue;
    }
    const size_t gt = pending_.find('>', 1);
    if (gt == std::string::npos) return true;
    if (IsPromptOnlyInner(std::string_view(pending_.data() + 1, gt - 1))) {
      return false;
    }
    const bool closing = pending_.size() > 1 && pending_[1] == '/';
    size_t name_begin = 1 + (closing ? 1u : 0u);
    size_t name_end = name_begin;
    while (name_end < gt && IsNameChar(pending_[name_end])) ++name_end;
    if (name_end == name_begin || name_end != gt) {
      if (!ApplyText("<")) return false;
      pending_.erase(0, 1);
      continue;
    }
    const std::string name = pending_.substr(name_begin, name_end - name_begin);
    pending_.erase(0, gt + 1);
    if (closing) {
      if (!ApplyClose(name)) return false;
    } else if (IsLocName(name)) {
      if (!ApplyLoc()) return false;
    } else {
      if (!ApplyOpen(name)) return false;
    }
  }
  return true;
}

bool DocTagsPrefix::ApplyText(std::string_view text) {
  if (text.empty()) return true;
  if (OnlyAsciiWs(text)) return true;
  if (closed_) return false;
  if (!seen_doctag_) return false;
  return !stack_.empty();
}

bool DocTagsPrefix::ApplyOpen(const std::string& name) {
  if (closed_) return false;
  if (!seen_doctag_) {
    if (name != "doctag") return false;
    seen_doctag_ = true;
    stack_.push_back(name);
    return true;
  }
  stack_.push_back(name);
  return true;
}

bool DocTagsPrefix::ApplyClose(const std::string& name) {
  if (closed_ || !seen_doctag_ || stack_.empty()) return false;
  if (name == "doctag") {
    closed_ = true;
    stack_.clear();
    return true;
  }
  if (stack_.back() != name) return false;
  stack_.pop_back();
  return true;
}

bool DocTagsPrefix::ApplyLoc() {
  if (closed_ || !seen_doctag_ || stack_.empty()) return false;
  return true;
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
