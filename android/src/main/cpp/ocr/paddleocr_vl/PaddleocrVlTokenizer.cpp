#include "PaddleocrVlTokenizer.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {
namespace {

constexpr const char* kU2581 = "\xE2\x96\x81";  // ▁

struct PairHash {
  size_t operator()(const std::pair<std::string, std::string>& pair) const noexcept {
    const size_t h1 = std::hash<std::string>{}(pair.first);
    const size_t h2 = std::hash<std::string>{}(pair.second);
    return h1 ^ (h2 + 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
  }
};

void AppendUtf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

uint32_t NextCodepoint(const std::string& s, size_t& i) {
  if (i >= s.size()) throw std::runtime_error("PaddleocrVlTokenizer: truncated utf-8");
  const auto c0 = static_cast<unsigned char>(s[i]);
  if (c0 < 0x80) {
    ++i;
    return c0;
  }
  size_t len = 0;
  uint32_t cp = 0;
  if ((c0 & 0xE0) == 0xC0) {
    len = 2;
    cp = c0 & 0x1F;
  } else if ((c0 & 0xF0) == 0xE0) {
    len = 3;
    cp = c0 & 0x0F;
  } else if ((c0 & 0xF8) == 0xF0) {
    len = 4;
    cp = c0 & 0x07;
  } else {
    throw std::runtime_error("PaddleocrVlTokenizer: bad utf-8");
  }
  if (i + len > s.size()) throw std::runtime_error("PaddleocrVlTokenizer: truncated utf-8");
  for (size_t k = 1; k < len; ++k) {
    const auto ck = static_cast<unsigned char>(s[i + k]);
    if ((ck & 0xC0) != 0x80) throw std::runtime_error("PaddleocrVlTokenizer: bad utf-8");
    cp = (cp << 6) | (ck & 0x3F);
  }
  i += len;
  return cp;
}

std::string ReplaceSpaces(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (char c : s) {
    if (c == ' ') {
      out += kU2581;
    } else {
      out.push_back(c);
    }
  }
  return out;
}

std::string ByteFallbackToken(unsigned char b) {
  static const char* kHex = "0123456789ABCDEF";
  std::string out = "<0x";
  out.push_back(kHex[b >> 4]);
  out.push_back(kHex[b & 0xF]);
  out += '>';
  return out;
}

bool ParseByteFallback(const std::string& token, unsigned char* out) {
  if (token.size() != 6 || token[0] != '<' || token[1] != '0' || token[2] != 'x' ||
      token[5] != '>') {
    return false;
  }
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  const int hi = nibble(token[3]);
  const int lo = nibble(token[4]);
  if (hi < 0 || lo < 0) return false;
  *out = static_cast<unsigned char>((hi << 4) | lo);
  return true;
}

class Json {
 public:
  explicit Json(std::string in) : s(std::move(in)) {}
  void SkipWs() {
    while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
  }
  [[noreturn]] void Fail(const std::string& msg) const {
    throw std::runtime_error("PaddleocrVlTokenizer: " + msg + " at " + std::to_string(i));
  }
  char Peek() {
    SkipWs();
    if (i >= s.size()) Fail("unexpected end");
    return s[i];
  }
  void Expect(char c) {
    if (Peek() != c) Fail(std::string("expected '") + c + "'");
    ++i;
  }
  bool Consume(char c) {
    if (Peek() == c) {
      ++i;
      return true;
    }
    return false;
  }
  std::string ParseString() {
    if (Peek() != '"') Fail("expected string");
    ++i;
    std::string out;
    while (i < s.size()) {
      const unsigned char c = static_cast<unsigned char>(s[i]);
      if (c == '"') {
        ++i;
        return out;
      }
      if (c == '\\') {
        ++i;
        if (i >= s.size()) Fail("bad escape");
        const char e = s[i++];
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out.push_back(e);
            break;
          case 'b':
            out.push_back('\b');
            break;
          case 'f':
            out.push_back('\f');
            break;
          case 'n':
            out.push_back('\n');
            break;
          case 'r':
            out.push_back('\r');
            break;
          case 't':
            out.push_back('\t');
            break;
          case 'u': {
            if (i + 4 > s.size()) Fail("short unicode escape");
            AppendUtf8(out, ParseHex4());
            break;
          }
          default:
            Fail("unknown escape");
        }
      } else {
        out.push_back(static_cast<char>(c));
        ++i;
      }
    }
    Fail("unterminated string");
  }
  int64_t ParseInt() {
    SkipWs();
    const size_t start = i;
    if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
    if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) Fail("expected int");
    while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
    try {
      return std::stoll(s.substr(start, i - start));
    } catch (const std::exception&) {
      Fail("int out of range");
    }
  }
  void SkipValue() {
    const char c = Peek();
    if (c == '"') {
      ParseString();
      return;
    }
    if (c == '{' || c == '[') {
      ++i;
      int depth = 1;
      while (i < s.size() && depth > 0) {
        if (s[i] == '"') {
          ParseString();
          continue;
        }
        if (s[i] == '{' || s[i] == '[') ++depth;
        else if (s[i] == '}' || s[i] == ']') --depth;
        ++i;
      }
      if (depth != 0) Fail("unclosed container");
      return;
    }
    if (c == 't' || c == 'f' || c == 'n') {
      while (i < s.size() && std::isalpha(static_cast<unsigned char>(s[i]))) ++i;
      return;
    }
    ParseInt();
    if (i < s.size() && (s[i] == '.' || s[i] == 'e' || s[i] == 'E')) {
      ++i;
      while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '+' ||
                              s[i] == '-' || s[i] == 'e' || s[i] == 'E' || s[i] == '.')) {
        ++i;
      }
    }
  }

  std::string s;
  size_t i = 0;

 private:
  uint32_t ParseHex4() {
    uint32_t cp = 0;
    for (int k = 0; k < 4; ++k) {
      const char h = s[i++];
      cp <<= 4;
      if (h >= '0' && h <= '9') cp += static_cast<uint32_t>(h - '0');
      else if (h >= 'a' && h <= 'f') cp += static_cast<uint32_t>(h - 'a' + 10);
      else if (h >= 'A' && h <= 'F') cp += static_cast<uint32_t>(h - 'A' + 10);
      else Fail("bad unicode escape");
    }
    return cp;
  }
};

