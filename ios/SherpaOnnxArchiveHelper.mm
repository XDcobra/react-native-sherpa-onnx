#import "SherpaOnnxArchiveHelper.h"
#import <archive.h>
#import <archive_entry.h>
#include <atomic>

static std::atomic_bool g_cancelExtract(false);

@implementation SherpaOnnxArchiveHelper

+ (void)cancelExtractTarBz2
{
  g_cancelExtract.store(true);
}

- (NSDictionary *)extractTarBz2:(NSString *)sourcePath
         targetPath:(NSString *)targetPath
           force:(BOOL)force
           progress:(SherpaOnnxArchiveProgressBlock)progress
{
  g_cancelExtract.store(false);
  NSFileManager *fileManager = [NSFileManager defaultManager];

  if (![fileManager fileExistsAtPath:sourcePath]) {
    return @{ @"success": @NO, @"reason": @"Source file does not exist" };
  }

  if ([fileManager fileExistsAtPath:targetPath]) {
    if (force) {
      NSError *removeError = nil;
      [fileManager removeItemAtPath:targetPath error:&removeError];
      if (removeError) {
        return @{ @"success": @NO, @"reason": removeError.localizedDescription ?: @"Failed to remove target" };
      }
    } else {
      return @{ @"success": @NO, @"reason": @"Target path already exists" };
    }
  }

  NSError *mkdirError = nil;
  [fileManager createDirectoryAtPath:targetPath withIntermediateDirectories:YES attributes:nil error:&mkdirError];
  if (mkdirError) {
    return @{ @"success": @NO, @"reason": mkdirError.localizedDescription ?: @"Failed to create target directory" };
  }

  NSString *canonicalTarget = [[targetPath stringByStandardizingPath] stringByAppendingString:@"/"];

  NSDictionary *fileAttributes = [fileManager attributesOfItemAtPath:sourcePath error:nil];
  long long totalBytes = [[fileAttributes objectForKey:NSFileSize] longLongValue];

  struct archive *archive = archive_read_new();
  archive_read_support_format_tar(archive);
  archive_read_support_filter_bzip2(archive);

  if (archive_read_open_filename(archive, [sourcePath UTF8String], 10240) != ARCHIVE_OK) {
    const char *errorStr = archive_error_string(archive);
    NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to open archive";
    archive_read_free(archive);
    return @{ @"success": @NO, @"reason": reason };
  }

  struct archive *disk = archive_write_disk_new();
  archive_write_disk_set_options(disk, ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_PERM | ARCHIVE_EXTRACT_ACL | ARCHIVE_EXTRACT_FFLAGS);
  archive_write_disk_set_standard_lookup(disk);

  struct archive_entry *entry = nullptr;
  int result = ARCHIVE_OK;
  long long extractedBytes = 0;
  int lastPercent = -1;
  long long lastEmitBytes = 0;
  while ((result = archive_read_next_header(archive, &entry)) == ARCHIVE_OK) {
    if (g_cancelExtract.load()) {
      archive_read_free(archive);
      archive_write_free(disk);
      return @{ @"success": @NO, @"reason": @"Extraction cancelled" };
    }
    const char *currentPath = archive_entry_pathname(entry);
    NSString *entryPath = currentPath ? [NSString stringWithUTF8String:currentPath] : @"";
    NSString *fullPath = [[targetPath stringByAppendingPathComponent:entryPath] stringByStandardizingPath];

    if (![fullPath hasPrefix:canonicalTarget]) {
      archive_read_free(archive);
      archive_write_free(disk);
      return @{ @"success": @NO, @"reason": @"Blocked path traversal" };
    }

    archive_entry_set_pathname(entry, [fullPath UTF8String]);
    result = archive_write_header(disk, entry);
    if (result != ARCHIVE_OK) {
      const char *errorStr = archive_error_string(disk);
      NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to write entry";
      archive_read_free(archive);
      archive_write_free(disk);
      return @{ @"success": @NO, @"reason": reason };
    }

    const void *buff = nullptr;
    size_t size = 0;
    la_int64_t offset = 0;
    while ((result = archive_read_data_block(archive, &buff, &size, &offset)) == ARCHIVE_OK) {
      if (g_cancelExtract.load()) {
        archive_read_free(archive);
        archive_write_free(disk);
        return @{ @"success": @NO, @"reason": @"Extraction cancelled" };
      }
      result = archive_write_data_block(disk, buff, size, offset);
      if (result != ARCHIVE_OK) {
        const char *errorStr = archive_error_string(disk);
        NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to write data";
        archive_read_free(archive);
        archive_write_free(disk);
        return @{ @"success": @NO, @"reason": reason };
      }

      extractedBytes += (long long)size;
      if (progress) {
        if (totalBytes > 0) {
          long long compressedBytes = archive_filter_bytes(archive, 0);
          int percent = (int)((compressedBytes * 100) / totalBytes);
          if (percent != lastPercent) {
            lastPercent = percent;
            progress(compressedBytes, totalBytes, (double)percent);
          }
        } else if (extractedBytes - lastEmitBytes >= 1024 * 1024) {
          lastEmitBytes = extractedBytes;
          progress(extractedBytes, totalBytes, 0.0);
        }
      }
    }

    if (result != ARCHIVE_EOF && result != ARCHIVE_OK) {
      const char *errorStr = archive_error_string(archive);
      NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to read data";
      archive_read_free(archive);
      archive_write_free(disk);
      return @{ @"success": @NO, @"reason": reason };
    }
  }

  archive_read_free(archive);
  archive_write_free(disk);

  if (progress && totalBytes > 0) {
    progress(totalBytes, totalBytes, 100.0);
  }

  return @{ @"success": @YES, @"path": targetPath };
}

@end
