#include "PaddleocrVlMarkup.h"

#include "../OcrGeometry.h"
#include "../OcrTextUtils.h"
#include "../markup/OcrOtsl.h"
#include "../markup/OcrTable.h"
#include "PaddleocrVlLog.h"
#include "PaddleocrVlTaskProfile.h"

#include <cctype>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {
namespace {

constexpr const char kLocPrefix[] = "<|LOC_";

void StripTrailingEos(std::string& s) {
  auto ends_with = [&](const char* lit) {
    const size_t n = std::char_traits<char>::length(lit);
    return s.size() >= n && s.compare(s.size() - n, n, lit) == 0;
  };
  while (!s.empty()) {
    if (ends_with("</s>")) {
      s.resize(s.size() - 4);
      continue;
    }
    if (ends_with("<s>")) {
      s.resize(s.size() - 3);
      continue;
    }
    break;
  }
  while (!s.empty() && (s.back() == '\0' || s.back() == '\n' || s.back() == ' ')) {
    if (s.back() == '\0') {
      s.pop_back();
      continue;
    }
    break;
  }
}

std::string StripSpecialsKeepMarkup(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (size_t i = 0; i < raw.size();) {
    if (raw.compare(i, 2, "<|") == 0) {
      const size_t end = raw.find("|>", i + 2);
      if (end != std::string::npos) {
        i = end + 2;
        continue;
      }
    }
    if (raw.compare(i, 4, "</s>") == 0) {
      i += 4;
      continue;
    }
    if (raw.compare(i, 3, "<s>") == 0) {
      i += 3;
      continue;
    }
    out.push_back(raw[i]);
    ++i;
  }
  return out;
}

std::string LayoutText(const std::string& markdown) {
  std::string cleaned;
  cleaned.reserve(markdown.size());
  for (size_t i = 0; i < markdown.size();) {
    if (markdown[i] == '<') {
      const size_t end = markdown.find('>', i + 1);
      if (end != std::string::npos) {
        cleaned.push_back(' ');
        i = end + 1;
        continue;
      }
    }
    const char c = markdown[i];
    if (c == '#' || c == '*' || c == '_' || c == '`') {
      cleaned.push_back(' ');
      ++i;
      continue;
    }
    cleaned.push_back(c);
    ++i;
  }
  std::string out;
  out.reserve(cleaned.size());
  bool in_space = false;
  for (unsigned char c : cleaned) {
    if (std::isspace(c)) {
      if (!in_space && !out.empty()) {
        out.push_back(' ');
        in_space = true;
      }
    } else {
      out.push_back(static_cast<char>(c));
      in_space = false;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

void TrimInPlace(std::string& s) {
  size_t a = 0;
  while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  size_t b = s.size();
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  if (b < s.size()) s.erase(b);
  if (a > 0) s.erase(0, a);
}

bool ParseLocToken(const std::string& s, size_t i, int* value, size_t* end) {
  constexpr size_t kPrefixLen = 6;  // <|LOC_
  if (s.compare(i, kPrefixLen, kLocPrefix) != 0) return false;
  size_t j = i + kPrefixLen;
  if (j >= s.size() || !std::isdigit(static_cast<unsigned char>(s[j]))) {
    return false;
  }
  int n = 0;
  while (j < s.size() && std::isdigit(static_cast<unsigned char>(s[j]))) {
    n = n * 10 + (s[j] - '0');
    ++j;
  }
  if (j + 1 >= s.size() || s[j] != '|' || s[j + 1] != '>') return false;
  *value = n;
  *end = j + 2;
  return true;
}

bool ParseEightLocs(const std::string& s, size_t i, int coords[8],
                    size_t* end) {
  size_t p = i;
  for (int k = 0; k < 8; ++k) {
    int v = 0;
    size_t next = 0;
    if (!ParseLocToken(s, p, &v, &next)) return false;
    coords[k] = v;
    p = next;
  }
  *end = p;
  return true;
}

float MapLoc(int n, int dim) {
  return static_cast<float>(GridCoordToPixel(n, dim, kOcrGridPaddle));
}

void ParseSpotting(const std::string& raw, const PaddleocrVlParseOptions& options,
                   PaddleocrVlMarkup& out) {
  struct Instance {
    std::string text;
    int coords[8];
  };
  std::vector<Instance> instances;
  size_t text_start = 0;
  size_t i = 0;
  while (i < raw.size()) {
    int coords[8];
    size_t loc_end = 0;
    if (ParseEightLocs(raw, i, coords, &loc_end)) {
      std::string text = raw.substr(text_start, i - text_start);
      text = StripSpecialsKeepMarkup(text);
      TrimInPlace(text);
      if (!text.empty()) {
        Instance inst;
        inst.text = std::move(text);
        for (int k = 0; k < 8; ++k) inst.coords[k] = coords[k];
        instances.push_back(std::move(inst));
      }
      text_start = loc_end;
      i = loc_end;
      continue;
    }
    int dummy = 0;
    size_t tok_end = 0;
    if (ParseLocToken(raw, i, &dummy, &tok_end)) {
      i = tok_end;
      continue;
    }
    ++i;
  }

  OCR_LOGI("paddleocr_vl task=spotting instances=%zu frame=%dx%d",
           instances.size(), options.frame_width, options.frame_height);

  if (instances.empty()) {
    out.markdown_utf8 = StripSpecialsKeepMarkup(raw);
    out.text_utf8 = LayoutText(out.markdown_utf8);
    out.spans.clear();
    return;
  }

  int utf16_cursor = 0;
  for (size_t n = 0; n < instances.size(); ++n) {
    if (n > 0) {
      out.text_utf8.push_back('\n');
      utf16_cursor += 1;
    }
    const std::string& text = instances[n].text;
    const int start = utf16_cursor;
    const int units = Utf8ToUtf16Length(text);
    utf16_cursor += units;
    out.text_utf8 += text;

    OcrSpan span;
    span.utf16_start = start;
    span.utf16_end = utf16_cursor;
    span.confidence = 0.f;
    span.frame_index = options.frame_index;
    span.level = OcrSpanLevel::kLine;
    for (int k = 0; k < 4; ++k) {
      span.quad.xy[k * 2] = MapLoc(instances[n].coords[k * 2], options.frame_width);
      span.quad.xy[k * 2 + 1] =
          MapLoc(instances[n].coords[k * 2 + 1], options.frame_height);
    }
    out.spans.push_back(span);
  }
  out.markdown_utf8 = out.text_utf8;
}

}  // namespace

PaddleocrVlMarkup ParsePaddleocrVlMarkup(
    const std::string& generated, const PaddleocrVlParseOptions& options) {
  PaddleocrVlMarkup out;
  std::string raw = generated;
  StripTrailingEos(raw);
  out.raw_utf8 = raw;
  const auto& profile = ProfileForId(options.task);
  if (profile.parser == PaddleocrVlParser::kSpotting) {
    ParseSpotting(raw, options, out);
    return out;
  }
  const std::string stripped = StripSpecialsKeepMarkup(raw);
  if (profile.parser == PaddleocrVlParser::kOtsl) {
    const OcrTable table = ParseOtsl(stripped);
    out.markdown_utf8 = table.RenderGfm();
    out.text_utf8 = table.RenderPlain();
  } else if (profile.parser == PaddleocrVlParser::kGfmTable) {
    const OcrTable table = ParseGfmPipes(stripped);
    out.markdown_utf8 = table.RenderGfm();
    out.text_utf8 = table.RenderPlain();
  } else if (profile.parser == PaddleocrVlParser::kPassthrough) {
    out.markdown_utf8 = stripped;
    out.text_utf8 = LayoutText(stripped);
  } else {
    out.markdown_utf8 = stripped;
    out.text_utf8 = LayoutText(stripped);
  }
  out.spans.clear();
  OCR_LOGI("paddleocr_vl task=%s parser=%d content=%zu text=%zu", profile.id,
           static_cast<int>(profile.parser), out.markdown_utf8.size(),
           out.text_utf8.size());
  return out;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
