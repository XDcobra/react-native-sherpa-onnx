#include "sherpa-onnx-archive-helper.h"

#include <archive.h>
#include <archive_entry.h>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <filesystem>
#include <android/log.h>

// TAG is defined but may not be used depending on logging configuration

// Global cancellation flag
volatile bool ArchiveHelper::cancel_requested_ = false;

bool ArchiveHelper::IsCancelled() {
  return cancel_requested_;
}

void ArchiveHelper::Cancel() {
  cancel_requested_ = true;
}

bool ArchiveHelper::ExtractTarBz2(
    const std::string& source_path,
    const std::string& target_path,
    bool force,
    std::function<void(long long, long long, double)> on_progress,
    std::string* out_error) {
  cancel_requested_ = false;

  // Validate source file exists
  if (!std::filesystem::exists(source_path)) {
    if (out_error) *out_error = "Source file does not exist";
    return false;
  }

  // Check target directory
  if (std::filesystem::exists(target_path)) {
    if (force) {
      std::error_code ec;
      std::filesystem::remove_all(target_path, ec);
      if (ec) {
        if (out_error) *out_error = "Failed to remove target directory: " + ec.message();
        return false;
      }
    } else {
      if (out_error) *out_error = "Target path already exists";
      return false;
    }
  }

  // Create target directory
  std::error_code ec;
  std::filesystem::create_directories(target_path, ec);
  if (ec) {
    if (out_error) *out_error = "Failed to create target directory: " + ec.message();
    return false;
  }

  // Get canonical target path for security check
  std::string canonical_target = std::filesystem::canonical(target_path).string();
  if (canonical_target.back() != '/') {
    canonical_target += '/';
  }

  // Get total file size
  long long total_bytes = 0;
  try {
    total_bytes = std::filesystem::file_size(source_path);
  } catch (const std::exception& e) {
    if (out_error) *out_error = std::string("Failed to get file size: ") + e.what();
    return false;
  }

  // Open archive for reading
  struct archive* archive = archive_read_new();
  if (!archive) {
    if (out_error) *out_error = "Failed to create archive reader";
    return false;
  }

  // Configure archive to support tar and bzip2
  archive_read_support_format_tar(archive);
  archive_read_support_filter_bzip2(archive);
  archive_read_support_filter_gzip(archive);  // Also support gzip for compatibility
  archive_read_support_filter_xz(archive);    // And xz

  // Open source file
  if (archive_read_open_filename(archive, source_path.c_str(), 65536) != ARCHIVE_OK) {
    const char* err = archive_error_string(archive);
    if (out_error) {
      *out_error = err ? std::string("Failed to open archive: ") + err : "Failed to open archive";
    }
    archive_read_free(archive);
    return false;
  }

  // Create disk writer
  struct archive* disk = archive_write_disk_new();
  if (!disk) {
    if (out_error) *out_error = "Failed to create disk writer";
    archive_read_free(archive);
    return false;
  }

  archive_write_disk_set_options(disk,
                                  ARCHIVE_EXTRACT_TIME |
                                  ARCHIVE_EXTRACT_PERM |
                                  ARCHIVE_EXTRACT_ACL |
                                  ARCHIVE_EXTRACT_FFLAGS);
  archive_write_disk_set_standard_lookup(disk);

  // Extract entries
  struct archive_entry* entry = nullptr;
  int result = ARCHIVE_OK;
  long long extracted_bytes = 0;
  int last_percent = -1;
  long long last_emit_bytes = 0;

  while ((result = archive_read_next_header(archive, &entry)) == ARCHIVE_OK) {
    if (cancel_requested_) {
      if (out_error) *out_error = "Extraction cancelled";
      archive_read_free(archive);
      archive_write_free(disk);
      return false;
    }

    // Get entry path and construct full path
    const char* current_path = archive_entry_pathname(entry);
    if (!current_path) {
      archive_read_free(archive);
      archive_write_free(disk);
      if (out_error) *out_error = "Invalid entry path";
      return false;
    }

    std::string entry_path(current_path);
    std::string full_path = target_path;
    if (full_path.back() != '/') full_path += '/';
    full_path += entry_path;

    // Security check: ensure path doesn't escape target directory
    std::string canonical_entry;
    try {
      // For entries that don't exist yet, canonicalize the parent directory
      std::filesystem::path p(full_path);
      std::filesystem::path parent = p.parent_path();
      
      if (std::filesystem::exists(parent)) {
        canonical_entry = std::filesystem::canonical(parent).string();
      } else {
        // Try to canonicalize as much as possible
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

    // Check if the canonical path is within target
    if (canonical_entry.find(canonical_target) != 0) {
      archive_read_free(archive);
      archive_write_free(disk);
      if (out_error) *out_error = "Blocked path traversal: " + entry_path;
      return false;
    }

    // Set the pathname for extraction
    archive_entry_set_pathname(entry, full_path.c_str());

    // Write header
    result = archive_write_header(disk, entry);
    if (result != ARCHIVE_OK) {
      const char* err = archive_error_string(disk);
      if (out_error) {
        *out_error = err ? std::string("Failed to write entry: ") + err : "Failed to write entry";
      }
      archive_read_free(archive);
      archive_write_free(disk);
      return false;
    }

    // Write data
    const void* buff = nullptr;
    size_t size = 0;
    la_int64_t offset = 0;

    while ((result = archive_read_data_block(archive, &buff, &size, &offset)) == ARCHIVE_OK) {
      if (cancel_requested_) {
        if (out_error) *out_error = "Extraction cancelled";
        archive_read_free(archive);
        archive_write_free(disk);
        return false;
      }

      result = archive_write_data_block(disk, buff, size, offset);
      if (result != ARCHIVE_OK) {
        const char* err = archive_error_string(disk);
        if (out_error) {
          *out_error = err ? std::string("Failed to write data: ") + err : "Failed to write data";
        }
        archive_read_free(archive);
        archive_write_free(disk);
        return false;
      }

      extracted_bytes += static_cast<long long>(size);

      // Progress callback
      if (on_progress) {
        if (total_bytes > 0) {
          // Use bytes read from source (filter -1) to align with archive file size.
          long long compressed_bytes = archive_filter_bytes(archive, -1);
          int percent = static_cast<int>((compressed_bytes * 100) / total_bytes);
          if (percent > 100) {
            percent = 100;
          } else if (percent < 0) {
            percent = 0;
          }
          
          if (percent != last_percent) {
            last_percent = percent;
            on_progress(compressed_bytes, total_bytes, static_cast<double>(percent));
          }
        } else if (extracted_bytes - last_emit_bytes >= 1024 * 1024) {
          // If total_bytes unknown, emit every 1MB
          last_emit_bytes = extracted_bytes;
          on_progress(extracted_bytes, total_bytes, 0.0);
        }
      }
    }

    if (result != ARCHIVE_EOF && result != ARCHIVE_OK) {
      const char* err = archive_error_string(archive);
      if (out_error) {
        *out_error = err ? std::string("Failed to read data: ") + err : "Failed to read data";
      }
      archive_read_free(archive);
      archive_write_free(disk);
      return false;
    }
  }

  archive_read_free(archive);
  archive_write_free(disk);

  // Final progress
  if (on_progress && total_bytes > 0) {
    on_progress(total_bytes, total_bytes, 100.0);
  }

  return true;
}
