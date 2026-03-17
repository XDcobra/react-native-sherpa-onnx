#pragma once

#include <cstddef>
#include <string>
#include <functional>
#include <atomic>

/**
 * Archive extraction helper using libarchive for fast tar.bz2 extraction
 * Provides both C++ interface and JNI bindings
 */
class ArchiveHelper {
 public:
  /** Callback to read bytes from a stream (e.g. Java InputStream via JNI). Returns bytes read, 0 on EOF, -1 on error. */
  using StreamReadCallback = std::ptrdiff_t (*)(void* buf, size_t len, void* user_data);

  /**
   * Extract tar.bz2 (or .tar.zst, .tar.gz, .tar.xz) file to target directory.
   *
   * @param sourcePath Path to the archive file
   * @param targetPath Destination directory path
   * @param force Whether to overwrite existing target directory
   * @param onProgress Callback for progress updates (bytesExtracted, totalBytes, percent)
   * @param outSha256 Optional output SHA-256 hex of the archive file
   * @return true if extraction succeeded, false otherwise
   */
  static bool ExtractTarBz2(
      const std::string& source_path,
      const std::string& target_path,
      bool force,
      std::function<void(long long, long long, double)> on_progress = nullptr,
      std::string* out_error = nullptr,
      std::string* out_sha256 = nullptr);

  /**
   * Extract .tar.zst (or other supported tar compression) file to target directory.
   * Uses the same implementation as ExtractTarBz2 (libarchive supports zstd when built with ENABLE_ZSTD).
   */
  static bool ExtractTarZst(
      const std::string& source_path,
      const std::string& target_path,
      bool force,
      std::function<void(long long, long long, double)> on_progress = nullptr,
      std::string* out_error = nullptr,
      std::string* out_sha256 = nullptr);

  /**
   * Extract a tar archive (tar.zst or tar.bz2) from a stream via read_cb.
   * Used for Android AssetManager streams; total_bytes can be 0 (progress then uses compressed bytes or periodic emit).
   */
  static bool ExtractFromStream(
      StreamReadCallback read_cb,
      void* read_user_data,
      const std::string& target_path,
      bool force,
      std::function<void(long long, long long, double)> on_progress = nullptr,
      std::string* out_error = nullptr,
      std::string* out_sha256 = nullptr);

  /**
     * Compute SHA-256 of a file.
     *
     * @param file_path Path to the file
     * @param out_error Optional error message
     * @param out_sha256 Output SHA-256 hex
     * @return true if successful, false otherwise
     */
    static bool ComputeFileSha256(
      const std::string& file_path,
      std::string* out_error,
      std::string* out_sha256);

  /**
   * Check if extraction has been cancelled
   */
  static bool IsCancelled();

  /**
   * Cancel ongoing extraction
   */
  static void Cancel();

 private:
  static std::atomic<bool> cancel_requested_;
};
