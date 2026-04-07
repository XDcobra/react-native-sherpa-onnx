/**
 * sherpa-onnx-archive-helper.cpp
 *
 * Extracts .tar.bz2 / .tar.zst / .tar.gz / .tar.xz archives to a target
 * directory with resumable extraction support and per-operation cancellation.
 * Computes SHA-256 of the archive during extraction.
 */
#include "sherpa-onnx-archive-helper.h"

#ifdef HAVE_LIBARCHIVE
#include <archive.h>
#include <archive_entry.h>
#endif
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <filesystem>
#include <cstdio>
#include "crypto/sha256.h"

// ── Cancel state ─────────────────────────────────────────────────

std::mutex ArchiveHelper::cancel_mutex_;
std::set<std::string> ArchiveHelper::cancelled_operations_;

void ArchiveHelper::CancelOperation(const std::string& operation_id) {
  std::lock_guard<std::mutex> lock(cancel_mutex_);
  cancelled_operations_.insert(operation_id);
}

bool ArchiveHelper::IsOperationCancelled(const std::string& operation_id) {
  std::lock_guard<std::mutex> lock(cancel_mutex_);
  return cancelled_operations_.count(operation_id) > 0;
}

void ArchiveHelper::ClearCancelFlag(const std::string& operation_id) {
  std::lock_guard<std::mutex> lock(cancel_mutex_);
  cancelled_operations_.erase(operation_id);
}

// ── Helpers ──────────────────────────────────────────────────────

namespace {

static std::string ToHex(const unsigned char* data, size_t size) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) {
    unsigned char value = data[i];
    out.push_back(kHex[value >> 4]);
    out.push_back(kHex[value & 0x0F]);
  }
  return out;
}

#ifdef HAVE_LIBARCHIVE

// ── File-based read context ─────────────────────────────────────

struct FileReadContext {
  FILE* file = nullptr;
  std::array<unsigned char, 64 * 1024> buffer{};
  Sha256Context sha_ctx{};
  long long bytes_read = 0;
};

static la_ssize_t FileReadCallback(struct archive* archive, void* client_data, const void** buff) {
  auto* ctx = static_cast<FileReadContext*>(client_data);
  if (!ctx || !ctx->file) {
    archive_set_error(archive, EINVAL, "Invalid read context");
    return -1;
  }
  size_t bytes = fread(ctx->buffer.data(), 1, ctx->buffer.size(), ctx->file);
  if (bytes > 0) {
    sha256_update(&ctx->sha_ctx, ctx->buffer.data(), bytes);
    ctx->bytes_read += static_cast<long long>(bytes);
    *buff = ctx->buffer.data();
    return static_cast<la_ssize_t>(bytes);
  }
  if (feof(ctx->file)) return 0;
  archive_set_error(archive, errno, "Read error");
  return -1;
}

static int FileCloseCallback(struct archive*, void*) { return ARCHIVE_OK; }

static void DrainRemainingAndClose(FileReadContext* ctx) {
  if (!ctx || !ctx->file) return;
  size_t bytes = 0;
  while ((bytes = fread(ctx->buffer.data(), 1, ctx->buffer.size(), ctx->file)) > 0) {
    sha256_update(&ctx->sha_ctx, ctx->buffer.data(), bytes);
    ctx->bytes_read += static_cast<long long>(bytes);
  }
  fclose(ctx->file);
  ctx->file = nullptr;
}

// ── Stream-based read context ───────────────────────────────────

struct StreamReadContext {
  std::array<unsigned char, 64 * 1024> buffer{};
  Sha256Context sha_ctx{};
  long long bytes_read = 0;
  ArchiveHelper::StreamReadCallback read_cb = nullptr;
  void* user_data = nullptr;
};

