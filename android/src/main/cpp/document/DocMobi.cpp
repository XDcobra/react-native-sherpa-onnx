#include "DocMobi.h"

#include "DocHtmlText.h"
#include "DocUtf16.h"
#include "decode/ImageDecoder.h"

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <string>
#include <unistd.h>
#include <utility>
#include <vector>

#if defined(__ANDROID__)
#include <android/log.h>
#define DOC_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:doc", __VA_ARGS__)
#else
#define DOC_LOGI(...) \
  do {                \
  } while (0)
#endif

namespace sherpa_onnx {
namespace document {
namespace {

constexpr uint32_t kU32Max = 0xffffffffu;
constexpr uint16_t kCompNone = 1;
constexpr uint16_t kCompPalm = 2;
constexpr uint16_t kCompHuff = 17480;
constexpr uint32_t kEncCp1252 = 1252;
constexpr uint32_t kEncCp1251 = 1251;
constexpr uint32_t kEncUtf8 = 65001;
constexpr uint32_t kTypeAudio = 4;
constexpr uint32_t kTypeAzw4 = 258;
constexpr uint32_t kTypeTopaz = 248;

uint16_t Be16(const uint8_t* p) {
  return static_cast<uint16_t>((p[0] << 8) | p[1]);
}
uint32_t Be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}
bool Have(const std::vector<uint8_t>& b, size_t off, size_t n) {
  return off <= b.size() && n <= b.size() - off;
}
uint16_t At16(const std::vector<uint8_t>& b, size_t off) {
  return Have(b, off, 2) ? Be16(b.data() + off) : 0;
}
uint32_t At32(const std::vector<uint8_t>& b, size_t off) {
  return Have(b, off, 4) ? Be32(b.data() + off) : 0;
}
std::string AtStr(const std::vector<uint8_t>& b, size_t off, size_t n) {
  if (!Have(b, off, n)) return {};
  return std::string(reinterpret_cast<const char*>(b.data() + off), n);
}

void PutUtf8(std::string* o, uint32_t cp) {
  if (cp < 0x80) {
    o->push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    o->push_back(static_cast<char>(0xc0 | (cp >> 6)));
    o->push_back(static_cast<char>(0x80 | (cp & 0x3f)));
  } else {
    o->push_back(static_cast<char>(0xe0 | (cp >> 12)));
    o->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
    o->push_back(static_cast<char>(0x80 | (cp & 0x3f)));
  }
}

// 0x80..0x9F in windows-1252; 0xA0-0xFF match Latin-1.
const uint16_t kCp1252[32] = {
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178};

// windows-1251 0x80..0xFF (Cyrillic).
const uint16_t kCp1251[128] = {
    0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac,
    0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f, 0x0452, 0x2018,
    0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459,
    0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408,
    0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac,
    0x00ad, 0x00ae, 0x0407, 0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5,
    0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455,
    0x0457, 0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
    0x0418, 0x0419, 0x041a, 0x041b, 0x041c, 0x041d, 0x041e, 0x041f, 0x0420,
    0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429,
    0x042a, 0x042b, 0x042c, 0x042d, 0x042e, 0x042f, 0x0430, 0x0431, 0x0432,
    0x0433, 0x0434, 0x0435, 0x0436, 0x0437, 0x0438, 0x0439, 0x043a, 0x043b,
    0x043c, 0x043d, 0x043e, 0x043f, 0x0440, 0x0441, 0x0442, 0x0443, 0x0444,
    0x0445, 0x0446, 0x0447, 0x0448, 0x0449, 0x044a, 0x044b, 0x044c, 0x044d,
    0x044e, 0x044f};

int CountUnsetEnd(uint32_t x) {
  if (x == 0) return 0;
  int n = 0;
  while ((x & 1u) == 0) {
    x >>= 1;
    ++n;
  }
  return n;
}

bool IContains(const std::string& hay, const char* needle) {
  if (!needle || !*needle) return true;
  const size_t nlen = std::strlen(needle);
  if (nlen > hay.size()) return false;
  for (size_t i = 0; i + nlen <= hay.size(); ++i) {
    bool ok = true;
    for (size_t k = 0; k < nlen; ++k) {
      char d = hay[i + k];
      if (d >= 'A' && d <= 'Z') d = static_cast<char>(d - 'A' + 'a');
      if (d != needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

std::string ToUtf8(const std::vector<uint8_t>& in, uint32_t enc) {
  if (enc == kEncUtf8) {
    return std::string(reinterpret_cast<const char*>(in.data()), in.size());
  }
  std::string o;
  o.reserve(in.size());
  for (uint8_t c : in) {
    if (c < 0x80) {
      o.push_back(static_cast<char>(c));
      continue;
    }
    uint32_t cp = c;
    if (enc == kEncCp1251 && c >= 0x80) {
      cp = kCp1251[c - 0x80];
    } else if (c < 0xa0) {
      cp = kCp1252[c - 0x80];
    }
    PutUtf8(&o, cp);
  }
  return o;
}

int CountBitsSet(uint32_t x) {
  int n = 0;
  while (x) {
    n += static_cast<int>(x & 1u);
    x >>= 1;
  }
  return n;
}

uint32_t VarLenFromEnd(const std::vector<uint8_t>& a) {
  uint32_t value = 0;
  const size_t n = a.size();
  const size_t start = n > 4 ? n - 4 : 0;
  for (size_t i = start; i < n; ++i) {
    if (a[i] & 0x80) value = 0;
    value = (value << 7) | (a[i] & 0x7f);
  }
  return value;
}

struct VarLen {
  uint32_t value = 0;
  size_t length = 0;
};

VarLen ReadVarLen(const uint8_t* p, size_t n, size_t i) {
  VarLen v;
  for (int k = 0; k < 4 && i < n; ++k) {
    const uint8_t b = p[i++];
    v.value = (v.value << 7) | (b & 0x7f);
    v.length++;
    if (b & 0x80) break;
  }
  return v;
}

bool DecompressPalmDOC(const uint8_t* in, size_t n, std::vector<uint8_t>* out,
                       int64_t* budget) {
  if (!out || !budget) return false;
  for (size_t i = 0; i < n; ++i) {
    const uint8_t byte = in[i];
    if (byte == 0) {
      if (*budget <= 0) return false;
      out->push_back(0);
      --*budget;
    } else if (byte <= 8) {
      for (uint8_t k = 0; k < byte; ++k) {
        if (i + 1 >= n) return false;
        if (*budget <= 0) return false;
        out->push_back(in[++i]);
        --*budget;
      }
    } else if (byte <= 0x7f) {
      if (*budget <= 0) return false;
      out->push_back(byte);
      --*budget;
    } else if (byte <= 0xbf) {
      if (i + 1 >= n) return false;
      const uint16_t pair =
          static_cast<uint16_t>((byte << 8) | in[i + 1]);
      ++i;
      const int distance = (pair & 0x3fff) >> 3;
      const int length = (pair & 7) + 3;
      if (distance <= 0 || static_cast<size_t>(distance) > out->size()) {
        return false;
      }
      for (int j = 0; j < length; ++j) {
        if (*budget <= 0) return false;
        out->push_back((*out)[out->size() - static_cast<size_t>(distance)]);
        --*budget;
      }
    } else {
      if (*budget < 2) return false;
      out->push_back(32);
      out->push_back(static_cast<uint8_t>(byte ^ 0x80));
      *budget -= 2;
    }
  }
  return true;
}

uint32_t Read32Bits(const uint8_t* a, size_t n, size_t from_bit) {
  const size_t start_byte = from_bit >> 3;
  const size_t end = from_bit + 32;
  const size_t end_byte = end >> 3;
  uint64_t bits = 0;
  for (size_t i = start_byte; i <= end_byte; ++i) {
    bits = (bits << 8) | (i < n ? a[i] : 0);
  }
  const uint32_t shift = static_cast<uint32_t>(8 - (end & 7));
  return static_cast<uint32_t>((bits >> shift) & 0xffffffffu);
}

class PdbReader {
 public:
  ~PdbReader() { Close(); }

  bool Open(const DocumentSource& src, std::string* err_code,
            std::string* err_message) {
    Close();
    if (!src.path.empty()) {
      fd_ = ::open(src.path.c_str(), O_RDONLY);
      own_ = true;
      if (fd_ < 0) {
        if (err_code) *err_code = kErrOpenFailed;
        if (err_message) *err_message = "Failed to open MOBI file";
        return false;
      }
    } else if (src.fd >= 0) {
      fd_ = src.fd;
      own_ = false;
    } else {
      if (err_code) *err_code = kErrInvalidArgument;
      if (err_message) *err_message = "MOBI source must be a path or seekable fd";
      return false;
    }
    const off_t end = ::lseek(fd_, 0, SEEK_END);
    if (end < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "MOBI source is not seekable";
      return false;
    }
    file_size_ = static_cast<uint64_t>(end);
    uint8_t hdr[78];
    if (!Pread(0, hdr, 78, err_code, err_message)) return false;
    const uint16_t nrec = Be16(hdr + 76);
    if (nrec == 0 || nrec > kMaxArchiveEntries) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "MOBI record count out of range";
      return false;
    }
    std::vector<uint8_t> list(static_cast<size_t>(nrec) * 8u);
    if (!Pread(78, list.data(), list.size(), err_code, err_message)) return false;
    std::vector<uint32_t> offs(nrec);
    for (uint16_t i = 0; i < nrec; ++i) {
      offs[i] = Be32(list.data() + static_cast<size_t>(i) * 8u);
    }
    rec_.resize(nrec);
    for (uint16_t i = 0; i < nrec; ++i) {
      const uint32_t start = offs[i];
      const uint32_t stop =
          (i + 1 < nrec) ? offs[i + 1] : static_cast<uint32_t>(file_size_);
      if (stop < start || start > file_size_) {
        if (err_code) *err_code = kErrParseFailed;
        if (err_message) *err_message = "Corrupt MOBI record table";
        return false;
      }
      const uint32_t len = stop - start;
      if (len > static_cast<uint32_t>(kMaxEntryBytes)) {
        if (err_code) *err_code = kErrOpenFailed;
        if (err_message) *err_message = "MOBI record exceeds size limit";
        return false;
      }
      rec_[i] = {start, len};
    }
    return true;
  }

  size_t NumRecords() const { return rec_.size(); }

  bool LoadRecord(size_t i, std::vector<uint8_t>* out, std::string* err_code,
                  std::string* err_message) const {
    if (!out || i >= rec_.size()) {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "MOBI record index out of range";
      return false;
    }
    out->assign(rec_[i].second, 0);
    if (rec_[i].second == 0) return true;
    return Pread(rec_[i].first, out->data(), rec_[i].second, err_code,
                 err_message);
  }

 private:
  void Close() {
    if (own_ && fd_ >= 0) ::close(fd_);
    fd_ = -1;
    own_ = false;
    rec_.clear();
    file_size_ = 0;
  }

  bool Pread(uint64_t off, void* buf, size_t n, std::string* err_code,
             std::string* err_message) const {
    uint8_t* p = static_cast<uint8_t*>(buf);
    size_t got = 0;
    while (got < n) {
      const ssize_t r =
          ::pread(fd_, p + got, n - got, static_cast<off_t>(off + got));
      if (r < 0) {
        if (errno == EINTR) continue;
        if (err_code) *err_code = kErrOpenFailed;
        if (err_message) *err_message = "Failed to read MOBI record";
        return false;
      }
      if (r == 0) break;
      got += static_cast<size_t>(r);
    }
    if (got != n) {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "Short MOBI read";
      return false;
    }
    return true;
  }

  int fd_ = -1;
  bool own_ = false;
  uint64_t file_size_ = 0;
  std::vector<std::pair<uint32_t, uint32_t>> rec_;
};

struct HuffDec {
  std::vector<uint32_t> t1;
  std::vector<uint32_t> t2min;
  std::vector<uint32_t> t2val;
  std::vector<std::pair<std::vector<uint8_t>, bool>> dict;
  bool ok = false;

  bool Decompress(const uint8_t* in, size_t n, std::vector<uint8_t>* out,
                  int64_t* budget, int depth) {
    if (!ok || depth > 32) return false;
    const size_t bit_len = n * 8;
    for (size_t i = 0; i < bit_len;) {
      const uint32_t bits = Read32Bits(in, n, i);
      uint32_t packed = 0;
      if ((bits >> 24) < t1.size()) packed = t1[bits >> 24];
      int found_flag = packed & 0x80;
      int clen = packed & 0x1f;
      uint32_t value = packed >> 8;
      if (!found_flag) {
        while (clen > 0 && clen < 32 &&
               clen < static_cast<int>(t2min.size()) &&
               (bits >> (32 - clen)) < t2min[static_cast<size_t>(clen)]) {
          ++clen;
        }
        if (clen >= 0 && clen < static_cast<int>(t2val.size())) {
          value = t2val[static_cast<size_t>(clen)];
        }
      }
      if (clen <= 0 || clen > 32) return false;
      i += static_cast<size_t>(clen);
      if (i > bit_len) break;
      const uint32_t code = value - (bits >> (32 - clen));
      if (code >= dict.size()) return false;
      auto& entry = dict[code];
      if (!entry.second) {
        std::vector<uint8_t> inner;
        if (!Decompress(entry.first.data(), entry.first.size(), &inner, budget,
                        depth + 1)) {
          return false;
        }
        entry.first = std::move(inner);
        entry.second = true;
      }
      if (*budget < static_cast<int64_t>(entry.first.size())) return false;
      *budget -= static_cast<int64_t>(entry.first.size());
      out->insert(out->end(), entry.first.begin(), entry.first.end());
    }
    return true;
  }
};

bool SetupHuff(PdbReader* pdb, size_t start, uint32_t huff_rec, uint32_t n_huff,
               HuffDec* h, std::string* err_code, std::string* err_message) {
  std::vector<uint8_t> rec;
  if (!pdb->LoadRecord(start + huff_rec, &rec, err_code, err_message)) {
    return false;
  }
  if (rec.size() < 16 || AtStr(rec, 0, 4) != "HUFF") {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Invalid HUFF record";
    return false;
  }
  const uint32_t off1 = At32(rec, 8);
  const uint32_t off2 = At32(rec, 12);
  h->t1.assign(256, 0);
  for (int i = 0; i < 256; ++i) {
    h->t1[static_cast<size_t>(i)] = At32(rec, off1 + static_cast<size_t>(i) * 4);
  }
  h->t2min.assign(33, 0);
  h->t2val.assign(33, 0);
  for (int i = 1; i <= 32; ++i) {
    const size_t o = off2 + static_cast<size_t>(i - 1) * 8;
    h->t2min[static_cast<size_t>(i)] = At32(rec, o);
    h->t2val[static_cast<size_t>(i)] = At32(rec, o + 4);
  }
  for (uint32_t i = 1; i < n_huff; ++i) {
    std::vector<uint8_t> cdic;
    if (!pdb->LoadRecord(start + huff_rec + i, &cdic, err_code, err_message)) {
      return false;
    }
    if (cdic.size() < 16 || AtStr(cdic, 0, 4) != "CDIC") {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "Invalid CDIC record";
      return false;
    }
    const uint32_t hdr_len = At32(cdic, 4);
    const uint32_t num_entries = At32(cdic, 8);
    const uint32_t code_len = At32(cdic, 12);
    const size_t already = h->dict.size();
    const uint32_t n = std::min<uint32_t>(
        1u << std::min<uint32_t>(code_len, 16u),
        num_entries > already ? num_entries - static_cast<uint32_t>(already)
                              : 0);
    if (hdr_len > cdic.size()) return false;
    const uint8_t* buf = cdic.data() + hdr_len;
    const size_t bufn = cdic.size() - hdr_len;
    for (uint32_t e = 0; e < n; ++e) {
      if (e * 2 + 2 > bufn) return false;
      const uint16_t offset = Be16(buf + e * 2);
      if (static_cast<size_t>(offset) + 2 > bufn) return false;
      const uint16_t x = Be16(buf + offset);
      const uint16_t length = x & 0x7fff;
      const bool decompressed = (x & 0x8000) != 0;
      if (static_cast<size_t>(offset) + 2 + length > bufn) return false;
      std::vector<uint8_t> val(buf + offset + 2, buf + offset + 2 + length);
      h->dict.emplace_back(std::move(val), decompressed);
    }
  }
  h->ok = true;
  return true;
}

struct MobiHeaders {
  uint16_t compression = 0;
  uint16_t num_text_records = 0;
  uint16_t encryption = 0;
  uint32_t mobi_type = 2;
  uint32_t encoding = kEncCp1252;
  uint32_t version = 0;
  uint32_t resource_start = kU32Max;
  uint32_t huffcdic = kU32Max;
  uint32_t num_huffcdic = 0;
  uint32_t trailing_flags = 0;
  uint32_t indx = kU32Max;
  uint32_t fdst = kU32Max;
  uint32_t num_fdst = 0;
  uint32_t frag = kU32Max;
  uint32_t skel = kU32Max;
  uint32_t boundary = kU32Max;
  bool has_mobi = false;
  bool kf8 = false;
  bool is_dictionary = false;
};

bool ParseHeaders(const std::vector<uint8_t>& rec0, MobiHeaders* h,
                  std::string* err_code, std::string* err_message) {
  if (rec0.size() < 16) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Truncated PalmDOC header";
    return false;
  }
  h->compression = At16(rec0, 0);
  h->num_text_records = At16(rec0, 8);
  h->encryption = At16(rec0, 12);
  if (rec0.size() >= 20 && AtStr(rec0, 16, 4) == "MOBI") {
    h->has_mobi = true;
    const uint32_t mobi_len = At32(rec0, 20);
    h->mobi_type = At32(rec0, 24);
    h->encoding = At32(rec0, 28);
    h->version = At32(rec0, 36);
    h->resource_start = At32(rec0, 108);
    h->huffcdic = At32(rec0, 112);
    h->num_huffcdic = At32(rec0, 116);
    const uint32_t exth_flag = At32(rec0, 128);
    h->trailing_flags = At32(rec0, 240);
    h->indx = At32(rec0, 244);
    h->fdst = At32(rec0, 192);
    h->num_fdst = At32(rec0, 196);
    h->frag = At32(rec0, 248);
    h->skel = At32(rec0, 252);
    h->kf8 = h->version >= 8;
    if ((exth_flag & 0x40) && mobi_len + 16 <= rec0.size()) {
      const size_t exth_off = mobi_len + 16;
      if (Have(rec0, exth_off, 12) && AtStr(rec0, exth_off, 4) == "EXTH") {
        const uint32_t count = At32(rec0, exth_off + 8);
        size_t off = exth_off + 12;
        for (uint32_t i = 0; i < count && Have(rec0, off, 8); ++i) {
          const uint32_t type = At32(rec0, off);
          const uint32_t length = At32(rec0, off + 4);
          if (length < 8 || !Have(rec0, off, length)) break;
          if (type == 121 && length >= 12) {
            h->boundary = At32(rec0, off + 8);
          }
          if (type == 403) h->is_dictionary = true;
          if (type == 501 && length > 8) {
            std::string cde = AtStr(rec0, off + 8, length - 8);
            if (IContains(cde, "dict")) h->is_dictionary = true;
          }
          off += length;
        }
      }
    }
    // DRM offset / flags in record 0 (KindleUnpack 0xA8 / 0xCC).
    if (rec0.size() >= 0xd0) {
      const uint32_t drm_off = At32(rec0, 0xa8);
      const uint32_t drm_flags = At32(rec0, 0xcc);
      if (drm_off != 0 && drm_off != kU32Max && drm_flags != 0) {
        h->encryption = 2;
      }
    }
  }
  return true;
}

bool TypeUnsupported(uint32_t t) {
  return t == kTypeAudio || t == kTypeAzw4 || t == kTypeTopaz;
}

void StripTrailing(std::vector<uint8_t>* rec, uint32_t trailing_flags) {
  const bool multibyte = (trailing_flags & 1u) != 0;
  const int nent = CountBitsSet(trailing_flags >> 1);
  for (int i = 0; i < nent && !rec->empty(); ++i) {
    const uint32_t len = VarLenFromEnd(*rec);
    if (len == 0 || len > rec->size()) break;
    rec->resize(rec->size() - len);
  }
  if (multibyte && !rec->empty()) {
    const uint32_t len = (rec->back() & 3u) + 1u;
    if (len <= rec->size()) rec->resize(rec->size() - len);
  }
}

void AppendBlocks(ExtractTextResult* r, const HtmlExtract& hx, int section_index,
                  const std::string& href, int* utf16_off) {
  for (const auto& block : hx.blocks) {
    if (*utf16_off > 0) {
      r->text += "\n\n";
      *utf16_off += 2;
    }
    const int start = *utf16_off;
    r->text += block;
    const int len = Utf16LengthOfUtf8(block);
    *utf16_off += len;
    DocTextSpan span;
    span.utf16_start = start;
    span.utf16_end = start + len;
    span.level = "block";
    span.section_index = section_index;
    span.href = href;
    r->spans.push_back(std::move(span));
  }
}

struct MobiBook {
  PdbReader pdb;
  MobiHeaders hdr;
  size_t start = 0;
  HuffDec huff;
  std::vector<uint8_t> raw_text;
  std::vector<std::string> html_parts;
};

void FillHtmlParts(MobiBook* b);

bool LoadTextRecord(MobiBook* b, size_t text_index, std::vector<uint8_t>* out,
                    int64_t* budget, std::string* err_code,
                    std::string* err_message) {
  std::vector<uint8_t> rec;
  if (!b->pdb.LoadRecord(b->start + 1 + text_index, &rec, err_code,
                         err_message)) {
    return false;
  }
  StripTrailing(&rec, b->hdr.trailing_flags);
  if (b->hdr.compression == kCompNone) {
    if (*budget < static_cast<int64_t>(rec.size())) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "MOBI text exceeds size limit";
      return false;
    }
    *budget -= static_cast<int64_t>(rec.size());
    *out = std::move(rec);
    return true;
  }
  if (b->hdr.compression == kCompPalm) {
    return DecompressPalmDOC(rec.data(), rec.size(), out, budget);
  }
  if (b->hdr.compression == kCompHuff) {
    if (!b->huff.ok) {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "HUFF/CDIC not initialized";
      return false;
    }
    return b->huff.Decompress(rec.data(), rec.size(), out, budget, 0);
  }
  if (err_code) *err_code = kErrParseFailed;
  if (err_message) *err_message = "Unknown MOBI compression";
  return false;
}

bool OpenBook(const DocumentSource& src, MobiBook* b, std::string* err_code,
              std::string* err_message) {
  if (!b->pdb.Open(src, err_code, err_message)) return false;
  std::vector<uint8_t> rec0;
  if (!b->pdb.LoadRecord(0, &rec0, err_code, err_message)) return false;
  if (!ParseHeaders(rec0, &b->hdr, err_code, err_message)) return false;
  if (b->hdr.encryption != 0) {
    if (err_code) *err_code = kErrDrm;
    if (err_message) *err_message = "Encrypted MOBI (DRM)";
    return false;
  }
  if (b->hdr.has_mobi && TypeUnsupported(b->hdr.mobi_type)) {
    if (err_code) *err_code = kErrUnsupportedFormat;
    if (err_message) *err_message = "MOBI type is not a DRM-free book";
    DOC_LOGI("mobi skip type=%u", b->hdr.mobi_type);
    return false;
  }
  if (b->hdr.is_dictionary) {
    if (err_code) *err_code = kErrUnsupportedFormat;
    if (err_message) *err_message = "MOBI dictionary is not supported";
    DOC_LOGI("mobi skip dictionary");
    return false;
  }
  if (!b->hdr.kf8 && b->hdr.boundary != 0 && b->hdr.boundary != kU32Max &&
      b->hdr.boundary < b->pdb.NumRecords()) {
    std::vector<uint8_t> kf8rec;
    std::string ign_c;
    std::string ign_m;
    if (b->pdb.LoadRecord(b->hdr.boundary, &kf8rec, &ign_c, &ign_m) &&
        kf8rec.size() >= 20 && AtStr(kf8rec, 16, 4) == "MOBI") {
      MobiHeaders kf8h;
      if (ParseHeaders(kf8rec, &kf8h, &ign_c, &ign_m) && kf8h.encryption == 0 &&
          !TypeUnsupported(kf8h.mobi_type)) {
        b->start = b->hdr.boundary;
        b->hdr = kf8h;
        DOC_LOGI("mobi combo → KF8 start=%zu", b->start);
      }
    }
  }
  if (b->hdr.compression == kCompHuff) {
    if (b->hdr.huffcdic == kU32Max || b->hdr.num_huffcdic == 0) {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "Missing HUFF/CDIC tables";
      return false;
    }
    if (!SetupHuff(&b->pdb, b->start, b->hdr.huffcdic, b->hdr.num_huffcdic,
                   &b->huff, err_code, err_message)) {
      return false;
    }
  } else if (b->hdr.compression != kCompNone &&
             b->hdr.compression != kCompPalm) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Unknown MOBI compression";
    return false;
  }
  int64_t budget = kMaxUncompressedBytes;
  const uint16_t ntext = b->hdr.num_text_records;
  if (ntext == 0 || static_cast<size_t>(ntext) + b->start >= b->pdb.NumRecords()) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "MOBI has no text records";
    return false;
  }
  for (uint16_t i = 0; i < ntext; ++i) {
    std::vector<uint8_t> chunk;
    if (!LoadTextRecord(b, i, &chunk, &budget, err_code, err_message)) {
      if (err_code && err_code->empty()) {
        *err_code = kErrParseFailed;
        if (err_message) *err_message = "MOBI decompress failed";
      }
      return false;
    }
    b->raw_text.insert(b->raw_text.end(), chunk.begin(), chunk.end());
  }
  FillHtmlParts(b);
  return true;
}

bool StartsIgnoreCase(const uint8_t* s, size_t n, size_t i, const char* lit) {
  const size_t L = std::strlen(lit);
  if (i + L > n) return false;
  for (size_t k = 0; k < L; ++k) {
    char d = static_cast<char>(s[i + k]);
    if (d >= 'A' && d <= 'Z') d = static_cast<char>(d - 'A' + 'a');
    if (d != lit[k]) return false;
  }
  return true;
}

/** Split on `<mbp:pagebreak>` / `<pagebreak>` only (not any `<` before those letters). */
std::vector<std::pair<size_t, size_t>> SplitPagebreaks(
    const std::vector<uint8_t>& raw) {
  std::vector<size_t> starts = {0};
  std::vector<size_t> ends;
  for (size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] != '<') continue;
    size_t j = i + 1;
    while (j < raw.size() &&
           (raw[j] == ' ' || raw[j] == '\t' || raw[j] == '\n' || raw[j] == '\r')) {
      ++j;
    }
    if (StartsIgnoreCase(raw.data(), raw.size(), j, "mbp:")) j += 4;
    if (!StartsIgnoreCase(raw.data(), raw.size(), j, "pagebreak")) continue;
    size_t gt = i;
    while (gt < raw.size() && raw[gt] != '>') ++gt;
    if (gt >= raw.size()) break;
    ends.push_back(i);
    starts.push_back(gt + 1);
    i = gt;
  }
  ends.push_back(raw.size());
  std::vector<std::pair<size_t, size_t>> parts;
  const size_t n = std::min(starts.size(), ends.size());
  for (size_t i = 0; i < n; ++i) {
    if (ends[i] > starts[i]) parts.emplace_back(starts[i], ends[i]);
  }
  if (parts.empty()) parts.emplace_back(0, raw.size());
  return parts;
}

