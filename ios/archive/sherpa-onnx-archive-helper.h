#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SherpaOnnxArchiveHelper : NSObject

typedef void (^SherpaOnnxArchiveProgressBlock)(long long bytes, long long totalBytes, double percent);

- (NSDictionary *)extractTarBz2:(NSString *)sourcePath
                     targetPath:(NSString *)targetPath
                          force:(BOOL)force
                       progress:(nullable SherpaOnnxArchiveProgressBlock)progress;

- (NSDictionary *)extractTarZst:(NSString *)sourcePath
                     targetPath:(NSString *)targetPath
                          force:(BOOL)force
                       progress:(nullable SherpaOnnxArchiveProgressBlock)progress;

- (nullable NSString *)computeFileSha256:(NSString *)filePath
                                   error:(NSError * _Nullable * _Nullable)error;

+ (void)cancelExtractTarBz2;

+ (void)cancelExtractTarZst;

/** Cancel extraction for a specific source archive path (per-operation cancel for parallel extractions). */
+ (void)cancelExtractForPath:(NSString *)sourcePath;

@end

NS_ASSUME_NONNULL_END