/** Libarchive read callback; must not share a name with ArchiveHelper::StreamReadCallback (type alias). */
static la_ssize_t LibarchiveStreamRead(struct archive* archive, void* client_data, const void** buff) {
  auto* ctx = static_cast<StreamReadContext*>(client_data);
  if (!ctx || !ctx->read_cb) {
    archive_set_error(archive, EINVAL, "Invalid stream read context");
    return -1;
  }
  std::ptrdiff_t n = ctx->read_cb(ctx->buffer.data(), ctx->buffer.size(), ctx->user_data);
  if (n > 0) {
    sha256_update(&ctx->sha_ctx, ctx->buffer.data(), static_cast<size_t>(n));
    ctx->bytes_read += static_cast<long long>(n);
    *buff = ctx->buffer.data();
    return static_cast<la_ssize_t>(n);
  }
  if (n == 0) return 0;
  archive_set_error(archive, EINVAL, "Stream read error");
  return -1;
}

static int LibarchiveStreamClose(struct archive*, void*) { return ARCHIVE_OK; }

// ── Shared extraction core ──────────────────────────────────────

/**
 * Core extraction loop shared by file and stream extraction.
 * archive/disk must already be opened. Caller is responsible for cleanup.
 */
static ExtractionResult ExtractEntries(
    struct archive* archive,
    struct archive* disk,
    const std::string& target_path,
    const std::string& canonical_target,
    long long total_bytes,
    int skip_entries,
    ArchiveHelper::ProgressCallback on_progress,
    const std::string& operation_id,
    // Lambda to get compressed bytes read so far (differs for file vs stream)
    std::function<long long()> get_bytes_read) {

  ExtractionResult result;
  struct archive_entry* entry = nullptr;
  int r = ARCHIVE_OK;
  long long extracted_bytes = 0;
  int entry_index = 0;
  int last_percent = -1;
  long long last_emit_bytes = 0;

  while ((r = archive_read_next_header(archive, &entry)) == ARCHIVE_OK) {
    // ── Cancel check ──
    if (ArchiveHelper::IsOperationCancelled(operation_id)) {
      result.paused = true;
      // After resume skip, last_entry_index is still -1 until we finish an entry; last fully done is
      // entry_index - 1 (header for `entry_index` not processed yet).
      if (entry_index > 0) {
        result.last_entry_index =
            std::max(result.last_entry_index, entry_index - 1);
      }
      return result;
    }

    // ── Skip phase (resume) ──
    if (entry_index < skip_entries) {
      archive_read_data_skip(archive);

      // Report skip progress so JS knows we're working
      if (on_progress && total_bytes > 0) {
        long long compressed_bytes = get_bytes_read();
        int percent = static_cast<int>((compressed_bytes * 100) / total_bytes);
        percent = std::clamp(percent, 0, 100);
        if (percent != last_percent) {
          last_percent = percent;
          on_progress(compressed_bytes, total_bytes, static_cast<double>(percent), entry_index);
        }
      }

      entry_index++;
      continue;
    }

    // ── Get entry path ──
    const char* current_path = archive_entry_pathname(entry);
    if (!current_path) {
      result.error = "Invalid entry path";
      return result;
    }

    std::string entry_path(current_path);
    std::string full_path = target_path;
    if (full_path.back() != '/') full_path += '/';
    full_path += entry_path;

    // ── Security: path traversal check ──
    std::string canonical_entry;
    try {
      std::filesystem::path p(full_path);
      std::filesystem::path parent = p.parent_path();
      if (std::filesystem::exists(parent)) {
        canonical_entry = std::filesystem::canonical(parent).string();
      } else {
        while (!std::filesystem::exists(parent) && parent != parent.parent_path()) {
          parent = parent.parent_path();
        }
        if (std::filesystem::exists(parent)) {
          canonical_entry = std::filesystem::canonical(parent).string();
        } else {
          canonical_entry = canonical_target;
        }
      }
      canonical_entry += '/';
      canonical_entry += p.filename().string();
    } catch (const std::exception&) {
      canonical_entry = full_path;
    }

    if (canonical_entry.find(canonical_target) != 0) {
      result.error = "Blocked path traversal: " + entry_path;
      return result;
    }

    // ── Write header ──
    archive_entry_set_pathname(entry, full_path.c_str());
    r = archive_write_header(disk, entry);
    if (r != ARCHIVE_OK) {
      const char* err = archive_error_string(disk);
      result.error = err ? std::string("Failed to write entry: ") + err : "Failed to write entry";
      return result;
    }

    // ── Write data blocks ──
    const void* buff = nullptr;
    size_t size = 0;
    la_int64_t offset = 0;

    while ((r = archive_read_data_block(archive, &buff, &size, &offset)) == ARCHIVE_OK) {
      if (ArchiveHelper::IsOperationCancelled(operation_id)) {
        result.paused = true;
        // Same as header pause: last fully extracted index is entry_index - 1 (current entry incomplete).
        if (entry_index > 0) {
          result.last_entry_index =
              std::max(result.last_entry_index, entry_index - 1);
        }
        return result;
      }

      r = archive_write_data_block(disk, buff, size, offset);
      if (r != ARCHIVE_OK) {
        const char* err = archive_error_string(disk);
        result.error = err ? std::string("Failed to write data: ") + err : "Failed to write data";
        return result;
      }

      extracted_bytes += static_cast<long long>(size);

      // ── Progress ──
      if (on_progress) {
        if (total_bytes > 0) {
          long long compressed_bytes = get_bytes_read();
          int percent = static_cast<int>((compressed_bytes * 100) / total_bytes);
          percent = std::clamp(percent, 0, 100);
          if (percent != last_percent) {
            last_percent = percent;
            on_progress(compressed_bytes, total_bytes, static_cast<double>(percent), entry_index);
          }
        } else if (extracted_bytes - last_emit_bytes >= 1024 * 1024) {
          last_emit_bytes = extracted_bytes;
          on_progress(extracted_bytes, total_bytes, 0.0, entry_index);
        }
      }
    }

    if (r != ARCHIVE_EOF && r != ARCHIVE_OK) {
      const char* err = archive_error_string(archive);
      result.error = err ? std::string("Failed to read data: ") + err : "Failed to read data";
      return result;
    }

    r = archive_write_finish_entry(disk);
    if (r != ARCHIVE_OK && r != ARCHIVE_WARN) {
      const char* err = archive_error_string(disk);
      result.error = err ? std::string("Failed to finish entry: ") + err : "Failed to finish entry";
      return result;
    }

    // ── Mark entry as fully extracted ──
    result.last_entry_index = entry_index;
    result.last_entry_path = entry_path;
    entry_index++;
  }

  result.success = true;
  result.bytes_extracted = extracted_bytes;

  // Final progress: report uncompressed size so JS can store sizeOnDisk
  if (on_progress) {
    on_progress(extracted_bytes, extracted_bytes, 100.0, entry_index - 1);
  }

  return result;
}

