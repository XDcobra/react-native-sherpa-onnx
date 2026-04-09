#include "sherpa_onnx_alignment_engine.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(__ANDROID__) || defined(__APPLE__)
#include <xlocale.h>
#elif defined(__linux__)
#include <locale.h>
#endif

#include "sherpa_onnx_ctc_alignment.hpp"

namespace sherpa_onnx {
namespace alignment {
namespace {

struct CodepointSpan {
  char32_t cp = 0;
  size_t byte_start = 0;
  size_t byte_end = 0;
};

static locale_t AcquireEnUsUtf8Locale() {
  static locale_t loc = nullptr;
  if (loc == nullptr) {
    loc = newlocale(LC_CTYPE_MASK, "en_US.UTF-8", static_cast<locale_t>(0));
    if (loc == nullptr) {
      loc = newlocale(LC_CTYPE_MASK, "C.UTF-8", static_cast<locale_t>(0));
    }
    if (loc == nullptr) {
      loc = newlocale(LC_CTYPE_MASK, "C", static_cast<locale_t>(0));
    }
  }
  return loc;
}

static bool Utf8DecodeOne(const std::string& s, size_t& i, char32_t& out) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
  const size_t n = s.size();
  if (i >= n) {
    return false;
  }
  const unsigned char c0 = p[i];
  if (c0 < 0x80u) {
    out = c0;
    i += 1;
    return true;
  }
  if ((c0 & 0xE0u) == 0xC0u && i + 1 < n) {
    const unsigned char c1 = p[i + 1];
    if ((c1 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x1Fu) << 6) | static_cast<char32_t>(c1 & 0x3Fu);
    i += 2;
    return true;
  }
  if ((c0 & 0xF0u) == 0xE0u && i + 2 < n) {
    const unsigned char c1 = p[i + 1];
    const unsigned char c2 = p[i + 2];
    if ((c1 & 0xC0u) != 0x80u || (c2 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x0Fu) << 12) |
          (static_cast<char32_t>(c1 & 0x3Fu) << 6) |
          static_cast<char32_t>(c2 & 0x3Fu);
    i += 3;
    return true;
  }
  if ((c0 & 0xF8u) == 0xF0u && i + 3 < n) {
    const unsigned char c1 = p[i + 1];
    const unsigned char c2 = p[i + 2];
    const unsigned char c3 = p[i + 3];
    if ((c1 & 0xC0u) != 0x80u || (c2 & 0xC0u) != 0x80u ||
        (c3 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x07u) << 18) |
          (static_cast<char32_t>(c1 & 0x3Fu) << 12) |
          (static_cast<char32_t>(c2 & 0x3Fu) << 6) |
          static_cast<char32_t>(c3 & 0x3Fu);
    i += 4;
    return true;
  }
  return false;
}

static std::vector<CodepointSpan> DecodeUtf8WithOffsets(const std::string& s) {
  std::vector<CodepointSpan> out;
  size_t i = 0;
  while (i < s.size()) {
    const size_t begin = i;
    char32_t cp = 0;
    if (!Utf8DecodeOne(s, i, cp)) {
      throw std::runtime_error("Invalid UTF-8 text in alignment input");
    }
    out.push_back(CodepointSpan{cp, begin, i});
  }
  return out;
}

static bool IsUnicodeWhitespace(char32_t c) {
  if (c <= 0xFFu) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0x0Bu ||
        c == 0x0Cu || c == 0x85u) {
      return true;
    }
    return false;
  }
  if (c == 0x00A0 || c == 0x1680 || c == 0x202F || c == 0x205F || c == 0x3000) {
    return true;
  }
  if (c >= 0x2000 && c <= 0x200A) {
    return true;
  }
  if (c == 0x2028 || c == 0x2029) {
    return true;
  }
  return false;
}

