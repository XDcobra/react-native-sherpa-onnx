#include "OcrOtsl.h"

namespace sherpa_onnx {
namespace ocr {
namespace {

bool IsNameChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '_';
}

}  // namespace

OcrTable ParseOtsl(const std::string& raw) {
  OcrTable table;
  std::vector<OcrTableCell> row;
  auto flush_row = [&]() {
    if (row.empty()) return;
    table.rows.push_back(row);
    row.clear();
  };

  for (size_t i = 0; i < raw.size();) {
    if (raw[i] != '<') {
      ++i;
      continue;
    }
    const size_t gt = raw.find('>', i + 1);
    if (gt == std::string::npos) break;
    std::string tag = raw.substr(i + 1, gt - (i + 1));
    bool closing = false;
    if (!tag.empty() && tag[0] == '/') {
      closing = true;
      tag.erase(tag.begin());
    }
    i = gt + 1;
    if (tag == "otsl" || closing) continue;
    if (!IsOtslCellToken(tag)) continue;
    if (tag == "nl" || tag == "srow") {
      flush_row();
      continue;
    }
    if (tag == "ecel") {
      row.emplace_back();
      continue;
    }
    if (!IsOtslContentCell(tag)) continue;

    size_t j = i;
    while (j < raw.size()) {
      if (raw[j] != '<') {
        ++j;
        continue;
      }
      const size_t ngt = raw.find('>', j + 1);
      if (ngt == std::string::npos) {
        j = raw.size();
        break;
      }
      std::string next = raw.substr(j + 1, ngt - (j + 1));
      if (!next.empty() && next[0] == '/') next.erase(next.begin());
      size_t k = 0;
      while (k < next.size() && IsNameChar(next[k])) ++k;
      next = next.substr(0, k);
      if (IsOtslCellToken(next) || next == "otsl" || next == "caption") break;
      j = ngt + 1;
    }
    OcrTableCell cell;
    cell.text = raw.substr(i, j - i);
    row.push_back(std::move(cell));
    i = j;
  }
  flush_row();
  return table;
}

}  // namespace ocr
}  // namespace sherpa_onnx
