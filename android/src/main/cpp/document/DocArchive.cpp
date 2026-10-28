#include "DocArchive.h"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>

#ifdef HAVE_LIBARCHIVE
#include <archive.h>
#include <archive_entry.h>
#endif

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

std::string JoinErr(const char* prefix, const char* detail) {
  std::string s = prefix ? prefix : "";
  if (detail && *detail) {
    if (!s.empty()) s += ": ";
    s += detail;
  }
  return s;
}

}  // namespace

std::string NormalizeArchivePath(std::string name) {
  std::replace(name.begin(), name.end(), '\\', '/');
  while (name.size() >= 2 && name[0] == '.' && name[1] == '/') {
    name.erase(0, 2);
  }
  while (!name.empty() && name[0] == '/') {
    name.erase(0, 1);
  }
  return name;
}

bool ReadSourcePrefix(const DocumentSource& src, uint8_t* buf, size_t n,
                      size_t* got, std::string* err_code,
                      std::string* err_message) {
  if (got) *got = 0;
  if (!buf || n == 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "empty prefix buffer";
    return false;
  }
  if (!src.path.empty()) {
    const int fd = ::open(src.path.c_str(), O_RDONLY);
    if (fd < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) {
        *err_message = JoinErr("Failed to open file", std::strerror(errno));
      }
      return false;
    }
    const ssize_t r = ::read(fd, buf, n);
    ::close(fd);
    if (r < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Failed to read file prefix";
      return false;
    }
    if (got) *got = static_cast<size_t>(r);
    return true;
  }
  if (src.fd >= 0) {
    const off_t pos = ::lseek(src.fd, 0, SEEK_CUR);
    if (pos < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Source is not seekable";
      return false;
    }
    if (::lseek(src.fd, 0, SEEK_SET) < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Source is not seekable";
      return false;
    }
    const ssize_t r = ::read(src.fd, buf, n);
    ::lseek(src.fd, pos, SEEK_SET);
    if (r < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Failed to read fd prefix";
      return false;
    }
    if (got) *got = static_cast<size_t>(r);
    return true;
  }
  if (err_code) *err_code = kErrInvalidArgument;
  if (err_message) *err_message = "Document source must be a path or seekable fd";
  return false;
}

ArchiveReader::~ArchiveReader() = default;

ArchiveReader::ArchiveReader(ArchiveReader&& other) noexcept
    : src_(std::move(other.src_)),
      catalog_(std::move(other.catalog_)),
      claimed_uncompressed_(other.claimed_uncompressed_) {
  other.claimed_uncompressed_ = 0;
}

ArchiveReader& ArchiveReader::operator=(ArchiveReader&& other) noexcept {
  if (this != &other) {
    src_ = std::move(other.src_);
    catalog_ = std::move(other.catalog_);
    claimed_uncompressed_ = other.claimed_uncompressed_;
    other.claimed_uncompressed_ = 0;
  }
  return *this;
}

#ifndef HAVE_LIBARCHIVE

bool ArchiveReader::Open(const DocumentSource&, ArchiveReader*,
                         std::string* err_code, std::string* err_message) {
  if (err_code) *err_code = kErrArchiveDisabled;
  if (err_message) {
    *err_message =
        "libarchive is not linked. Rebuild without sherpaOnnxDisableLibarchive "
        "/ SHERPA_ONNX_DISABLE_LIBARCHIVE.";
  }
  return false;
}

bool ArchiveReader::HasEntry(const std::string&) const { return false; }

bool ArchiveReader::ReadNamed(const std::string&, std::vector<uint8_t>*,
                              std::string* err_code, std::string* err_message) {
  if (err_code) *err_code = kErrArchiveDisabled;
  if (err_message) *err_message = "libarchive is not linked";
  return false;
}

bool ArchiveReader::ReadIndex(size_t, std::vector<uint8_t>*,
                              std::string* err_code, std::string* err_message) {
  if (err_code) *err_code = kErrArchiveDisabled;
  if (err_message) *err_message = "libarchive is not linked";
  return false;
}

bool ArchiveReader::LoadCatalog(std::string*, std::string*) { return false; }
bool ArchiveReader::OpenFresh(void**, std::string*, std::string*) {
  return false;
}
void ArchiveReader::CloseFresh(void*) {}

#else  // HAVE_LIBARCHIVE

bool ArchiveReader::OpenFresh(void** archive_out, std::string* err_code,
                              std::string* err_message) {
  if (!archive_out) return false;
  archive* a = archive_read_new();
  if (!a) {
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) *err_message = "archive_read_new failed";
    return false;
  }
  archive_read_support_format_zip(a);
  archive_read_support_format_rar(a);
  archive_read_support_format_rar5(a);

  int rc = ARCHIVE_FATAL;
  if (!src_.path.empty()) {
    rc = archive_read_open_filename(a, src_.path.c_str(), 1024 * 64);
  } else if (src_.fd >= 0) {
    if (::lseek(src_.fd, 0, SEEK_SET) < 0) {
      archive_read_free(a);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Source is not seekable";
      return false;
    }
    rc = archive_read_open_fd(a, src_.fd, 1024 * 64);
  } else {
    archive_read_free(a);
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "Document source must be a path or seekable fd";
    return false;
  }
  if (rc != ARCHIVE_OK) {
    const char* d = archive_error_string(a);
    archive_read_free(a);
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) {
      *err_message = JoinErr("Failed to open archive", d);
    }
    return false;
  }
  *archive_out = a;
  return true;
}

