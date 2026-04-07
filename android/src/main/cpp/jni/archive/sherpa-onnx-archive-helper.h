#pragma once

#include <cstddef>
#include <string>
#include <functional>
#include <mutex>
#include <set>

/**
 * Archive extraction helper using libarchive.
 *
 * Supports .tar.bz2, .tar.zst, .tar.gz, .tar.xz — libarchive auto-detects.
 * Resumable via skip_entries: on resume, headers are read and skipped until
 * the saved entry index, then extraction continues from there.
 */

struct ExtractionResult {
  bool success = false;
  bool paused = false;             // true if stopped by cancel (not error)
  int last_entry_index = -1;       // index of last fully extracted entry
  std::string last_entry_path;     // path of last fully extracted entry
  long long bytes_extracted = 0;
  std::string sha256;              // archive SHA-256 hex (only valid on success)
  std::string error;               // error message (on failure)
};

class ArchiveHelper {
 public:
  /** Callback to read bytes from a stream (e.g. Java InputStream via JNI). */
  using StreamReadCallback = std::ptrdiff_t (*)(void* buf, size_t len, void* user_data);

  /**
   * Progress callback.
   * @param bytes_extracted  Compressed bytes read so far (aligns with archive file size)
   * @param total_bytes      Total archive file size (0 if unknown)
   * @param percent          Progress 0–100
   * @param entry_index      Index of the entry currently being extracted
   */
  using ProgressCallback = std::function<void(long long bytes_extracted, long long total_bytes,
                                               double percent, int entry_index)>;

  /**
   * Extract a tar archive (bz2/zst/gz/xz — auto-detected) to target directory.
   *
   * @param source_path   Path to the archive file
   * @param target_path   Destination directory path
   * @param force         Whether to overwrite existing target directory
   * @param skip_entries  Number of entries to skip (0 = fresh, N = resume after entry N-1)
   * @param on_progress   Progress callback (nullable)
   * @param operation_id  Unique ID for per-operation cancellation
   */
  static ExtractionResult Extract(
      const std::string& source_path,
      const std::string& target_path,
      bool force,
      int skip_entries,
      ProgressCallback on_progress,
      const std::string& operation_id);

  /**
   * Extract a tar archive from a stream (e.g. Android AssetManager).
   * Same semantics as Extract() but reads from a callback instead of a file.
   */
  static ExtractionResult ExtractFromStream(
      StreamReadCallback read_cb,
      void* read_user_data,
      const std::string& target_path,
      bool force,
      int skip_entries,
      ProgressCallback on_progress,
      const std::string& operation_id);

  /**
   * Cancel an ongoing extraction by operation ID.
   * The extraction loop will detect this and return with paused=true.
   */
  static void CancelOperation(const std::string& operation_id);

  /**
   * Check if an operation has been cancelled.
   */
  static bool IsOperationCancelled(const std::string& operation_id);

  /**
   * Clear the cancel flag for an operation (called at start of extraction).
   */
  static void ClearCancelFlag(const std::string& operation_id);

  /**
   * Compute SHA-256 of a file.
   */
  static bool ComputeFileSha256(
      const std::string& file_path,
      std::string* out_error,
      std::string* out_sha256);

 private:
  static std::mutex cancel_mutex_;
  static std::set<std::string> cancelled_operations_;
};