std::string ReadAll(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("PaddleocrVlTokenizer: cannot open " + path);
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

}  // namespace

struct PaddleocrVlTokenizer::Impl {
  std::vector<std::string> id_to_token;
  std::unordered_map<std::string, int32_t> token_to_id;
  std::unordered_map<std::pair<std::string, std::string>, int, PairHash> merge_rank;
  std::unordered_set<int32_t> added_ids;
  struct Added {
    std::string content;
    int32_t id = 0;
  };
  std::vector<Added> added_by_len;

  void SetToken(int32_t id, const std::string& token) {
    if (id < 0) throw std::runtime_error("PaddleocrVlTokenizer: negative id");
    if (static_cast<size_t>(id) >= id_to_token.size()) {
      id_to_token.resize(static_cast<size_t>(id) + 1);
    }
    id_to_token[static_cast<size_t>(id)] = token;
    token_to_id[token] = id;
  }

  bool InVocab(const std::string& token) const {
    return token_to_id.find(token) != token_to_id.end();
  }

  std::vector<std::string> PiecesWithByteFallback(const std::string& text) const {
    std::vector<std::string> pieces;
    size_t i = 0;
    while (i < text.size()) {
      const size_t start = i;
      NextCodepoint(text, i);
      const std::string ch = text.substr(start, i - start);
      if (InVocab(ch)) {
        pieces.push_back(ch);
      } else {
        for (size_t b = start; b < i; ++b) {
          pieces.push_back(ByteFallbackToken(static_cast<unsigned char>(text[b])));
        }
      }
    }
    return pieces;
  }