static std::string TrimUtf8(const std::string& text) {
  if (text.empty()) {
    return "";
  }
  const auto cps = DecodeUtf8WithOffsets(text);
  if (cps.empty()) {
    return "";
  }

  size_t start_idx = 0;
  while (start_idx < cps.size() && IsUnicodeWhitespace(cps[start_idx].cp)) {
    start_idx += 1;
  }
  if (start_idx >= cps.size()) {
    return "";
  }

  size_t end_idx = cps.size();
  while (end_idx > start_idx && IsUnicodeWhitespace(cps[end_idx - 1].cp)) {
    end_idx -= 1;
  }

  const size_t byte_start = cps[start_idx].byte_start;
  const size_t byte_end =
      (end_idx < cps.size()) ? cps[end_idx].byte_start : text.size();
  return text.substr(byte_start, byte_end - byte_start);
}

static int32_t CountCodepoints(const std::string& text) {
  const auto cps = DecodeUtf8WithOffsets(text);
  return static_cast<int32_t>(cps.size());
}

static bool IsSentenceTerminator(char32_t cp) {
  switch (cp) {
    case '.':
    case '!':
    case '?':
    case ';':
    case 0x3002:  // 。
    case 0xFF01:  // ！
    case 0xFF1F:  // ？
    case 0xFF1B:  // ；
      return true;
    default:
      return false;
  }
}

static bool IsTrailingCloser(char32_t cp) {
  switch (cp) {
    case '"':
    case '\'':
    case ')':
    case ']':
    case '}':
    case '>':
    case 0x201D:  // ”
    case 0x2019:  // ’
    case 0x300D:  // 」
    case 0x300F:  // 』
    case 0x3011:  // 】
    case 0xFF09:  // ）
      return true;
    default:
      return false;
  }
}

static bool IsCjkChar(char32_t cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) ||
         (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x3040 && cp <= 0x309F) ||
         (cp >= 0x30A0 && cp <= 0x30FF) ||
         (cp >= 0xAC00 && cp <= 0xD7AF);
}

static bool IsWordDelimiter(char32_t cp) {
  switch (cp) {
    case '.':
    case ',':
    case '!':
    case '?':
    case ';':
    case ':':
    case '(':
    case ')':
    case '[':
    case ']':
    case '{':
    case '}':
    case '"':
    case '\'':
    case '`':
    case '~':
    case '<':
    case '>':
    case '/':
    case '\\':
    case '|':
    case '@':
    case '#':
    case '$':
    case '%':
    case '^':
    case '&':
    case '*':
    case '+':
    case '=':
    case 0x2026:  // …
    case 0xFF0C:  // ，
    case 0x3002:  // 。
    case 0xFF01:  // ！
    case 0xFF1F:  // ？
    case 0xFF1B:  // ；
    case 0xFF1A:  // ：
    case 0x3001:  // 、
      return true;
    default:
      return false;
  }
}

static bool IsAsciiDigit(char32_t cp) { return cp >= '0' && cp <= '9'; }

static bool IsLetterLike(char32_t cp) {
  if (cp == '.') {
    return true;
  }
  if (cp <= 0x7Fu) {
    return std::isalpha(static_cast<unsigned char>(cp)) != 0;
  }
  if (cp <= 0xFFFFu) {
    locale_t L = AcquireEnUsUtf8Locale();
    return iswalpha_l(static_cast<wint_t>(cp), L) != 0;
  }
  return false;
}

static bool IsUpperSingleLetter(const std::string& token_utf8) {
  const auto cps = DecodeUtf8WithOffsets(token_utf8);
  if (cps.size() != 1) {
    return false;
  }
  const char32_t cp = cps[0].cp;
  if (cp <= 0x7Fu) {
    return std::isupper(static_cast<unsigned char>(cp)) != 0;
  }
  if (cp <= 0xFFFFu) {
    locale_t L = AcquireEnUsUtf8Locale();
    return iswupper_l(static_cast<wint_t>(cp), L) != 0;
  }
  return false;
}

static std::string ToAsciiLower(const std::string& s) {
  std::string out = s;
  for (char& ch : out) {
    ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  }
  return out;
}

