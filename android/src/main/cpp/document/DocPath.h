#pragma once

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

inline std::string DirnameOf(const std::string& path) {
  const auto slash = path.find_last_of('/');
  if (slash == std::string::npos) return {};
  return path.substr(0, slash);
}

inline std::string JoinHref(const std::string& base_dir, const std::string& href) {
  std::string h = href;
  const auto hash = h.find('#');
  if (hash != std::string::npos) h = h.substr(0, hash);
  const auto q = h.find('?');
  if (q != std::string::npos) h = h.substr(0, q);
  if (h.empty()) return {};
  if (h.find("://") != std::string::npos) return {};  // remote
  if (!h.empty() && h[0] == '/') h.erase(0, 1);

  std::string combined = base_dir.empty() ? h : (base_dir + "/" + h);
  std::replace(combined.begin(), combined.end(), '\\', '/');

  std::vector<std::string> parts;
  std::string cur;
  for (size_t i = 0; i <= combined.size(); ++i) {
    if (i == combined.size() || combined[i] == '/') {
      if (cur.empty() || cur == ".") {
        cur.clear();
        continue;
      }
      if (cur == "..") {
        if (!parts.empty()) parts.pop_back();
      } else {
        parts.push_back(cur);
      }
      cur.clear();
    } else {
      cur.push_back(combined[i]);
    }
  }
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i) out += '/';
    out += parts[i];
  }
  return out;
}

inline bool LooksLikeFont(const std::string& path) {
  std::string p = path;
  for (char& c : p) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return p.size() >= 4 &&
         (p.compare(p.size() - 4, 4, ".otf") == 0 ||
          p.compare(p.size() - 4, 4, ".ttf") == 0 ||
          p.compare(p.size() - 4, 4, ".ttc") == 0 ||
          p.compare(p.size() - 4, 4, ".eot") == 0 ||
          p.compare(p.size() - 5, 5, ".woff") == 0 ||
          p.compare(p.size() - 6, 6, ".woff2") == 0 ||
          p.compare(p.size() - 4, 4, ".cff") == 0);
}

inline bool LooksLikeImageName(const std::string& path) {
  std::string p = path;
  for (char& c : p) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  auto has = [&](const char* ext) {
    const size_t n = std::strlen(ext);
    return p.size() >= n && p.compare(p.size() - n, n, ext) == 0;
  };
  return has(".jpg") || has(".jpeg") || has(".png") || has(".gif") ||
         has(".bmp") || has(".webp") || has(".tif") || has(".tiff") ||
         has(".heic") || has(".heif");
}

inline bool IsHiddenOrMetaName(const std::string& path) {
  const auto slash = path.find_last_of('/');
  const std::string base =
      slash == std::string::npos ? path : path.substr(slash + 1);
  if (base.empty() || base[0] == '.') return true;
  std::string lower = base;
  for (char& c : lower) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return lower == "comicinfo.xml" || lower == "thumbs.db" ||
         lower == ".ds_store";
}

/** Natural sort: digit runs compared numerically. */
inline int NaturalCompare(const std::string& a, const std::string& b) {
  size_t i = 0, j = 0;
  while (i < a.size() && j < b.size()) {
    const bool da = a[i] >= '0' && a[i] <= '9';
    const bool db = b[j] >= '0' && b[j] <= '9';
    if (da && db) {
      size_t ie = i;
      while (ie < a.size() && a[ie] >= '0' && a[ie] <= '9') ++ie;
      size_t je = j;
      while (je < b.size() && b[je] >= '0' && b[je] <= '9') ++je;
      while (i < ie && a[i] == '0') ++i;
      while (j < je && b[j] == '0') ++j;
      const size_t ln = ie - i;
      const size_t rn = je - j;
      if (ln != rn) return ln < rn ? -1 : 1;
      const int c = a.compare(i, ln, b, j, rn);
      if (c != 0) return c < 0 ? -1 : 1;
      i = ie;
      j = je;
      continue;
    }
    if (a[i] != b[j]) return static_cast<unsigned char>(a[i]) <
                                     static_cast<unsigned char>(b[j])
                                 ? -1
                                 : 1;
    ++i;
    ++j;
  }
  if (i == a.size() && j == b.size()) return 0;
  return i == a.size() ? -1 : 1;
}

}  // namespace document
}  // namespace sherpa_onnx
