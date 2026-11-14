#include "ReaderSidecar.h"

#include "ReaderRegistry.h"

#include <cstring>

namespace sherpa_onnx {
namespace reader {

namespace {

constexpr char kMagic[8] = {'S', 'H', 'R', 'D', 'O', 'C', 'R', '\0'};
// Limits against corrupt files.
constexpr uint32_t kMaxString = 64u * 1024u * 1024u;
constexpr uint32_t kMaxCount = 1u << 22;

class Writer {
 public:
  void U8(uint8_t v) { out_.push_back(v); }
  void U32(uint32_t v) {
    for (int i = 0; i < 4; ++i) out_.push_back(static_cast<uint8_t>(v >> (8 * i)));
  }
  void I32(int32_t v) { U32(static_cast<uint32_t>(v)); }
  void F32(float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    U32(bits);
  }
  void Str(const std::string& s) {
    U32(static_cast<uint32_t>(s.size()));
    out_.insert(out_.end(), s.begin(), s.end());
  }
  void Raw(const char* p, size_t n) { out_.insert(out_.end(), p, p + n); }
  std::vector<uint8_t> Take() { return std::move(out_); }

 private:
  std::vector<uint8_t> out_;
};

class Reader {
 public:
  Reader(const uint8_t* p, size_t n) : p_(p), n_(n) {}
  bool ok() const { return ok_; }
  bool AtEnd() const { return pos_ == n_; }

  uint8_t U8() {
    if (!Need(1)) return 0;
    return p_[pos_++];
  }
  uint32_t U32() {
    if (!Need(4)) return 0;
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) v |= static_cast<uint32_t>(p_[pos_ + i]) << (8 * i);
    pos_ += 4;
    return v;
  }
  int32_t I32() { return static_cast<int32_t>(U32()); }
  float F32() {
    const uint32_t bits = U32();
    float v;
    std::memcpy(&v, &bits, 4);
    return v;
  }
  std::string Str() {
    const uint32_t len = U32();
    if (len > kMaxString || !Need(len)) {
      ok_ = false;
      return {};
    }
    std::string s(reinterpret_cast<const char*>(p_ + pos_), len);
    pos_ += len;
    return s;
  }
  bool Raw(char* dst, size_t n) {
    if (!Need(n)) return false;
    std::memcpy(dst, p_ + pos_, n);
    pos_ += n;
    return true;
  }
  uint32_t Count() {
    const uint32_t c = U32();
    if (c > kMaxCount) ok_ = false;
    return ok_ ? c : 0;
  }

 private:
  bool Need(size_t k) {
    if (!ok_ || n_ - pos_ < k) {
      ok_ = false;
      return false;
    }
    return true;
  }