static std::string ExtractTokenBeforePeriod(
    const std::string& text,
    const std::vector<CodepointSpan>& cps,
    size_t period_index) {
  if (period_index == 0 || cps.empty() || period_index >= cps.size()) {
    return "";
  }

  int64_t i = static_cast<int64_t>(period_index) - 1;
  while (i >= 0 && IsUnicodeWhitespace(cps[static_cast<size_t>(i)].cp)) {
    i -= 1;
  }
  const int64_t end = i;

  while (i >= 0) {
    const char32_t cp = cps[static_cast<size_t>(i)].cp;
    if (IsLetterLike(cp)) {
      i -= 1;
      continue;
    }
    break;
  }

  if (end < i + 1) {
    return "";
  }

  const size_t start_idx = static_cast<size_t>(i + 1);
  const size_t end_idx = static_cast<size_t>(end);
  const size_t byte_start = cps[start_idx].byte_start;
  const size_t byte_end = cps[end_idx].byte_end;
  std::string token = text.substr(byte_start, byte_end - byte_start);

  while (!token.empty() && token.back() == '.') {
    token.pop_back();
  }
  return token;
}

static bool ShouldSplitOnPeriod(
    const std::string& text,
    const std::vector<CodepointSpan>& cps,
    size_t period_index) {
  if (period_index == 0 || period_index >= cps.size()) {
    return true;
  }

  const char32_t prev = cps[period_index - 1].cp;
  const char32_t next =
      (period_index + 1 < cps.size()) ? cps[period_index + 1].cp : 0;

  if (next != 0 && IsAsciiDigit(prev) && IsAsciiDigit(next)) {
    return false;
  }

  static const std::unordered_set<std::string> kCommonAbbreviations = {
      "mr", "mrs", "ms",  "dr", "prof", "sr", "jr", "st",
      "vs", "etc", "e.g", "i.e"};

  const std::string token_raw = ExtractTokenBeforePeriod(text, cps, period_index);
  const std::string token_lower = ToAsciiLower(token_raw);
  if (!token_lower.empty() &&
      kCommonAbbreviations.find(token_lower) != kCommonAbbreviations.end()) {
    return false;
  }

  if (!token_raw.empty() && IsUpperSingleLetter(token_raw)) {
    return false;
  }

  return true;
}

static size_t SentenceBoundaryEnd(
    const std::vector<CodepointSpan>& cps,
    size_t index) {
  size_t end = index + 1;
  while (end < cps.size() && IsSentenceTerminator(cps[end].cp)) {
    end += 1;
  }
  while (end < cps.size() && IsTrailingCloser(cps[end].cp)) {
    end += 1;
  }
  return end;
}

static std::vector<std::string> SanitizeSegments(
    const std::vector<std::string>& segments) {
  std::vector<std::string> cleaned;
  cleaned.reserve(segments.size());
  for (const auto& s : segments) {
    std::string trimmed = TrimUtf8(s);
    if (!trimmed.empty()) {
      cleaned.push_back(std::move(trimmed));
    }
  }
  return cleaned;
}

static std::vector<std::string> SplitTextIntoSentences(
    const std::string& text) {
  const std::string normalized = TrimUtf8(text);
  if (normalized.empty()) {
    return {};
  }

  const auto cps = DecodeUtf8WithOffsets(normalized);
  if (cps.empty()) {
    return {};
  }

  std::vector<std::string> out;
  size_t start = 0;
  size_t i = 0;

  while (i < cps.size()) {
    const char32_t current = cps[i].cp;
    if (!IsSentenceTerminator(current)) {
      i += 1;
      continue;
    }

    if (current == '.' && !ShouldSplitOnPeriod(normalized, cps, i)) {
      i += 1;
      continue;
    }

    const size_t end = SentenceBoundaryEnd(cps, i);
    if (end < cps.size() && !IsUnicodeWhitespace(cps[end].cp)) {
      i += 1;
      continue;
    }

    const size_t seg_start_byte = cps[start].byte_start;
    const size_t seg_end_byte = (end < cps.size()) ? cps[end].byte_start : normalized.size();
    std::string sentence = TrimUtf8(
        normalized.substr(seg_start_byte, seg_end_byte - seg_start_byte));
    if (!sentence.empty()) {
      out.push_back(std::move(sentence));
    }

    start = end;
    while (start < cps.size() && IsUnicodeWhitespace(cps[start].cp)) {
      start += 1;
    }
    i = start;
  }

  if (start < cps.size()) {
    const size_t seg_start_byte = cps[start].byte_start;
    std::string tail = TrimUtf8(normalized.substr(seg_start_byte));
    if (!tail.empty()) {
      out.push_back(std::move(tail));
    }
  }

  if (out.empty()) {
    out.push_back(normalized);
  }
  return out;
}

