#import <Foundation/Foundation.h>

@class SherpaOnnx;

@interface SherpaOnnx (Assets)

- (nullable NSString *)resolveAssetPath:(NSString *)assetPath error:(NSError **)error;
- (nullable NSString *)resolveFilePath:(NSString *)filePath error:(NSError **)error;
- (nullable NSString *)resolveAutoPath:(NSString *)path error:(NSError **)error;

@end
