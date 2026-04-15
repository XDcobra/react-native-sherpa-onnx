/**
 * SherpaOnnx+FileIO.mm
 *
 * File I/O bridge methods: copyFile, saveText, shareFile, cancelFileIO.
 */

#import "SherpaOnnx.h"
#import "FileIOResolver.h"
#import "FileIOStreamCopy.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

@implementation SherpaOnnx (FileIO)

- (void)copyFile:(NSDictionary *)source
     destination:(NSDictionary *)destination
       overwrite:(BOOL)overwrite
createParentDirectories:(BOOL)createParentDirectories
     operationId:(NSString *)operationId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [FileIOStreamCopy registerOperation:operationId];

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSString *errCode = nil, *errMsg = nil;

    FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
    if (!rh) {
      [FileIOStreamCopy unregisterOperation:operationId];
      reject(errCode, errMsg, nil);
      return;
    }

    FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:overwrite
                                       createParentDirectories:createParentDirectories
                                                         error:&errCode message:&errMsg];
    if (!wh) {
      [rh cleanup];
      [FileIOStreamCopy unregisterOperation:operationId];
      reject(errCode, errMsg, nil);
      return;
    }

    __weak typeof(self) weakSelf = self;
    void (^progressBlock)(int64_t, int64_t, int) = ^(int64_t bytesTransferred, int64_t totalBytes, int percent) {
      [weakSelf emitFileIOProgress:operationId bytesTransferred:bytesTransferred totalBytes:totalBytes percent:percent];
    };

    int64_t bytesCopied = -1;
    NSString *outputKind = nil;
    NSString *outputPath = nil;

    if (rh.isFilePath && wh.isFilePath) {
      outputKind = @"fs";
      outputPath = wh.resultPath;
      bytesCopied = [FileIOStreamCopy copyFromPath:rh.filePath toPath:wh.filePath
                                       operationId:operationId onProgress:progressBlock
                                             error:&errCode message:&errMsg];
    } else if (rh.isFilePath && !wh.isFilePath) {
      // Read from file, write to stream — on iOS all destinations resolve to file paths
      // so this case shouldn't occur, but handle gracefully
      outputKind = @"fs";
      outputPath = wh.resultPath;
      bytesCopied = [FileIOStreamCopy copyFromPath:rh.filePath toPath:wh.filePath
                                       operationId:operationId onProgress:progressBlock
                                             error:&errCode message:&errMsg];
    } else {
      // Stream source (shouldn't happen on iOS, but be safe)
      outputKind = @"fs";
      outputPath = wh.resultPath;
      int64_t totalBytes = rh.length >= 0 ? rh.length : 0;
      bytesCopied = [FileIOStreamCopy copyFromStream:rh.stream totalBytes:totalBytes
                                              toPath:wh.filePath operationId:operationId
                                          onProgress:progressBlock error:&errCode message:&errMsg];
    }

    [rh cleanup];
    [wh cleanup];
    [FileIOStreamCopy unregisterOperation:operationId];

    if (bytesCopied < 0) {
      reject(errCode ?: kFIOErrReadError, errMsg ?: @"Copy failed", nil);
      return;
    }

    resolve(@{
      @"bytesCopied": @((double)bytesCopied),
      @"outputKind": outputKind,
      @"outputPath": outputPath,
    });
  });
}

- (void)saveText:(NSString *)text
     destination:(NSDictionary *)destination
        encoding:(NSString *)encoding
       overwrite:(BOOL)overwrite
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  NSString *errCode = nil, *errMsg = nil;
  FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:overwrite
                                     createParentDirectories:NO error:&errCode message:&errMsg];
  if (!wh) {
    reject(errCode, errMsg, nil);
    return;
  }

  @try {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    if (wh.isFilePath) {
      NSError *writeErr = nil;
      if (![data writeToFile:wh.filePath options:NSDataWritingAtomic error:&writeErr]) {
        [wh cleanup];
        reject(kFIOErrWriteError, writeErr ? writeErr.localizedDescription : @"Write failed", writeErr);
        return;
      }
    }
    [wh cleanup];
    resolve(@{
      @"outputKind": @"fs",
      @"outputPath": wh.resultPath,
    });
  } @catch (NSException *e) {
    [wh cleanup];
    reject(kFIOErrWriteError, e.reason, nil);
  }
}

- (void)shareFile:(NSDictionary *)source
         mimeType:(NSString *)mimeType
            title:(NSString *)title
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  NSString *errCode = nil, *errMsg = nil;
  FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!rh) {
    reject(errCode, errMsg, nil);
    return;
  }

  if (!rh.isFilePath) {
    [rh cleanup];
    reject(kFIOErrInvalidArgument, @"Cannot share stream sources directly", nil);
    return;
  }

  NSURL *fileURL = [NSURL fileURLWithPath:rh.filePath];

  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = RCTPresentedViewController();
    if (!controller) {
      [rh cleanup];
      reject(kFIOErrResolveError, @"No active view controller", nil);
      return;
    }

    UIActivityViewController *activity =
        [[UIActivityViewController alloc] initWithActivityItems:@[fileURL]
                                          applicationActivities:nil];
    [controller presentViewController:activity animated:YES completion:nil];
    [rh cleanup];
    resolve(nil);
  });
}

- (void)cancelFileIO:(NSString *)operationId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [FileIOStreamCopy cancelOperation:operationId];
  resolve(nil);
}

- (void)emitFileIOProgress:(NSString *)operationId
          bytesTransferred:(int64_t)bytesTransferred
                totalBytes:(int64_t)totalBytes
                   percent:(int)percent
{
  [self sendEventWithName:@"fileIOProgress" body:@{
    @"operationId": operationId,
    @"bytesTransferred": @((double)bytesTransferred),
    @"totalBytes": @((double)totalBytes),
    @"percent": @(percent),
  }];
}

@end