static std::vector<std::string> SplitTextIntoWords(
    const std::string& text) {
  const std::string normalized = TrimUtf8(text);
  if (normalized.empty()) {
    return {};
  }

  const auto cps = DecodeUtf8WithOffsets(normalized);
  std::vector<std::string> words;
  std::string current;

  auto flush_current = [&]() {
    std::string token = TrimUtf8(current);
    if (!token.empty()) {
      words.push_back(std::move(token));
    }
    current.clear();
  };

  for (const auto& item : cps) {
    if (IsUnicodeWhitespace(item.cp)) {
      flush_current();
      continue;
    }

    if (IsCjkChar(item.cp)) {
      flush_current();
      words.push_back(
          normalized.substr(item.byte_start, item.byte_end - item.byte_start));
      continue;
    }

    if (IsWordDelimiter(item.cp)) {
      flush_current();
      continue;
    }

    current.append(
        normalized.substr(item.byte_start, item.byte_end - item.byte_start));
  }

  flush_current();
  if (words.empty()) {
    words.push_back(normalized);
  }
  return words;
}

static std::vector<int32_t> DistributeByWeights(
    int32_t total,
    const std::vector<int32_t>& weights) {
  if (weights.empty()) {
    return {};
  }

  const int32_t safe_total = std::max<int32_t>(0, total);
  if (safe_total == 0) {
    return std::vector<int32_t>(weights.size(), 0);
  }

  std::vector<int32_t> safe_weights;
  safe_weights.reserve(weights.size());
  int64_t weight_sum = 0;
  for (int32_t w : weights) {
    const int32_t x = std::max<int32_t>(1, w);
    safe_weights.push_back(x);
    weight_sum += x;
  }

  if (weight_sum <= 0) {
    return std::vector<int32_t>(weights.size(), 0);
  }

  std::vector<int32_t> base(weights.size(), 0);
  std::vector<std::pair<size_t, double>> fractions;
  fractions.reserve(weights.size());

  int64_t assigned = 0;
  for (size_t i = 0; i < safe_weights.size(); ++i) {
    const double exact =
        (static_cast<double>(safe_total) * static_cast<double>(safe_weights[i])) /
        static_cast<double>(weight_sum);
    const int32_t floor_value = static_cast<int32_t>(std::floor(exact));
    base[i] = floor_value;
    assigned += floor_value;
    fractions.emplace_back(i, exact - static_cast<double>(floor_value));
  }

  int32_t remaining =
      safe_total - static_cast<int32_t>(std::min<int64_t>(assigned, INT32_MAX));
  if (remaining > 0) {
    std::sort(
        fractions.begin(),
        fractions.end(),
        [](const auto& a, const auto& b) { return a.second > b.second; });

    size_t ptr = 0;
    while (remaining > 0 && !fractions.empty()) {
      const size_t target = fractions[ptr % fractions.size()].first;
      base[target] = std::max<int32_t>(0, base[target]) + 1;
      remaining -= 1;
      ptr += 1;
    }
  }

  return base;
}

static std::vector<int32_t> DistributeSamplesByTextWeight(
    int32_t total_samples,
    const std::vector<std::string>& segments) {
  if (segments.empty()) {
    return {};
  }
  std::vector<int32_t> weights;
  weights.reserve(segments.size());
  for (const auto& segment : segments) {
    weights.push_back(std::max<int32_t>(1, CountCodepoints(segment)));
  }
  return DistributeByWeights(total_samples, weights);
}

