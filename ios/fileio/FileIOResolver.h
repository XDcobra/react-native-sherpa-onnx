#ifndef FileIOResolver_h
#define FileIOResolver_h

#import <Foundation/Foundation.h>

// FILEIO_* error codes matching the JS side
extern NSString * const kFIOErrInvalidArgument;
extern NSString * const kFIOErrUnsupportedLocationKind;
extern NSString * const kFIOErrUnsupportedOnPlatform;
extern NSString * const kFIOErrPermissionDenied;
extern NSString * const kFIOErrNotFound;
extern NSString * const kFIOErrAlreadyExists;
extern NSString * const kFIOErrReadError;
extern NSString * const kFIOErrWriteError;
extern NSString * const kFIOErrResolveError;
extern NSString * const kFIOErrCancelled;
extern NSString * const kFIOErrPathTraversalBlocked;

/**
 * Resolved read handle for a FileSource.
 */
@interface FileIOReadHandle : NSObject
@property (nonatomic, assign) BOOL isFilePath;
@property (nonatomic, strong, nullable) NSString *filePath;
@property (nonatomic, strong, nullable) NSInputStream *stream;
@property (nonatomic, assign) int64_t length; // -1 if unknown
@property (nonatomic, strong, nullable) NSURL *securityScopedURL; // non-nil if we started access
- (void)cleanup;
@end

/**
 * Resolved write handle for a FileDestination.
 */
@interface FileIOWriteHandle : NSObject
@property (nonatomic, assign) BOOL isFilePath;
@property (nonatomic, strong, nullable) NSString *filePath;
@property (nonatomic, strong, nullable) NSOutputStream *stream;
@property (nonatomic, strong, nullable) NSString *resultPath; // canonical output path/URI
@property (nonatomic, strong, nullable) NSURL *securityScopedURL; // non-nil if we started access
- (void)cleanup;
@end

/**
 * Central resolver for FileSource / FileDestination on iOS.
 */
@interface FileIOResolver : NSObject

+ (nullable FileIOReadHandle *)resolveSource:(NSDictionary *)source
                                       error:(NSString * _Nullable * _Nullable)errorCode
                                     message:(NSString * _Nullable * _Nullable)errorMessage;

+ (nullable FileIOWriteHandle *)resolveDestination:(NSDictionary *)destination
                                         overwrite:(BOOL)overwrite
                            createParentDirectories:(BOOL)createParentDirs
                                              error:(NSString * _Nullable * _Nullable)errorCode
                                            message:(NSString * _Nullable * _Nullable)errorMessage;

/** Resolve a source to a local file path. Copies stream sources to temp. */
+ (nullable NSString *)resolveSourceToFilePath:(NSDictionary *)source
                                         error:(NSString * _Nullable * _Nullable)errorCode
                                       message:(NSString * _Nullable * _Nullable)errorMessage;

@end

#endif /* FileIOResolver_h */