void ArchiveReader::CloseFresh(void* archive_ptr) {
  if (!archive_ptr) return;
  archive_read_free(static_cast<archive*>(archive_ptr));
}

bool ArchiveReader::LoadCatalog(std::string* err_code,
                                std::string* err_message) {
  catalog_.clear();
  claimed_uncompressed_ = 0;
  void* raw = nullptr;
  if (!OpenFresh(&raw, err_code, err_message)) return false;
  archive* a = static_cast<archive*>(raw);

  archive_entry* entry = nullptr;
  int rc;
  while ((rc = archive_read_next_header(a, &entry)) == ARCHIVE_OK) {
    if (static_cast<int>(catalog_.size()) >= kMaxArchiveEntries) {
      CloseFresh(raw);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Archive exceeds 10000 entries";
      return false;
    }
    ArchiveEntryInfo info;
    const char* pathname = archive_entry_pathname(entry);
    info.name = NormalizeArchivePath(pathname ? pathname : "");
    info.size = archive_entry_size_is_set(entry) ? archive_entry_size(entry) : 0;
#if ARCHIVE_VERSION_NUMBER >= 3002000
    info.encrypted = archive_entry_is_encrypted(entry) != 0;
#endif
    if (info.size < 0) info.size = 0;
    if (info.size > kMaxEntryBytes) {
      CloseFresh(raw);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Archive entry exceeds 64 MiB";
      return false;
    }
    claimed_uncompressed_ += info.size;
    if (claimed_uncompressed_ > kMaxUncompressedBytes) {
      CloseFresh(raw);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Archive uncompressed size exceeds 512 MiB";
      return false;
    }
    if (!info.name.empty() && info.name.back() != '/') {
      catalog_.push_back(std::move(info));
    }
    archive_read_data_skip(a);
  }
  if (rc != ARCHIVE_EOF) {
    const char* d = archive_error_string(a);
    CloseFresh(raw);
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) *err_message = JoinErr("Failed to read archive catalog", d);
    return false;
  }
  CloseFresh(raw);
  DOC_LOGI("catalog entries=%zu uncompressed=%lld", catalog_.size(),
           static_cast<long long>(claimed_uncompressed_));
  return true;
}

bool ArchiveReader::Open(const DocumentSource& src, ArchiveReader* out,
                         std::string* err_code, std::string* err_message) {
  if (!out) return false;
  ArchiveReader r;
  r.src_ = src;
  if (!r.LoadCatalog(err_code, err_message)) return false;
  *out = std::move(r);
  return true;
}

bool ArchiveReader::HasEntry(const std::string& name) const {
  const std::string n = NormalizeArchivePath(name);
  for (const auto& e : catalog_) {
    if (e.name == n) return true;
  }
  return false;
}

bool ArchiveReader::ReadIndex(size_t catalog_index, std::vector<uint8_t>* data,
                              std::string* err_code, std::string* err_message) {
  if (!data || catalog_index >= catalog_.size()) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Archive entry not found";
    return false;
  }
  return ReadNamed(catalog_[catalog_index].name, data, err_code, err_message);
}

bool ArchiveReader::ReadNamed(const std::string& name, std::vector<uint8_t>* data,
                              std::string* err_code, std::string* err_message) {
  if (!data) return false;
  const std::string want = NormalizeArchivePath(name);
  void* raw = nullptr;
  if (!OpenFresh(&raw, err_code, err_message)) return false;
  archive* a = static_cast<archive*>(raw);
  archive_entry* entry = nullptr;
  int rc;
  while ((rc = archive_read_next_header(a, &entry)) == ARCHIVE_OK) {
    const char* pathname = archive_entry_pathname(entry);
    const std::string got = NormalizeArchivePath(pathname ? pathname : "");
    if (got != want) {
      archive_read_data_skip(a);
      continue;
    }
#if ARCHIVE_VERSION_NUMBER >= 3002000
    if (archive_entry_is_encrypted(entry)) {
      CloseFresh(raw);
      if (err_code) *err_code = kErrDrm;
      if (err_message) *err_message = "Encrypted archive entry";
      return false;
    }
#endif
    const la_int64_t sz =
        archive_entry_size_is_set(entry) ? archive_entry_size(entry) : 0;
    if (sz > kMaxEntryBytes) {
      CloseFresh(raw);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Archive entry exceeds 64 MiB";
      return false;
    }
    std::vector<uint8_t> buf;
    if (sz > 0) buf.reserve(static_cast<size_t>(sz));
    char tmp[64 * 1024];
    la_ssize_t n = 0;
    int64_t total = 0;
    while ((n = archive_read_data(a, tmp, sizeof(tmp))) > 0) {
      total += n;
      if (total > kMaxEntryBytes) {
        CloseFresh(raw);
        if (err_code) *err_code = kErrOpenFailed;
        if (err_message) *err_message = "Archive entry exceeds 64 MiB";
        return false;
      }
      buf.insert(buf.end(), tmp, tmp + n);
    }
    if (n < 0) {
      const char* d = archive_error_string(a);
      CloseFresh(raw);
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = JoinErr("Failed to read archive entry", d);
      return false;
    }
    CloseFresh(raw);
    *data = std::move(buf);
    return true;
  }
  CloseFresh(raw);
  if (err_code) *err_code = kErrParseFailed;
  if (err_message) *err_message = "Archive entry not found: " + want;
  return false;
}

#endif  // HAVE_LIBARCHIVE

}  // namespace document
}  // namespace sherpa_onnx