static std::vector<int32_t> AlignChunkCountsToSegments(
    const std::vector<std::string>& segments,
    const std::vector<int32_t>& chunk_sample_counts) {
  if (segments.empty()) {
    return {};
  }

  std::vector<int32_t> counts;
  counts.reserve(chunk_sample_counts.size());
  for (int32_t value : chunk_sample_counts) {
    counts.push_back(std::max<int32_t>(0, value));
  }

  if (counts.size() == segments.size()) {
    return counts;
  }

  if (counts.size() > segments.size()) {
    std::vector<int32_t> merged(
        counts.begin(),
        counts.begin() + static_cast<long>(segments.size()));
    int64_t extra = 0;
    for (size_t i = segments.size(); i < counts.size(); ++i) {
      extra += counts[i];
    }
    if (!merged.empty()) {
      merged.back() += static_cast<int32_t>(std::clamp<int64_t>(
          extra,
          static_cast<int64_t>(INT32_MIN),
          static_cast<int64_t>(INT32_MAX)));
    }
    return merged;
  }

  int64_t total = 0;
  for (int32_t value : counts) {
    total += value;
  }
  return DistributeSamplesByTextWeight(
      static_cast<int32_t>(std::clamp<int64_t>(
          total,
          static_cast<int64_t>(INT32_MIN),
          static_cast<int64_t>(INT32_MAX))),
      segments);
}

static std::vector<SubtitleItem> BuildSubtitlesFromChunks(
    const std::vector<std::string>& segments,
    const std::vector<int32_t>& chunk_sample_counts,
    int32_t sample_rate) {
  if (sample_rate <= 0) {
    return {};
  }

  const std::vector<std::string> cleaned_segments = SanitizeSegments(segments);
  if (cleaned_segments.empty()) {
    return {};
  }

  const std::vector<int32_t> aligned_counts =
      AlignChunkCountsToSegments(cleaned_segments, chunk_sample_counts);

  std::vector<SubtitleItem> subtitles;
  subtitles.reserve(cleaned_segments.size());

  int64_t offset_samples = 0;
  for (size_t i = 0; i < cleaned_segments.size(); ++i) {
    const int64_t samples =
        std::max<int32_t>(0, (i < aligned_counts.size()) ? aligned_counts[i] : 0);
    if (samples == 0 && offset_samples == 0) {
      continue;
    }

    const double start_s =
        static_cast<double>(offset_samples) / static_cast<double>(sample_rate);
    offset_samples += samples;
    const double end_s =
        static_cast<double>(offset_samples) / static_cast<double>(sample_rate);

    subtitles.push_back(
        SubtitleItem{cleaned_segments[i], start_s, std::max(start_s, end_s)});
  }

  return subtitles;
}

static std::vector<SubtitleItem> BuildWordSubtitlesFromSentenceChunks(
    const std::vector<std::string>& sentences,
    const std::vector<int32_t>& sentence_chunk_sample_counts,
    int32_t sample_rate) {
  const std::vector<std::string> cleaned_sentences = SanitizeSegments(sentences);
  if (cleaned_sentences.empty()) {
    return {};
  }

  const std::vector<int32_t> aligned_sentence_counts =
      AlignChunkCountsToSegments(cleaned_sentences, sentence_chunk_sample_counts);

  std::vector<std::string> word_segments;
  std::vector<int32_t> word_chunk_counts;

  for (size_t i = 0; i < cleaned_sentences.size(); ++i) {
    const std::string& sentence = cleaned_sentences[i];
    const int32_t sentence_samples =
        std::max<int32_t>(0, (i < aligned_sentence_counts.size())
                                 ? aligned_sentence_counts[i]
                                 : 0);

    const std::vector<std::string> words = SplitTextIntoWords(sentence);
    if (words.empty()) {
      continue;
    }

    const std::vector<int32_t> distributed =
        DistributeSamplesByTextWeight(sentence_samples, words);

    for (size_t w = 0; w < words.size(); ++w) {
      word_segments.push_back(words[w]);
      word_chunk_counts.push_back((w < distributed.size()) ? distributed[w] : 0);
    }
  }

  return BuildSubtitlesFromChunks(word_segments, word_chunk_counts, sample_rate);
}

