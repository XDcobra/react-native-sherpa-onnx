#import "SherpaOnnxArchiveHelper.h"
#import <archive.h>
#import <archive_entry.h>
#import <CommonCrypto/CommonCrypto.h>
#include <array>
#include <atomic>
#include <cstdio>
#include <string>

static std::atomic_bool g_cancelExtract(false);

namespace {
struct ArchiveReadContext {
  FILE* file = nullptr;
  std::array<unsigned char, 64 * 1024> buffer{};
  CC_SHA256_CTX sha_ctx{};
  long long bytes_read = 0;
};

static la_ssize_t ArchiveReadCallback(struct archive* archive, void* client_data, const void** buff) {
  auto* ctx = static_cast<ArchiveReadContext*>(client_data);
  if (!ctx || !ctx->file) {
    archive_set_error(archive, EINVAL, "Invalid read context");
    return -1;
  }

  size_t bytes = fread(ctx->buffer.data(), 1, ctx->buffer.size(), ctx->file);
  if (bytes > 0) {
    CC_SHA256_Update(&ctx->sha_ctx, ctx->buffer.data(), (CC_LONG)bytes);
    ctx->bytes_read += (long long)bytes;
    *buff = ctx->buffer.data();
    return (la_ssize_t)bytes;
  }

  if (feof(ctx->file)) {
    return 0;
  }

  archive_set_error(archive, errno, "Read error");
  return -1;
}

static int ArchiveCloseCallback(struct archive* /* archive */, void* client_data) {
  (void)client_data;
  return ARCHIVE_OK;
}

static void DrainRemainingAndClose(ArchiveReadContext* ctx) {
  if (!ctx || !ctx->file) {
    return;
  }

  size_t bytes = 0;
  while ((bytes = fread(ctx->buffer.data(), 1, ctx->buffer.size(), ctx->file)) > 0) {
    CC_SHA256_Update(&ctx->sha_ctx, ctx->buffer.data(), (CC_LONG)bytes);
    ctx->bytes_read += (long long)bytes;
  }

  fclose(ctx->file);
  ctx->file = nullptr;
}

static NSString* HexStringFromDigest(const unsigned char* digest, size_t size) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) {
    unsigned char value = digest[i];
    out.push_back(kHex[value >> 4]);
    out.push_back(kHex[value & 0x0F]);
  }
  return [NSString stringWithUTF8String:out.c_str()];
}

static NSString* ComputeFileSha256(NSString* filePath, NSError** error) {
  const char* path = [filePath UTF8String];
  FILE* file = fopen(path, "rb");
  if (!file) {
    if (error) {
      *error = [NSError errorWithDomain:@"SherpaOnnx"
                                   code:5
                               userInfo:@{NSLocalizedDescriptionKey: @"Failed to open file"}];
    }
    return nil;
  }

  CC_SHA256_CTX sha_ctx;
  CC_SHA256_Init(&sha_ctx);

  std::array<unsigned char, 64 * 1024> buffer{};
  size_t bytes = 0;
  while ((bytes = fread(buffer.data(), 1, buffer.size(), file)) > 0) {
    CC_SHA256_Update(&sha_ctx, buffer.data(), (CC_LONG)bytes);
  }

  if (ferror(file)) {
    fclose(file);
    if (error) {
      *error = [NSError errorWithDomain:@"SherpaOnnx"
                                   code:6
                               userInfo:@{NSLocalizedDescriptionKey: @"Read error while hashing file"}];
    }
    return nil;
  }

  fclose(file);

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &sha_ctx);
  return HexStringFromDigest(digest, CC_SHA256_DIGEST_LENGTH);
}
}  // namespace

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

  ArchiveReadContext read_ctx;
  read_ctx.file = fopen([sourcePath UTF8String], "rb");
  if (!read_ctx.file) {
    return @{ @"success": @NO, @"reason": @"Failed to open archive file" };
  }
  auto close_reader = [&read_ctx]() {
    DrainRemainingAndClose(&read_ctx);
  };
  CC_SHA256_Init(&read_ctx.sha_ctx);

  if (archive_read_open(archive, &read_ctx, nullptr, ArchiveReadCallback, ArchiveCloseCallback) != ARCHIVE_OK) {
    const char *errorStr = archive_error_string(archive);
    NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to open archive";
    close_reader();
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
      close_reader();
      return @{ @"success": @NO, @"reason": @"Extraction cancelled" };
    }
    const char *currentPath = archive_entry_pathname(entry);
    NSString *entryPath = currentPath ? [NSString stringWithUTF8String:currentPath] : @"";
    NSString *fullPath = [[targetPath stringByAppendingPathComponent:entryPath] stringByStandardizingPath];

    if (![fullPath hasPrefix:canonicalTarget]) {
      archive_read_free(archive);
      archive_write_free(disk);
      close_reader();
      return @{ @"success": @NO, @"reason": @"Blocked path traversal" };
    }

    archive_entry_set_pathname(entry, [fullPath UTF8String]);
    result = archive_write_header(disk, entry);
    if (result != ARCHIVE_OK) {
      const char *errorStr = archive_error_string(disk);
      NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to write entry";
      archive_read_free(archive);
      archive_write_free(disk);
      close_reader();
      return @{ @"success": @NO, @"reason": reason };
    }

    const void *buff = nullptr;
    size_t size = 0;
    la_int64_t offset = 0;
    while ((result = archive_read_data_block(archive, &buff, &size, &offset)) == ARCHIVE_OK) {
      if (g_cancelExtract.load()) {
        archive_read_free(archive);
        archive_write_free(disk);
        close_reader();
        return @{ @"success": @NO, @"reason": @"Extraction cancelled" };
      }
      la_ssize_t writeResult = archive_write_data_block(disk, buff, size, offset);
      if (writeResult != ARCHIVE_OK) {
        const char *errorStr = archive_error_string(disk);
        NSString *reason = errorStr ? [NSString stringWithUTF8String:errorStr] : @"Failed to write data";
        archive_read_free(archive);
        archive_write_free(disk);
        close_reader();
        return @{ @"success": @NO, @"reason": reason };
      }

      extractedBytes += (long long)size;
      if (progress) {
        if (totalBytes > 0) {
          long long compressedBytes = archive_filter_bytes(archive, -1);
          int percent = (int)((compressedBytes * 100) / totalBytes);
          if (percent > 100) {
            percent = 100;
          } else if (percent < 0) {
            percent = 0;
          }
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
      close_reader();
      return @{ @"success": @NO, @"reason": reason };
    }
  }

  archive_read_free(archive);
  archive_write_free(disk);

  if (progress) {
    progress(extractedBytes, extractedBytes, 100.0);
  }

  close_reader();

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &read_ctx.sha_ctx);
  NSString *sha256Hex = HexStringFromDigest(digest, CC_SHA256_DIGEST_LENGTH);

  return @{ @"success": @YES, @"path": targetPath, @"sha256": sha256Hex ?: @"" };
}

- (NSString *)computeFileSha256:(NSString *)filePath
                           error:(NSError * _Nullable * _Nullable)error
{
  return ComputeFileSha256(filePath, error);
}

@end