  std::vector<std::string> Bpe(std::vector<std::string> word) const {
    if (word.size() < 2) return word;
    while (true) {
      int best_rank = 0x7fffffff;
      bool found = false;
      std::string first;
      std::string second;
      for (size_t n = 0; n + 1 < word.size(); ++n) {
        const auto it = merge_rank.find(std::make_pair(word[n], word[n + 1]));
        if (it != merge_rank.end() && it->second < best_rank) {
          best_rank = it->second;
          first = word[n];
          second = word[n + 1];
          found = true;
        }
      }
      if (!found) break;
      std::vector<std::string> next;
      next.reserve(word.size());
      for (size_t n = 0; n < word.size();) {
        if (n + 1 < word.size() && word[n] == first && word[n + 1] == second) {
          next.push_back(first + second);
          n += 2;
        } else {
          next.push_back(word[n]);
          ++n;
        }
      }
      word = std::move(next);
      if (word.size() < 2) break;
    }
    return word;
  }
};

PaddleocrVlTokenizer::PaddleocrVlTokenizer() = default;
PaddleocrVlTokenizer::~PaddleocrVlTokenizer() = default;
PaddleocrVlTokenizer::PaddleocrVlTokenizer(PaddleocrVlTokenizer&&) noexcept = default;
PaddleocrVlTokenizer& PaddleocrVlTokenizer::operator=(PaddleocrVlTokenizer&&) noexcept = default;

bool PaddleocrVlTokenizer::empty() const {
  return impl_ == nullptr || impl_->id_to_token.empty();
}

PaddleocrVlTokenizer PaddleocrVlTokenizer::Load(const std::string& tokenizer_json_path) {
  Json json(ReadAll(tokenizer_json_path));
  auto impl = std::make_unique<Impl>();
  std::string model_type;
  std::vector<Impl::Added> added;
  bool saw_vocab = false;
  int merge_count = 0;

  json.Expect('{');
  while (!json.Consume('}')) {
    const std::string key = json.ParseString();
    json.Expect(':');
    if (key == "added_tokens") {
      json.Expect('[');
      while (!json.Consume(']')) {
        json.Expect('{');
        int64_t id = -1;
        std::string content;
        bool has_id = false;
        bool has_content = false;
        while (!json.Consume('}')) {
          const std::string sub = json.ParseString();
          json.Expect(':');
          if (sub == "id") {
            id = json.ParseInt();
            has_id = true;
          } else if (sub == "content") {
            content = json.ParseString();
            has_content = true;
          } else {
            json.SkipValue();
          }
          json.Consume(',');
        }
        if (has_id && has_content) {
          added.push_back(Impl::Added{std::move(content), static_cast<int32_t>(id)});
        }
        json.Consume(',');
      }
    } else if (key == "model") {
      json.Expect('{');
      while (!json.Consume('}')) {
        const std::string sub = json.ParseString();
        json.Expect(':');
        if (sub == "type") {
          model_type = json.ParseString();
        } else if (sub == "vocab") {
          saw_vocab = true;
          json.Expect('{');
          while (!json.Consume('}')) {
            const std::string token = json.ParseString();
            json.Expect(':');
            const int64_t id = json.ParseInt();
            impl->SetToken(static_cast<int32_t>(id), token);
            json.Consume(',');
          }
        } else if (sub == "merges") {
          json.Expect('[');
          while (!json.Consume(']')) {
            if (json.Peek() == '[') {
              json.Expect('[');
              std::string a = json.ParseString();
              json.Expect(',');
              std::string b = json.ParseString();
              json.Expect(']');
              impl->merge_rank.emplace(std::make_pair(std::move(a), std::move(b)), merge_count);
            } else {
              const std::string pair = json.ParseString();
              const size_t sp = pair.find(' ');
              if (sp == std::string::npos) json.Fail("merge pair missing space");
              impl->merge_rank.emplace(
                  std::make_pair(pair.substr(0, sp), pair.substr(sp + 1)), merge_count);
            }
            ++merge_count;
            json.Consume(',');
          }
        } else {
          json.SkipValue();
        }
        json.Consume(',');
      }
    } else {
      json.SkipValue();
    }
    json.Consume(',');
  }

  if (model_type != "BPE") {
    throw std::runtime_error("PaddleocrVlTokenizer: model.type must be BPE");
  }
  if (!saw_vocab) throw std::runtime_error("PaddleocrVlTokenizer: missing vocab");
  for (const auto& tok : added) {
    impl->SetToken(tok.id, tok.content);
    impl->added_ids.insert(tok.id);
  }
  std::sort(added.begin(), added.end(), [](const Impl::Added& a, const Impl::Added& b) {
    if (a.content.size() != b.content.size()) return a.content.size() > b.content.size();
    return a.content < b.content;
  });
  impl->added_by_len = std::move(added);

  PaddleocrVlTokenizer tokenizer;
  tokenizer.impl_ = std::move(impl);
  return tokenizer;
}