bool ValidRecIndex(uint32_t idx, size_t start, size_t nrec) {
  return idx != 0 && idx != kU32Max && start + idx < nrec;
}

struct IndxRow {
  std::string name;
  std::map<uint8_t, std::vector<uint32_t>> tag_map;
};

uint32_t TagVal(const IndxRow& row, uint8_t tag, size_t i) {
  const auto it = row.tag_map.find(tag);
  if (it == row.tag_map.end() || i >= it->second.size()) return 0;
  return it->second[i];
}

bool ParseIndexData(PdbReader* pdb, size_t start, uint32_t indx_index,
                    std::vector<IndxRow>* table) {
  if (!pdb || !table) return false;
  table->clear();
  std::string ign_c;
  std::string ign_m;
  std::vector<uint8_t> hdr;
  if (!pdb->LoadRecord(start + indx_index, &hdr, &ign_c, &ign_m)) return false;
  if (hdr.size() < 28 || AtStr(hdr, 0, 4) != "INDX") return false;
  const uint32_t hdr_len = At32(hdr, 4);
  const uint32_t n_data = At32(hdr, 24);
  if (hdr_len < 12 || hdr_len > hdr.size() || n_data == 0 || n_data > 4096) {
    return false;
  }
  if (AtStr(hdr, hdr_len, 4) != "TAGX") return false;
  const uint32_t tagx_len = At32(hdr, hdr_len + 4);
  const uint32_t n_ctrl = At32(hdr, hdr_len + 8);
  if (tagx_len < 12 || hdr_len + tagx_len > hdr.size()) return false;
  const uint32_t n_tags = (tagx_len - 12) / 4;
  struct Tagx {
    uint8_t tag = 0;
    uint8_t num_values = 0;
    uint8_t mask = 0;
    uint8_t end = 0;
  };
  std::vector<Tagx> tags(n_tags);
  for (uint32_t t = 0; t < n_tags; ++t) {
    const size_t o = hdr_len + 12 + static_cast<size_t>(t) * 4;
    tags[t].tag = hdr[o];
    tags[t].num_values = hdr[o + 1];
    tags[t].mask = hdr[o + 2];
    tags[t].end = hdr[o + 3];
  }
  if (n_ctrl > 32) return false;

  for (uint32_t i = 0; i < n_data; ++i) {
    std::vector<uint8_t> rec;
    if (!pdb->LoadRecord(start + indx_index + 1 + i, &rec, &ign_c, &ign_m)) {
      return false;
    }
    if (rec.size() < 28 || AtStr(rec, 0, 4) != "INDX") return false;
    const uint32_t idxt = At32(rec, 20);
    const uint32_t nent = At32(rec, 24);
    if (nent > 10000) return false;
    for (uint32_t j = 0; j < nent; ++j) {
      const size_t off_at = static_cast<size_t>(idxt) + 4 + static_cast<size_t>(j) * 2;
      if (!Have(rec, off_at, 2)) return false;
      const uint16_t offset = Be16(rec.data() + off_at);
      if (!Have(rec, offset, 1)) return false;
      const uint8_t nlen = rec[offset];
      if (!Have(rec, offset + 1, nlen)) return false;
      IndxRow row;
      row.name.assign(reinterpret_cast<const char*>(rec.data() + offset + 1), nlen);
      const size_t start_pos = static_cast<size_t>(offset) + 1 + nlen;
      if (!Have(rec, start_pos, n_ctrl)) return false;
      size_t pos = start_pos + n_ctrl;
      size_t ctrl_i = 0;
      struct TagInfo {
        uint8_t tag = 0;
        uint32_t value_count = 0;
        uint32_t value_bytes = 0;
        uint8_t num_values = 0;
        bool use_bytes = false;
      };
      std::vector<TagInfo> infos;
      for (const auto& tg : tags) {
        if (tg.end & 1) {
          ++ctrl_i;
          continue;
        }
        if (ctrl_i >= n_ctrl) return false;
        const uint8_t raw = rec[start_pos + ctrl_i] & tg.mask;
        TagInfo inf;
        inf.tag = tg.tag;
        inf.num_values = tg.num_values;
        if (raw == tg.mask) {
          if (CountBitsSet(tg.mask) > 1) {
            const VarLen vl = ReadVarLen(rec.data(), rec.size(), pos);
            if (vl.length == 0) return false;
            inf.use_bytes = true;
            inf.value_bytes = vl.value;
            pos += vl.length;
          } else {
            inf.value_count = 1;
          }
        } else {
          inf.value_count = static_cast<uint32_t>(raw >> CountUnsetEnd(tg.mask));
        }
        infos.push_back(inf);
      }
      for (const auto& inf : infos) {
        std::vector<uint32_t> values;
        if (!inf.use_bytes) {
          const uint32_t n = inf.value_count * inf.num_values;
          for (uint32_t k = 0; k < n; ++k) {
            const VarLen vl = ReadVarLen(rec.data(), rec.size(), pos);
            if (vl.length == 0) return false;
            values.push_back(vl.value);
            pos += vl.length;
          }
        } else {
          uint32_t counted = 0;
          while (counted < inf.value_bytes) {
            const VarLen vl = ReadVarLen(rec.data(), rec.size(), pos);
            if (vl.length == 0) return false;
            values.push_back(vl.value);
            pos += vl.length;
            counted += static_cast<uint32_t>(vl.length);
          }
        }
        row.tag_map[inf.tag] = std::move(values);
      }
      table->push_back(std::move(row));
    }
  }
  return !table->empty();
}