  const uint8_t* p_;
  size_t n_;
  size_t pos_ = 0;
  bool ok_ = true;
};

bool IsOcrChildOf(const std::string& child, const std::string& parent) {
  return child.size() > parent.size() + 2 && child.compare(0, parent.size(), parent) == 0 &&
         child.compare(parent.size(), 2, ".t") == 0;
}

}  // namespace

SidecarContent CollectRecognition(const ReaderSnapshot& snap, const std::string& modelId) {
  SidecarContent out;
  out.documentKey = snap.documentKey;
  out.modelId = modelId;
  const int n = static_cast<int>(snap.blocks.size());
  for (int i = 0; i < n; ++i) {
    const ReaderBlock& parent = snap.blocks[i];
    if (parent.type != ReaderBlockType::Page && parent.type != ReaderBlockType::Image) continue;
    SidecarPage page;
    for (int j = i + 1; j < n && IsOcrChildOf(snap.blocks[j].id, parent.id); ++j) {
      ReaderBlock c = snap.blocks[j];
      SetOwnBlockText(&c, snap.BlockText(j));
      page.blocks.push_back(std::move(c));
    }
    if (page.blocks.empty()) continue;
    page.parentBlockId = parent.id;
    page.frame = parent.imageFrame;
    auto f = snap.ocrFamily.find(parent.id);
    if (f != snap.ocrFamily.end()) page.family = f->second;
    out.pages.push_back(std::move(page));
  }
  return out;
}

std::vector<uint8_t> EncodeSidecar(const SidecarContent& content) {
  Writer w;
  w.Raw(kMagic, sizeof(kMagic));
  w.U32(kReaderSidecarVersion);
  w.Str(content.documentKey);
  w.Str(content.modelId);
  w.U32(static_cast<uint32_t>(content.pages.size()));
  for (const SidecarPage& p : content.pages) {
    w.Str(p.parentBlockId);
    w.I32(p.frame);
    w.Str(p.family);
    w.U32(static_cast<uint32_t>(p.blocks.size()));
    for (const ReaderBlock& b : p.blocks) {
      w.U8(static_cast<uint8_t>(b.type));
      w.U8(static_cast<uint8_t>(b.headingLevel));
      w.U32(b.flags);
      w.U8(b.hasRect ? 1 : 0);
      for (float r : b.rect) w.F32(r);
      const std::string text =
          b.textSource ? b.textSource->substr(static_cast<size_t>(b.textByteStart),
                                              static_cast<size_t>(b.textByteEnd - b.textByteStart))
                       : std::string();
      w.Str(text);
      w.U32(static_cast<uint32_t>(b.lines.size()));
      for (const ReaderLineBox& l : b.lines) {
        w.I32(l.start);
        w.I32(l.end);
        for (float r : l.rect) w.F32(r);
      }
    }
  }
  return w.Take();
}

bool DecodeSidecar(const uint8_t* data, size_t size, SidecarContent* out, std::string* error) {
  auto fail = [&](const std::string& msg) {
    if (error) *error = msg;
    return false;
  };
  if (!data || !out) return fail("No data");
  Reader r(data, size);
  char magic[8];
  if (!r.Raw(magic, sizeof(magic)) || std::memcmp(magic, kMagic, sizeof(kMagic)) != 0) {
    return fail("Not a reader OCR sidecar");
  }
  const uint32_t version = r.U32();
  if (!r.ok() || version != kReaderSidecarVersion) {
    return fail("Unsupported sidecar version " + std::to_string(version));
  }
  SidecarContent c;
  c.documentKey = r.Str();
  c.modelId = r.Str();
  const uint32_t pages = r.Count();
  for (uint32_t p = 0; p < pages && r.ok(); ++p) {
    SidecarPage page;
    page.parentBlockId = r.Str();
    page.frame = r.I32();
    page.family = r.Str();
    const uint32_t blocks = r.Count();
    for (uint32_t k = 0; k < blocks && r.ok(); ++k) {
      ReaderBlock b;
      const uint8_t type = r.U8();
      if (type != static_cast<uint8_t>(ReaderBlockType::Paragraph) &&
          type != static_cast<uint8_t>(ReaderBlockType::Heading)) {
        return fail("Unexpected block type in sidecar");
      }
      b.type = static_cast<ReaderBlockType>(type);
      b.headingLevel = r.U8();
      b.flags = r.U32();
      b.hasRect = r.U8() != 0;
      for (float& v : b.rect) v = r.F32();
      SetOwnBlockText(&b, r.Str());
      const uint32_t lines = r.Count();
      for (uint32_t l = 0; l < lines && r.ok(); ++l) {
        ReaderLineBox line;
        line.start = r.I32();
        line.end = r.I32();
        for (float& v : line.rect) v = r.F32();
        b.lines.push_back(line);
      }
      page.blocks.push_back(std::move(b));
    }
    c.pages.push_back(std::move(page));
  }
  if (!r.ok() || !r.AtEnd()) return fail("Truncated or corrupt sidecar");
  *out = std::move(c);
  return true;
}

}  // namespace reader
}  // namespace sherpa_onnx
