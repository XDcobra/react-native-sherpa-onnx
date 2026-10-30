#include "OcrTable.h"

#include <algorithm>
#include <sstream>

namespace sherpa_onnx {
namespace ocr {
namespace {

std::string EscapeMdCell(const std::string& cell) {
  std::string out;
  out.reserve(cell.size());
  for (char c : cell) {
    if (c == '|')
      out += "\\|";
    else if (c == '\n' || c == '\r')
      out.push_back(' ');
    else
      out.push_back(c);
  }
  return out;
}

std::string TrimCopy(const std::string& s) {
  size_t a = 0;
  while (a < s.size() && (s[a] == ' ' || s[a] == '\t')) ++a;
  size_t b = s.size();
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r')) --b;
  return s.substr(a, b - a);
}

bool IsSeparatorRow(const std::vector<std::string>& cells) {
  if (cells.empty()) return false;
  for (const auto& cell : cells) {
    if (cell.empty()) return false;
    for (char c : cell) {
      if (c != '-' && c != ':' && c != ' ') return false;
    }
  }
  return true;
}

std::vector<std::string> SplitPipes(const std::string& line) {
  std::string body = TrimCopy(line);
  if (body.empty()) return {};
  if (!body.empty() && body.front() == '|') body.erase(body.begin());
  if (!body.empty() && body.back() == '|') body.pop_back();
  std::vector<std::string> cells;
  std::string cur;
  for (size_t i = 0; i < body.size(); ++i) {
    if (body[i] == '|' && (i == 0 || body[i - 1] != '\\')) {
      cells.push_back(TrimCopy(cur));
      cur.clear();
    } else {
      cur.push_back(body[i]);
    }
  }
  cells.push_back(TrimCopy(cur));
  return cells;
}

}  // namespace

std::string OcrTable::RenderGfm() const {
  size_t cols = 0;
  for (const auto& row : rows) cols = std::max(cols, row.size());
  if (cols == 0 || rows.empty()) return "";

  auto emit_row = [&](const std::vector<OcrTableCell>& row) {
    std::string out = "|";
    for (size_t c = 0; c < cols; ++c) {
      out += " ";
      out += c < row.size() ? EscapeMdCell(row[c].text) : "";
      out += " |";
    }
    return out;
  };

  std::string md = emit_row(rows[0]);
  md += "\n|";
  for (size_t c = 0; c < cols; ++c) md += " --- |";
  for (size_t r = 1; r < rows.size(); ++r) {
    md += "\n";
    md += emit_row(rows[r]);
  }
  return md;
}

std::string OcrTable::RenderPlain() const {
  std::string text;
  for (size_t r = 0; r < rows.size(); ++r) {
    if (r > 0) text += "\n";
    for (size_t c = 0; c < rows[r].size(); ++c) {
      if (c > 0) text += " | ";
      text += rows[r][c].text;
    }
  }
  return text;
}

OcrTable ParseGfmPipes(const std::string& text) {
  OcrTable table;
  std::istringstream in(text);
  std::string line;
  bool skipped_sep = false;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    // Strip a trailing EOS the goldens sometimes keep in the raw stream.
    if (line.size() >= 4 && line.compare(line.size() - 4, 4, "</s>") == 0) {
      line.resize(line.size() - 4);
    }
    const auto cells = SplitPipes(line);
    if (cells.empty()) continue;
    if (!skipped_sep && !table.rows.empty() && IsSeparatorRow(cells)) {
      skipped_sep = true;
      continue;
    }
    std::vector<OcrTableCell> row;
    row.reserve(cells.size());
    for (const auto& cell : cells) {
      OcrTableCell parsed;
      parsed.text = cell;
      row.push_back(std::move(parsed));
    }
    table.rows.push_back(std::move(row));
  }
  return table;
}

}  // namespace ocr
}  // namespace sherpa_onnx