static std::vector<SubtitleItem> NormalizeIntervals(
    const std::vector<sherpa_onnx::ctc_alignment::AlignmentInterval>& items) {
  std::vector<SubtitleItem> out;
  out.reserve(items.size());
  for (const auto& item : items) {
    const std::string text = TrimUtf8(item.text);
    if (text.empty()) {
      continue;
    }
    const double start = std::isfinite(item.start_s) ? std::max(0.0, item.start_s)
                                                      : 0.0;
    const double end = std::isfinite(item.end_s) ? std::max(0.0, item.end_s)
                                                  : 0.0;
    out.push_back(SubtitleItem{text, start, std::max(start, end)});
  }
  return out;
}

static std::vector<int32_t> DistributeItemCounts(
    int32_t total,
    const std::vector<int32_t>& weights) {
  return DistributeByWeights(total, weights);
}

static std::vector<SubtitleItem> BuildSentenceSubtitlesFromAlignedWords(
    const std::string& text,
    const std::vector<SubtitleItem>& aligned_words) {
  const std::vector<std::string> sentences = SplitTextIntoSentences(text);
  if (sentences.empty() || aligned_words.empty()) {
    return {};
  }

  std::vector<int32_t> sentence_weights;
  sentence_weights.reserve(sentences.size());
  for (const auto& sentence : sentences) {
    const auto words = SplitTextIntoWords(sentence);
    sentence_weights.push_back(
        std::max<int32_t>(1, static_cast<int32_t>(words.size())));
  }

  const std::vector<int32_t> sentence_word_counts =
      DistributeItemCounts(
          static_cast<int32_t>(aligned_words.size()), sentence_weights);

  std::vector<SubtitleItem> subtitles;
  subtitles.reserve(sentences.size());

  size_t word_cursor = 0;
  double fallback_time = aligned_words[0].start_s;

  for (size_t i = 0; i < sentences.size(); ++i) {
    const int32_t count =
        std::max<int32_t>(0, (i < sentence_word_counts.size()) ? sentence_word_counts[i] : 0);
    const size_t start_cursor = word_cursor;
    const size_t end_cursor = std::min<size_t>(
        aligned_words.size(), word_cursor + static_cast<size_t>(count));
    word_cursor = end_cursor;

    if (end_cursor <= start_cursor) {
      subtitles.push_back(
          SubtitleItem{sentences[i], fallback_time, fallback_time});
      continue;
    }

    const double start = aligned_words[start_cursor].start_s;
    const double end = aligned_words[end_cursor - 1].end_s;
    fallback_time = end;
    subtitles.push_back(SubtitleItem{sentences[i], start, std::max(start, end)});
  }

  if (!subtitles.empty()) {
    const double last_aligned_end = aligned_words.back().end_s;
    subtitles.back().end_s = std::max(subtitles.back().end_s, last_aligned_end);
  }

  return subtitles;
}

static bool IsWordGranularity(const std::string& g) {
  return g == "word";
}

static bool IsSentenceGranularity(const std::string& g) {
  return g.empty() || g == "sentence";
}

static bool IsCharacterGranularity(const std::string& g) {
  return g == "character";
}

static uint16_t ReadLe16(std::istream& is) {
  uint8_t b[2];
  is.read(reinterpret_cast<char*>(b), 2);
  if (!is.good()) {
    return 0;
  }
  return static_cast<uint16_t>(b[0] | (b[1] << 8));
}

static uint32_t ReadLe32(std::istream& is) {
  uint8_t b[4];
  is.read(reinterpret_cast<char*>(b), 4);
  if (!is.good()) {
    return 0;
  }
  return static_cast<uint32_t>(
      b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24));
}

