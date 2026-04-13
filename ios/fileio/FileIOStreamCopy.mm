#import "FileIOStreamCopy.h"
#import "FileIOResolver.h"

static NSMutableDictionary<NSString *, NSNumber *> *s_cancelledOps;
static dispatch_queue_t s_cancelQueue;

@implementation FileIOStreamCopy

+ (void)initialize {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    s_cancelledOps = [NSMutableDictionary new];
    s_cancelQueue = dispatch_queue_create("com.sherpaonnx.fileio.cancel", DISPATCH_QUEUE_SERIAL);
  });
}

+ (void)registerOperation:(NSString *)operationId {
  dispatch_sync(s_cancelQueue, ^{
    s_cancelledOps[operationId] = @NO;
  });
}

+ (void)cancelOperation:(NSString *)operationId {
  dispatch_sync(s_cancelQueue, ^{
    s_cancelledOps[operationId] = @YES;
  });
}

+ (void)unregisterOperation:(NSString *)operationId {
  dispatch_sync(s_cancelQueue, ^{
    [s_cancelledOps removeObjectForKey:operationId];
  });
}

+ (BOOL)isCancelled:(NSString *)operationId {
  __block BOOL cancelled = NO;
  dispatch_sync(s_cancelQueue, ^{
    cancelled = [s_cancelledOps[operationId] boolValue];
  });
  return cancelled;
}

+ (int64_t)copyFromPath:(NSString *)inputPath
                  toPath:(NSString *)outputPath
             operationId:(NSString * _Nullable)operationId
               onProgress:(void (^ _Nullable)(int64_t, int64_t, int))progressBlock
                    error:(NSString * _Nullable * _Nullable)errorCode
                  message:(NSString * _Nullable * _Nullable)errorMessage
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSDictionary *attrs = [fm attributesOfItemAtPath:inputPath error:nil];
  int64_t totalBytes = [attrs[NSFileSize] longLongValue];

  NSInputStream *input = [NSInputStream inputStreamWithFileAtPath:inputPath];
  if (!input) {
    if (errorCode) *errorCode = kFIOErrReadError;
    if (errorMessage) *errorMessage = @"Cannot open input file";
    return -1;
  }
  [input open];

  NSOutputStream *output = [NSOutputStream outputStreamToFileAtPath:outputPath append:NO];
  if (!output) {
    [input close];
    if (errorCode) *errorCode = kFIOErrWriteError;
    if (errorMessage) *errorMessage = @"Cannot open output file";
    return -1;
  }
  [output open];

  int64_t result = [self doCopy:input toOutput:output totalBytes:totalBytes
                    operationId:operationId onProgress:progressBlock
                          error:errorCode message:errorMessage];
  [output close];
  [input close];
  return result;
}

+ (int64_t)copyFromStream:(NSInputStream *)inputStream
                totalBytes:(int64_t)totalBytes
                    toPath:(NSString *)outputPath
               operationId:(NSString * _Nullable)operationId
                onProgress:(void (^ _Nullable)(int64_t, int64_t, int))progressBlock
                     error:(NSString * _Nullable * _Nullable)errorCode
                   message:(NSString * _Nullable * _Nullable)errorMessage
{
  NSOutputStream *output = [NSOutputStream outputStreamToFileAtPath:outputPath append:NO];
  if (!output) {
    if (errorCode) *errorCode = kFIOErrWriteError;
    if (errorMessage) *errorMessage = @"Cannot open output file";
    return -1;
  }
  [output open];

  int64_t result = [self doCopy:inputStream toOutput:output totalBytes:totalBytes
                    operationId:operationId onProgress:progressBlock
                          error:errorCode message:errorMessage];
  [output close];
  return result;
}

+ (int64_t)doCopy:(NSInputStream *)input
         toOutput:(NSOutputStream *)output
       totalBytes:(int64_t)totalBytes
      operationId:(NSString * _Nullable)operationId
       onProgress:(void (^ _Nullable)(int64_t, int64_t, int))progressBlock
            error:(NSString * _Nullable * _Nullable)errorCode
          message:(NSString * _Nullable * _Nullable)errorMessage
{
  static const NSUInteger kBufferSize = 65536;
  uint8_t buffer[kBufferSize];
  int64_t totalTransferred = 0;

  while (YES) {
    if (operationId && [self isCancelled:operationId]) {
      if (errorCode) *errorCode = kFIOErrCancelled;
      if (errorMessage) *errorMessage = @"Operation cancelled";
      return -1;
    }

    NSInteger bytesRead = [input read:buffer maxLength:kBufferSize];
    if (bytesRead < 0) {
      if (errorCode) *errorCode = kFIOErrReadError;
      if (errorMessage) *errorMessage = @"Error reading from source";
      return -1;
    }
    if (bytesRead == 0) break;

    NSInteger totalWritten = 0;
    while (totalWritten < bytesRead) {
      NSInteger written = [output write:buffer + totalWritten maxLength:bytesRead - totalWritten];
      if (written < 0) {
        if (errorCode) *errorCode = kFIOErrWriteError;
        if (errorMessage) *errorMessage = @"Error writing to destination";
        return -1;
      }
      totalWritten += written;
    }
    totalTransferred += bytesRead;

    if (progressBlock) {
      int percent = (totalBytes > 0) ? (int)((totalTransferred * 100) / totalBytes) : 0;
      if (percent > 100) percent = 100;
      progressBlock(totalTransferred, totalBytes, percent);
    }
  }

  return totalTransferred;
}

@end