bool LooksLikeMarkup(const std::vector<uint8_t>& slice) {
  const std::string s(reinterpret_cast<const char*>(slice.data()), slice.size());
  return IContains(s, "<html") || IContains(s, "<body") || IContains(s, "<p") ||
         IContains(s, "<div") || IContains(s, "<img") || IContains(s, "<svg") ||
         IContains(s, "recindex");
}

void AppendSliceParts(MobiBook* b, size_t start, size_t end) {
  if (!b || end <= start || start > b->raw_text.size()) return;
  if (end > b->raw_text.size()) end = b->raw_text.size();
  std::vector<uint8_t> slice(b->raw_text.begin() + static_cast<std::ptrdiff_t>(start),
                             b->raw_text.begin() + static_cast<std::ptrdiff_t>(end));
  const auto ranges = SplitPagebreaks(slice);
  for (const auto& pr : ranges) {
    std::vector<uint8_t> part(slice.begin() + static_cast<std::ptrdiff_t>(pr.first),
                              slice.begin() + static_cast<std::ptrdiff_t>(pr.second));
    b->html_parts.push_back(ToUtf8(part, b->hdr.encoding));
  }
}

bool TryKf8Skel(MobiBook* b) {
  if (!b->hdr.kf8) return false;
  if (!ValidRecIndex(b->hdr.skel, b->start, b->pdb.NumRecords()) ||
      !ValidRecIndex(b->hdr.frag, b->start, b->pdb.NumRecords())) {
    return false;
  }
  std::vector<IndxRow> skel_rows;
  std::vector<IndxRow> frag_rows;
  if (!ParseIndexData(&b->pdb, b->start, b->hdr.skel, &skel_rows)) return false;
  if (!ParseIndexData(&b->pdb, b->start, b->hdr.frag, &frag_rows)) return false;

  size_t frag_i = 0;
  for (const auto& skel : skel_rows) {
    const uint32_t num_frag = TagVal(skel, 1, 0);
    const uint32_t skel_off = TagVal(skel, 6, 0);
    const uint32_t skel_len = TagVal(skel, 6, 1);
    if (frag_i + num_frag > frag_rows.size()) return false;
    uint32_t frag_bytes = 0;
    for (uint32_t f = 0; f < num_frag; ++f) {
      frag_bytes += TagVal(frag_rows[frag_i + f], 6, 1);
    }
    const uint64_t total = static_cast<uint64_t>(skel_len) + frag_bytes;
    if (skel_off > b->raw_text.size() ||
        total > b->raw_text.size() - skel_off) {
      return false;
    }
    std::vector<uint8_t> raw(b->raw_text.begin() + skel_off,
                             b->raw_text.begin() + skel_off +
                                 static_cast<std::ptrdiff_t>(total));
    if (skel_len > raw.size()) return false;
    std::vector<uint8_t> skeleton(raw.begin(), raw.begin() + skel_len);
    for (uint32_t f = 0; f < num_frag; ++f) {
      const IndxRow& fr = frag_rows[frag_i + f];
      const uint32_t insert_at = static_cast<uint32_t>(std::atoi(fr.name.c_str()));
      const uint32_t f_off = TagVal(fr, 6, 0);
      const uint32_t f_len = TagVal(fr, 6, 1);
      if (insert_at < skel_off) return false;
      const uint32_t insert = insert_at - skel_off;
      const uint64_t src = static_cast<uint64_t>(skel_len) + f_off;
      if (src > raw.size() || f_len > raw.size() - src) return false;
      if (insert > skeleton.size()) return false;
      skeleton.insert(skeleton.begin() + insert, raw.begin() + static_cast<std::ptrdiff_t>(src),
                      raw.begin() + static_cast<std::ptrdiff_t>(src + f_len));
    }
    frag_i += num_frag;
    if (num_frag == 0) continue;
    b->html_parts.push_back(ToUtf8(skeleton, b->hdr.encoding));
  }
  return !b->html_parts.empty();
}