static bool DecodeMonoWavFile(
    const std::string& audio_path,
    std::vector<float>* out_samples,
    int32_t* out_sample_rate) {
  if (out_samples == nullptr || out_sample_rate == nullptr) {
    return false;
  }

  std::ifstream ifs(audio_path, std::ios::binary);
  if (!ifs.is_open()) {
    return false;
  }

  char riff[4];
  ifs.read(riff, 4);
  if (!ifs.good() || std::memcmp(riff, "RIFF", 4) != 0) {
    return false;
  }
  (void)ReadLe32(ifs);  // chunk size
  char wave[4];
  ifs.read(wave, 4);
  if (!ifs.good() || std::memcmp(wave, "WAVE", 4) != 0) {
    return false;
  }

  uint16_t audio_format = 0;    // PCM = 1, IEEE float = 3
  uint16_t num_channels = 0;    // must be mono
  uint32_t sample_rate = 0;
  uint16_t bits_per_sample = 0;  // 16 PCM or 32 float
  std::vector<uint8_t> data;

  while (ifs.good()) {
    char chunk_id[4];
    ifs.read(chunk_id, 4);
    if (!ifs.good()) {
      break;
    }
    const uint32_t chunk_size = ReadLe32(ifs);
    if (!ifs.good()) {
      break;
    }

    if (std::memcmp(chunk_id, "fmt ", 4) == 0) {
      if (chunk_size < 16) {
        return false;
      }
      audio_format = ReadLe16(ifs);
      num_channels = ReadLe16(ifs);
      sample_rate = ReadLe32(ifs);
      (void)ReadLe32(ifs);  // byte rate
      (void)ReadLe16(ifs);  // block align
      bits_per_sample = ReadLe16(ifs);
      if (chunk_size > 16) {
        ifs.seekg(static_cast<std::streamoff>(chunk_size - 16), std::ios::cur);
      }
    } else if (std::memcmp(chunk_id, "data", 4) == 0) {
      data.resize(chunk_size);
      if (chunk_size > 0) {
        ifs.read(reinterpret_cast<char*>(data.data()), chunk_size);
      }
      if (!ifs.good() && !ifs.eof()) {
        return false;
      }
    } else {
      ifs.seekg(static_cast<std::streamoff>(chunk_size), std::ios::cur);
    }

    if (chunk_size & 1u) {
      ifs.seekg(1, std::ios::cur);
    }
  }

  if (audio_format == 0 || sample_rate == 0 || num_channels != 1 || data.empty()) {
    return false;
  }

  std::vector<float> decoded;
  if (audio_format == 1 && bits_per_sample == 16) {
    const size_t count = data.size() / 2;
    decoded.resize(count, 0.0f);
    for (size_t i = 0; i < count; ++i) {
      const uint8_t lo = data[i * 2];
      const uint8_t hi = data[i * 2 + 1];
      const int16_t s = static_cast<int16_t>(lo | (hi << 8));
      decoded[i] = static_cast<float>(s) / 32768.0f;
    }
  } else if (audio_format == 3 && bits_per_sample == 32) {
    const size_t count = data.size() / 4;
    decoded.resize(count, 0.0f);
    for (size_t i = 0; i < count; ++i) {
      float v = 0.0f;
      std::memcpy(&v, data.data() + (i * 4), sizeof(float));
      decoded[i] = std::isfinite(v) ? v : 0.0f;
    }
  } else {
    return false;
  }

  *out_samples = std::move(decoded);
  *out_sample_rate = static_cast<int32_t>(sample_rate);
  return true;
}

static void AssertGranularity(
    const std::string& mode,
    const std::string& granularity) {
  if (mode == "aligned") {
    if (!IsSentenceGranularity(granularity) && !IsWordGranularity(granularity) &&
        !IsCharacterGranularity(granularity)) {
      throw std::runtime_error(
          "Alignment granularity must be sentence, word, or character");
    }
    return;
  }

  if (IsCharacterGranularity(granularity)) {
    throw std::runtime_error(
        "Character granularity is only supported for accurate alignment mode");
  }

  if (!IsSentenceGranularity(granularity) && !IsWordGranularity(granularity)) {
    throw std::runtime_error("Alignment granularity must be sentence or word");
  }
}

}  // namespace

