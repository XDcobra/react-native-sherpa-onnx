/**
 * onnx-model-metadata.cpp — see onnx-model-metadata.h.
 */
#include "onnx-model-metadata.h"

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>

namespace sherpaonnx {
namespace model_detect {

namespace {

// ModelProto.metadata_props (repeated StringStringEntryProto).
constexpr uint64_t kMetadataPropsField = 14;
// One metadata entry larger than this is skipped instead of read.
constexpr uint64_t kMaxEntryBytes = 16ull * 1024 * 1024;

enum WireType : uint32_t {
  kVarint = 0,
  kFixed64 = 1,
  kLengthDelimited = 2,
  kFixed32 = 5,
};

/** Bounded reader over an istream (file) or a memory buffer. */
class Reader {
 public:
  Reader(std::istream* in, uint64_t size) : in_(in), size_(size) {}
  Reader(const char* data, uint64_t size) : data_(data), size_(size) {}

  uint64_t pos() const { return pos_; }
  bool atEnd() const { return pos_ >= size_; }

  bool readByte(uint8_t* b) {
    if (pos_ >= size_) return false;
    if (data_ != nullptr) {
      *b = static_cast<uint8_t>(data_[pos_]);
    } else {
      char c = 0;
      if (!in_->get(c)) return false;
      *b = static_cast<uint8_t>(c);
    }
    ++pos_;
    return true;
  }

  bool readVarint(uint64_t* value) {
    uint64_t result = 0;
    for (int shift = 0; shift < 64; shift += 7) {
      uint8_t b = 0;
      if (!readByte(&b)) return false;
      result |= static_cast<uint64_t>(b & 0x7f) << shift;
      if ((b & 0x80) == 0) {
        *value = result;
        return true;
      }
    }
    return false;
  }

  bool skip(uint64_t n) {
    if (n > size_ - pos_) return false;
    if (data_ == nullptr) {
      if (n > static_cast<uint64_t>(std::numeric_limits<std::streamoff>::max())) {
        return false;
      }
      in_->seekg(static_cast<std::streamoff>(n), std::ios::cur);
      if (!*in_) return false;
    }
    pos_ += n;
    return true;
  }

  bool readBytes(uint64_t n, std::string* out) {
    if (n > size_ - pos_) return false;
    out->resize(static_cast<size_t>(n));
    if (n == 0) return true;
    if (data_ != nullptr) {
      std::memcpy(&(*out)[0], data_ + pos_, static_cast<size_t>(n));
    } else if (!in_->read(&(*out)[0], static_cast<std::streamsize>(n))) {
      return false;
    }
    pos_ += n;
    return true;
  }

  /** Skips the value of a field with `wireType`. */
  bool skipValue(uint32_t wireType) {
    uint64_t v = 0;
    switch (wireType) {
      case kVarint:
        return readVarint(&v);
      case kFixed64:
        return skip(8);
      case kLengthDelimited:
        return readVarint(&v) && skip(v);
      case kFixed32:
        return skip(4);
      default:
        return false;  // groups (3/4) are not used by ONNX
    }
  }

 private:
  std::istream* in_ = nullptr;
  const char* data_ = nullptr;
  uint64_t size_ = 0;
  uint64_t pos_ = 0;
};

/** Parses one StringStringEntryProto (1: key, 2: value). */
bool ParseEntry(const std::string& bytes, std::string* key, std::string* value) {
  Reader r(bytes.data(), bytes.size());
  while (!r.atEnd()) {
    uint64_t tag = 0;
    if (!r.readVarint(&tag)) return false;
    const uint64_t field = tag >> 3;
    const uint32_t wireType = static_cast<uint32_t>(tag & 7);
    if ((field == 1 || field == 2) && wireType == kLengthDelimited) {
      uint64_t len = 0;
      if (!r.readVarint(&len)) return false;
      if (!r.readBytes(len, field == 1 ? key : value)) return false;
    } else if (!r.skipValue(wireType)) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool ReadOnnxMetadataProps(const std::string& path,
                           std::unordered_map<std::string, std::string>* out) {
  if (out == nullptr) return false;
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  in.seekg(0, std::ios::end);
  const std::streamoff end = in.tellg();
  if (end <= 0) return false;
  in.seekg(0, std::ios::beg);

  Reader r(&in, static_cast<uint64_t>(end));
  while (!r.atEnd()) {
    uint64_t tag = 0;
    if (!r.readVarint(&tag)) return false;
    const uint64_t field = tag >> 3;
    const uint32_t wireType = static_cast<uint32_t>(tag & 7);
    if (field == 0) return false;
    if (field == kMetadataPropsField && wireType == kLengthDelimited) {
      uint64_t len = 0;
      if (!r.readVarint(&len)) return false;
      if (len > kMaxEntryBytes) {
        if (!r.skip(len)) return false;
        continue;
      }
      std::string bytes;
      if (!r.readBytes(len, &bytes)) return false;
      std::string key;
      std::string value;
      if (!ParseEntry(bytes, &key, &value)) return false;
      if (!key.empty()) (*out)[key] = value;
    } else if (!r.skipValue(wireType)) {
      return false;
    }
  }
  return true;
}

int32_t ReadOnnxMetadataInt(const std::string& path, const std::string& key,
                            int32_t fallback) {
  std::unordered_map<std::string, std::string> props;
  ReadOnnxMetadataProps(path, &props);
  auto it = props.find(key);
  if (it == props.end() || it->second.empty()) return fallback;
  errno = 0;
  char* endPtr = nullptr;
  const long long v = std::strtoll(it->second.c_str(), &endPtr, 10);
  if (errno != 0 || endPtr == it->second.c_str() || *endPtr != '\0' ||
      v < std::numeric_limits<int32_t>::min() ||
      v > std::numeric_limits<int32_t>::max()) {
    return fallback;
  }
  return static_cast<int32_t>(v);
}

int32_t ReadSupertonicVoiceStyleSpeakerCount(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return -1;
  int64_t dims[6] = {0, 0, 0, 0, 0, 0};
  if (!in.read(reinterpret_cast<char*>(dims), sizeof(dims))) return -1;
  for (int64_t d : dims) {
    if (d <= 0) return -1;
  }
  if (dims[0] != dims[3] || dims[0] > std::numeric_limits<int32_t>::max()) {
    return -1;
  }
  return static_cast<int32_t>(dims[0]);
}

}  // namespace model_detect
}  // namespace sherpaonnx