bool TryKf8Fdst(MobiBook* b) {
  if (!b->hdr.kf8) return false;
  if (!ValidRecIndex(b->hdr.fdst, b->start, b->pdb.NumRecords())) return false;
  std::string ign_c;
  std::string ign_m;
  std::vector<uint8_t> rec;
  if (!b->pdb.LoadRecord(b->start + b->hdr.fdst, &rec, &ign_c, &ign_m)) {
    return false;
  }
  if (rec.size() < 12 || AtStr(rec, 0, 4) != "FDST") return false;
  uint32_t nent = At32(rec, 8);
  if (b->hdr.num_fdst != 0 && b->hdr.num_fdst < nent) nent = b->hdr.num_fdst;
  if (nent == 0 || nent > 10000) return false;
  std::vector<std::pair<uint32_t, uint32_t>> flows;
  for (uint32_t i = 0; i < nent; ++i) {
    const size_t o = 12 + static_cast<size_t>(i) * 8;
    if (!Have(rec, o, 8)) return false;
    const uint32_t a = Be32(rec.data() + o);
    const uint32_t c = Be32(rec.data() + o + 4);
    if (c > a) flows.emplace_back(a, c);
  }
  if (flows.empty()) return false;
  bool any_markup = false;
  for (const auto& fl : flows) {
    if (fl.second > b->raw_text.size() || fl.first >= fl.second) continue;
    std::vector<uint8_t> slice(b->raw_text.begin() + fl.first,
                               b->raw_text.begin() + fl.second);
    if (LooksLikeMarkup(slice)) {
      any_markup = true;
      AppendSliceParts(b, fl.first, fl.second);
    }
  }
  if (!any_markup) {
    AppendSliceParts(b, flows[0].first, flows[0].second);
  }
  return !b->html_parts.empty();
}