int32_t PaddleocrVlTokenizer::TokenId(const std::string& token) const {
  if (impl_ == nullptr) throw std::runtime_error("PaddleocrVlTokenizer: not loaded");
  const auto it = impl_->token_to_id.find(token);
  if (it == impl_->token_to_id.end()) {
    throw std::runtime_error("PaddleocrVlTokenizer: missing token " + token);
  }
  return it->second;
}

std::vector<int32_t> PaddleocrVlTokenizer::Encode(const std::string& text) const {
  if (impl_ == nullptr) throw std::runtime_error("PaddleocrVlTokenizer: not loaded");
  std::vector<int32_t> ids;
  std::string span;
  auto flush = [&]() {
    if (span.empty()) return;
    const std::string normalized = ReplaceSpaces(span);
    for (const std::string& piece : impl_->Bpe(impl_->PiecesWithByteFallback(normalized))) {
      const auto it = impl_->token_to_id.find(piece);
      if (it == impl_->token_to_id.end()) {
        throw std::runtime_error("PaddleocrVlTokenizer: missing bpe piece " + piece);
      }
      ids.push_back(it->second);
    }
    span.clear();
  };

  for (size_t i = 0; i < text.size();) {
    int32_t added_id = -1;
    size_t added_len = 0;
    for (const auto& added : impl_->added_by_len) {
      if (i + added.content.size() <= text.size() &&
          text.compare(i, added.content.size(), added.content) == 0) {
        added_id = added.id;
        added_len = added.content.size();
        break;
      }
    }
    if (added_id >= 0) {
      flush();
      ids.push_back(added_id);
      i += added_len;
    } else {
      span.push_back(text[i]);
      ++i;
    }
  }
  flush();
  return ids;
}

std::string PaddleocrVlTokenizer::Decode(const std::vector<int32_t>& ids) const {
  if (impl_ == nullptr) throw std::runtime_error("PaddleocrVlTokenizer: not loaded");
  std::string out;
  for (int32_t id : ids) {
    if (id < 0 || static_cast<size_t>(id) >= impl_->id_to_token.size()) {
      throw std::runtime_error("PaddleocrVlTokenizer: id out of range");
    }
    const std::string& token = impl_->id_to_token[static_cast<size_t>(id)];
    unsigned char byte = 0;
    if (ParseByteFallback(token, &byte)) {
      out.push_back(static_cast<char>(byte));
      continue;
    }
    std::string piece = token;
    size_t pos = 0;
    while ((pos = piece.find(kU2581, pos)) != std::string::npos) {
      piece.replace(pos, 3, " ");
      pos += 1;
    }
    out += piece;
  }
  return out;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
