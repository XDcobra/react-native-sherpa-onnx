#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SherpaOnnxArchiveHelper : NSObject

typedef void (^SherpaOnnxArchiveProgressBlock)(long long bytes, long long totalBytes, double percent);

- (NSDictionary *)extractTarBz2:(NSString *)sourcePath
                     targetPath:(NSString *)targetPath
                          force:(BOOL)force
                       progress:(nullable SherpaOnnxArchiveProgressBlock)progress;

@end

NS_ASSUME_NONNULL_END
