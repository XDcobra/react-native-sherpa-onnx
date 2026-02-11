#pragma once

#include <string>
#include <functional>

/**
 * Archive extraction helper using libarchive for fast tar.bz2 extraction
 * Provides both C++ interface and JNI bindings
 */
class ArchiveHelper {
 public:
  /**
   * Extract tar.bz2 file to target directory
   *
   * @param sourcePath Path to the .tar.bz2 file
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
   * Check if extraction has been cancelled
   */
  static bool IsCancelled();

  /**
   * Cancel ongoing extraction
   */
  static void Cancel();

 private:
  static volatile bool cancel_requested_;
};