void FillHtmlParts(MobiBook* b) {
  b->html_parts.clear();
  if (TryKf8Skel(b)) {
    DOC_LOGI("mobi kf8 sections=%zu via=skel", b->html_parts.size());
    return;
  }
  b->html_parts.clear();
  if (TryKf8Fdst(b)) {
    DOC_LOGI("mobi kf8 sections=%zu via=fdst", b->html_parts.size());
    return;
  }
  b->html_parts.clear();
  AppendSliceParts(b, 0, b->raw_text.size());
  DOC_LOGI("mobi sections=%zu via=pagebreak", b->html_parts.size());
}

bool LoadResource(MobiBook* b, uint32_t resource_index, std::vector<uint8_t>* out,
                  std::string* err_code, std::string* err_message) {
  if (b->hdr.resource_start == kU32Max) {
    if (err_code) *err_code = kErrNoImages;
    if (err_message) *err_message = "MOBI has no resource records";
    return false;
  }
  const size_t idx = static_cast<size_t>(b->hdr.resource_start) + resource_index;
  return b->pdb.LoadRecord(idx, out, err_code, err_message);
}

int ParseRecindex(const std::string& s) {
  int v = 0;
  bool any = false;
  for (char c : s) {
    if (c >= '0' && c <= '9') {
      v = v * 10 + (c - '0');
      any = true;
    }
  }
  return any ? v : 0;
}

