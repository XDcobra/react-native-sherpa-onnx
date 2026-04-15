#ifndef FileIOStreamCopy_h
#define FileIOStreamCopy_h

#import <Foundation/Foundation.h>

/**
 * Stream copy engine with progress and cancellation support.
 */
@interface FileIOStreamCopy : NSObject

/** Register an operation for cancellation. */
+ (void)registerOperation:(NSString *)operationId;

/** Cancel a running operation. */
+ (void)cancelOperation:(NSString *)operationId;

/** Unregister an operation (cleanup). */
+ (void)unregisterOperation:(NSString *)operationId;

/** Check if an operation has been cancelled. */
+ (BOOL)isCancelled:(NSString *)operationId;

/**
 * Copy from inputPath to outputPath with progress.
 * @return Bytes copied, or -1 on error.
 */
+ (int64_t)copyFromPath:(NSString *)inputPath
                  toPath:(NSString *)outputPath
             operationId:(NSString * _Nullable)operationId
               onProgress:(void (^ _Nullable)(int64_t bytesTransferred, int64_t totalBytes, int percent))progressBlock
                    error:(NSString * _Nullable * _Nullable)errorCode
                  message:(NSString * _Nullable * _Nullable)errorMessage;

/**
 * Copy from stream to file path with progress.
 * @return Bytes copied, or -1 on error.
 */
+ (int64_t)copyFromStream:(NSInputStream *)inputStream
                totalBytes:(int64_t)totalBytes
                    toPath:(NSString *)outputPath
               operationId:(NSString * _Nullable)operationId
                onProgress:(void (^ _Nullable)(int64_t bytesTransferred, int64_t totalBytes, int percent))progressBlock
                     error:(NSString * _Nullable * _Nullable)errorCode
                   message:(NSString * _Nullable * _Nullable)errorMessage;

@end

#endif /* FileIOStreamCopy_h */