AlignmentResult AlignProportional(
    const std::string& text,
    int32_t total_samples,
    int32_t sample_rate,
    const std::string& granularity) {
  AssertGranularity("proportional", granularity);

  const std::string normalized_g =
      IsWordGranularity(granularity) ? "word" : "sentence";

  const std::vector<std::string> segments =
      normalized_g == "word" ? SplitTextIntoWords(text) : SplitTextIntoSentences(text);

  AlignmentResult out;
  out.timing_mode = "proportional";

  if (segments.empty() || sample_rate <= 0 || total_samples <= 0) {
    return out;
  }

  const std::vector<int32_t> chunk_counts =
      DistributeSamplesByTextWeight(total_samples, segments);
  out.subtitles = BuildSubtitlesFromChunks(segments, chunk_counts, sample_rate);
  return out;
}

AlignmentResult AlignEstimated(
    const std::string& text,
    const std::vector<int32_t>& segment_sample_counts,
    int32_t sample_rate,
    const std::string& granularity) {
  AssertGranularity("estimated", granularity);

  AlignmentResult out;
  out.timing_mode = "estimated";

  if (sample_rate <= 0) {
    return out;
  }

  if (IsWordGranularity(granularity)) {
    const std::vector<std::string> sentences = SplitTextIntoSentences(text);
    if (!sentences.empty() &&
        segment_sample_counts.size() == sentences.size()) {
      out.subtitles = BuildWordSubtitlesFromSentenceChunks(
          sentences,
          segment_sample_counts,
          sample_rate);
      return out;
    }
  }

  const std::vector<std::string> segments =
      IsWordGranularity(granularity) ? SplitTextIntoWords(text)
                                     : SplitTextIntoSentences(text);

  if (segments.empty()) {
    return out;
  }

  out.subtitles = BuildSubtitlesFromChunks(
      segments,
      segment_sample_counts,
      sample_rate);
  return out;
}

AlignmentResult AlignAccurateFromPcm(
    const std::string& model_path,
    const std::string& text,
    const float* samples,
    size_t sample_count,
    int32_t sample_rate,
    const std::string& granularity) {
  AssertGranularity("aligned", granularity);

  if (model_path.empty()) {
    throw std::runtime_error("alignmentModelPath is required for accurate mode");
  }
  if (text.empty()) {
    throw std::runtime_error("text is required");
  }
  if (samples == nullptr || sample_count == 0) {
    throw std::runtime_error("samples are empty");
  }
  if (sample_rate <= 0) {
    throw std::runtime_error("sampleRate must be positive");
  }

  const auto ctc = sherpa_onnx::ctc_alignment::RunCtcAlignmentFromFloatPcm(
      model_path,
      text,
      "",
      samples,
      sample_count,
      sample_rate);

  const std::vector<SubtitleItem> word_items = NormalizeIntervals(ctc.words);
  const std::vector<SubtitleItem> char_items = NormalizeIntervals(ctc.chars);

  AlignmentResult out;
  out.timing_mode = "aligned";

  if (IsCharacterGranularity(granularity)) {
    out.subtitles = char_items;
  } else if (IsWordGranularity(granularity)) {
    out.subtitles = word_items;
  } else {
    out.subtitles = BuildSentenceSubtitlesFromAlignedWords(text, word_items);
  }

  return out;
}

AlignmentResult AlignAccurateFromFile(
    const std::string& model_path,
    const std::string& text,
    const std::string& audio_path,
    const std::string& granularity) {
  if (audio_path.empty()) {
    throw std::runtime_error("audioPath is required");
  }

  std::vector<float> samples;
  int32_t sample_rate = 0;
  if (!DecodeMonoWavFile(audio_path, &samples, &sample_rate)) {
    throw std::runtime_error("Failed to decode audio for alignment");
  }

  return AlignAccurateFromPcm(
      model_path,
      text,
      samples.data(),
      samples.size(),
      sample_rate,
      granularity);
}

}  // namespace alignment
}  // namespace sherpa_onnx
