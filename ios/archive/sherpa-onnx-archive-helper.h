#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Progress callback for archive extraction.
 * @param bytes       Compressed bytes processed so far
 * @param totalBytes  Total archive size (0 if unknown)
 * @param percent     Progress 0–100
 * @param entryIndex  Index of the entry currently being extracted
 */
typedef void (^SherpaOnnxArchiveProgressBlock)(long long bytes, long long totalBytes,
                                                double percent, int entryIndex);

@interface SherpaOnnxArchiveHelper : NSObject

/**
 * Extract a tar archive (bz2/zst/gz/xz — auto-detected) to target directory.
 * Supports resumable extraction via skipEntries.
 *
 * @param sourcePath   Path to the archive file
 * @param targetPath   Destination directory
 * @param force        Overwrite existing target
 * @param skipEntries  Number of entries to skip (0 = fresh, N = resume after N-1)
 * @param operationId  Unique ID for per-operation cancellation
 * @param progress     Progress callback (nullable)
 *
 * @return Dictionary with: success, paused, lastEntryIndex, lastEntryPath,
 *         bytesExtracted, path (on success), sha256 (on success), reason (on error)
 */
- (NSDictionary *)extract:(NSString *)sourcePath
                targetPath:(NSString *)targetPath
                     force:(BOOL)force
               skipEntries:(int)skipEntries
               operationId:(NSString *)operationId
                  progress:(nullable SherpaOnnxArchiveProgressBlock)progress;

/**
 * Cancel an ongoing extraction by operation ID.
 */
+ (void)cancelOperation:(NSString *)operationId;

/**
 * Compute SHA-256 hex digest of a file.
 */
- (nullable NSString *)computeFileSha256:(NSString *)filePath
                                   error:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END