// ── Archive setup helper ────────────────────────────────────────

static void ConfigureArchiveFormats(struct archive* a) {
  archive_read_support_format_tar(a);
  archive_read_support_filter_bzip2(a);
  archive_read_support_filter_gzip(a);
  archive_read_support_filter_xz(a);
  archive_read_support_filter_zstd(a);
}

static struct archive* CreateDiskWriter() {
  struct archive* disk = archive_write_disk_new();
  if (disk) {
    archive_write_disk_set_options(disk,
        ARCHIVE_EXTRACT_TIME |
        ARCHIVE_EXTRACT_PERM |
        ARCHIVE_EXTRACT_ACL |
        ARCHIVE_EXTRACT_FFLAGS);
    archive_write_disk_set_standard_lookup(disk);
  }
  return disk;
}

#endif  // HAVE_LIBARCHIVE
}  // namespace

// ── Public API — file-based extraction ──────────────────────────

ExtractionResult ArchiveHelper::Extract(
    const std::string& source_path,
    const std::string& target_path,
    bool force,
    int skip_entries,
    ProgressCallback on_progress,
    const std::string& operation_id) {

  ClearCancelFlag(operation_id);
  ExtractionResult result;

#ifndef HAVE_LIBARCHIVE
  (void)source_path; (void)target_path; (void)force;
  (void)skip_entries; (void)on_progress; (void)operation_id;
  result.error = "libarchive not available. Build with libarchive or set "
                 "sherpaOnnxDisableLibarchive=false in gradle.properties. "
                 "See docs/disable-libarchive.md.";
  return result;
#else
  // ── Validate source ──
  if (!std::filesystem::exists(source_path)) {
    result.error = "Source file does not exist";
    return result;
  }

  // ── Prepare target directory ──
  if (std::filesystem::exists(target_path)) {
    if (std::filesystem::is_directory(target_path)) {
      // Merge: extract into existing directory (supports resume)
    } else if (force) {
      std::error_code ec;
      std::filesystem::remove_all(target_path, ec);
      if (ec) {
        result.error = "Failed to remove target path: " + ec.message();
        return result;
      }
    } else {
      result.error = "Target path already exists";
      return result;
    }
  }

  std::error_code ec;
  std::filesystem::create_directories(target_path, ec);
  if (ec) {
    result.error = "Failed to create target directory: " + ec.message();
    return result;
  }

  std::string canonical_target = std::filesystem::canonical(target_path).string();
  if (canonical_target.back() != '/') canonical_target += '/';

  // ── Get archive file size ──
  long long total_bytes = 0;
  try {
    total_bytes = std::filesystem::file_size(source_path);
  } catch (const std::exception& e) {
    result.error = std::string("Failed to get file size: ") + e.what();
    return result;
  }

  // ── Open archive ──
  struct archive* archive = archive_read_new();
  if (!archive) {
    result.error = "Failed to create archive reader";
    return result;
  }

  ConfigureArchiveFormats(archive);

  FileReadContext read_ctx;
  read_ctx.file = fopen(source_path.c_str(), "rb");
  if (!read_ctx.file) {
    result.error = std::string("Failed to open archive file: ") + std::strerror(errno);
    archive_read_free(archive);
    return result;
  }
  sha256_init(&read_ctx.sha_ctx);

  if (archive_read_open(archive, &read_ctx, nullptr, FileReadCallback, FileCloseCallback) != ARCHIVE_OK) {
    const char* err = archive_error_string(archive);
    result.error = err ? std::string("Failed to open archive: ") + err : "Failed to open archive";
    DrainRemainingAndClose(&read_ctx);
    archive_read_free(archive);
    return result;
  }

  struct archive* disk = CreateDiskWriter();
  if (!disk) {
    result.error = "Failed to create disk writer";
    DrainRemainingAndClose(&read_ctx);
    archive_read_free(archive);
    return result;
  }

  // ── Extract ──
  auto get_bytes_read = [&archive]() -> long long {
    return archive_filter_bytes(archive, -1);
  };

  result = ExtractEntries(
      archive, disk, target_path, canonical_target, total_bytes,
      skip_entries, on_progress, operation_id, get_bytes_read);

  archive_read_free(archive);
  archive_write_free(disk);

  // ── Finalize SHA-256 ──
  if (result.success) {
    DrainRemainingAndClose(&read_ctx);
    unsigned char digest[32];
    sha256_final(&read_ctx.sha_ctx, digest);
    result.sha256 = ToHex(digest, sizeof(digest));
  } else {
    // Still close the file
    if (read_ctx.file) {
      fclose(read_ctx.file);
      read_ctx.file = nullptr;
    }
  }

  return result;
#endif  // HAVE_LIBARCHIVE
}