ExtractTextResult FailT(const char* code, const std::string& msg) {
  ExtractTextResult r;
  r.error_code = code;
  r.error_message = msg;
  return r;
}
ExtractImagesResult FailI(const char* code, const std::string& msg) {
  ExtractImagesResult r;
  r.error_code = code;
  r.error_message = msg;
  return r;
}

}  // namespace

ExtractTextResult ExtractMobiText(const DocumentSource& src,
                                  const ExtractOptions& opt) {
  ExtractTextResult r;
  r.format = "mobi";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  MobiBook book;
  if (!OpenBook(src, &book, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  DOC_LOGI("mobi open records=%zu textRec=%u kf8=%d raw=%zu parts=%zu",
           book.pdb.NumRecords(), book.hdr.num_text_records, book.hdr.kf8 ? 1 : 0,
           book.raw_text.size(), book.html_parts.size());
  int utf16 = 0;
  int section_index = 0;
  const int total = static_cast<int>(book.html_parts.size());
  for (size_t i = 0; i < book.html_parts.size(); ++i) {
    if (Cancelled(opt)) return FailT(kErrCancelled, "cancelled");
    Progress(opt, static_cast<int>(i), total, "section");
    const std::string& html = book.html_parts[i];
    const HtmlExtract hx = ExtractHtmlText(
        reinterpret_cast<const uint8_t*>(html.data()), html.size());
    const std::string href = "part-" + std::to_string(section_index);
    DocSection sec;
    sec.section_index = section_index;
    sec.href = href;
    if (HtmlIsImageOnly(hx)) {
      sec.kind = "image";
      r.sections.push_back(sec);
      r.image_only_sections.push_back(sec);
      DOC_LOGI("mobi image-only section=%d", section_index);
    } else {
      sec.kind = "text";
      r.sections.push_back(sec);
      AppendBlocks(&r, hx, section_index, href, &utf16);
    }
    ++section_index;
  }
  Progress(opt, total, total, "done");
  if (r.text.empty()) {
    r.error_code = kErrNoText;
    r.error_message = "No extractable markup text";
    return r;
  }
  r.ok = true;
  return r;
}

ExtractImagesResult ExtractMobiImages(const DocumentSource& src,
                                      const ExtractOptions& opt) {
  ExtractImagesResult r;
  r.format = "mobi";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  MobiBook book;
  if (!OpenBook(src, &book, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  sherpa_onnx::image::DecodeOptions dec;
  dec.maxSide = opt.max_side;
  int section_index = 0;
  const int total = static_cast<int>(book.html_parts.size());
  for (size_t i = 0; i < book.html_parts.size(); ++i) {
    if (Cancelled(opt)) return FailI(kErrCancelled, "cancelled");
    Progress(opt, static_cast<int>(i), total, "section");
    const std::string& html = book.html_parts[i];
    const HtmlExtract hx = ExtractHtmlText(
        reinterpret_cast<const uint8_t*>(html.data()), html.size());
    if (!HtmlIsImageOnly(hx)) {
      ++section_index;
      continue;
    }
    const std::string rec =
        FirstImageRecindex(reinterpret_cast<const uint8_t*>(html.data()),
                           html.size());
    int recindex = ParseRecindex(rec);
    if (recindex <= 0) recindex = 1;
    std::vector<uint8_t> bytes;
    if (!LoadResource(&book, static_cast<uint32_t>(recindex - 1), &bytes,
                      &err_code, &err_msg)) {
      DOC_LOGI("mobi recindex %d missing", recindex);
      ++section_index;
      continue;
    }
    auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
        bytes.data(), bytes.size(), dec);
    if (!decoded.ok) {
      DOC_LOGI("mobi decode skip recindex=%d %s", recindex,
               decoded.errorCode.c_str());
      ++section_index;
      continue;
    }
    DocImageFrame fr;
    fr.rgb = std::move(decoded.frame);
    fr.section_index = section_index;
    fr.href = "recindex:" + std::to_string(recindex);
    r.frames.push_back(std::move(fr));
    ++section_index;
  }
  Progress(opt, total, total, "done");
  if (r.frames.empty()) {
    r.error_code = kErrNoImages;
    r.error_message = "No image-only sections";
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace document
}  // namespace sherpa_onnx