// ── Public API — stream-based extraction ────────────────────────

ExtractionResult ArchiveHelper::ExtractFromStream(
    StreamReadCallback read_cb,
    void* read_user_data,
    const std::string& target_path,
    bool force,
    int skip_entries,
    ProgressCallback on_progress,
    const std::string& operation_id) {

  ClearCancelFlag(operation_id);
  ExtractionResult result;

#ifndef HAVE_LIBARCHIVE
  (void)read_cb; (void)read_user_data; (void)target_path; (void)force;
  (void)skip_entries; (void)on_progress; (void)operation_id;
  result.error = "libarchive not available. Build with libarchive or set "
                 "sherpaOnnxDisableLibarchive=false in gradle.properties. "
                 "See docs/disable-libarchive.md.";
  return result;
#else
  if (!read_cb) {
    result.error = "Stream read callback is null";
    return result;
  }

  // ── Prepare target directory ──
  if (std::filesystem::exists(target_path)) {
    if (std::filesystem::is_directory(target_path)) {
      // Merge
    } else if (force) {
      std::error_code ec;
      std::filesystem::remove_all(target_path, ec);
      if (ec) {
        result.error = "Failed to remove target path: " + ec.message();
        return result;
      }
    } else {
      result.error = "Target path already exists";
      return result;
    }
  }

  std::error_code ec;
  std::filesystem::create_directories(target_path, ec);
  if (ec) {
    result.error = "Failed to create target directory: " + ec.message();
    return result;
  }

  std::string canonical_target = std::filesystem::canonical(target_path).string();
  if (canonical_target.back() != '/') canonical_target += '/';

  // ── Open archive from stream ──
  struct archive* archive = archive_read_new();
  if (!archive) {
    result.error = "Failed to create archive reader";
    return result;
  }

  ConfigureArchiveFormats(archive);

  StreamReadContext stream_ctx;
  stream_ctx.read_cb = read_cb;
  stream_ctx.user_data = read_user_data;
  sha256_init(&stream_ctx.sha_ctx);

  if (archive_read_open(archive, &stream_ctx, nullptr, LibarchiveStreamRead, LibarchiveStreamClose) !=
      ARCHIVE_OK) {
    const char* err = archive_error_string(archive);
    result.error = err ? std::string("Failed to open archive: ") + err : "Failed to open archive";
    archive_read_free(archive);
    return result;
  }

  struct archive* disk = CreateDiskWriter();
  if (!disk) {
    result.error = "Failed to create disk writer";
    archive_read_free(archive);
    return result;
  }

  // ── Extract ──
  auto get_bytes_read = [&stream_ctx]() -> long long {
    return stream_ctx.bytes_read;
  };

  result = ExtractEntries(
      archive, disk, target_path, canonical_target, 0 /* total unknown */,
      skip_entries, on_progress, operation_id, get_bytes_read);

  archive_read_free(archive);
  archive_write_free(disk);

  // ── Finalize SHA-256 ──
  if (result.success) {
    unsigned char digest[32];
    sha256_final(&stream_ctx.sha_ctx, digest);
    result.sha256 = ToHex(digest, sizeof(digest));
  }

  return result;
#endif  // HAVE_LIBARCHIVE
}

// ── Public API — SHA-256 ────────────────────────────────────────

bool ArchiveHelper::ComputeFileSha256(
    const std::string& file_path,
    std::string* out_error,
    std::string* out_sha256) {
  if (!std::filesystem::exists(file_path)) {
    if (out_error) *out_error = "File does not exist";
    return false;
  }

  FILE* file = fopen(file_path.c_str(), "rb");
  if (!file) {
    if (out_error) *out_error = std::string("Failed to open file: ") + std::strerror(errno);
    return false;
  }

  Sha256Context ctx;
  sha256_init(&ctx);
  std::array<unsigned char, 64 * 1024> buffer{};

  size_t bytes = 0;
  while ((bytes = fread(buffer.data(), 1, buffer.size(), file)) > 0) {
    sha256_update(&ctx, buffer.data(), bytes);
  }

  if (ferror(file)) {
    if (out_error) *out_error = "Read error while hashing file";
    fclose(file);
    return false;
  }

  fclose(file);

  unsigned char digest[32];
  sha256_final(&ctx, digest);
  if (out_sha256) {
    *out_sha256 = ToHex(digest, sizeof(digest));
  }

  return true;
}
