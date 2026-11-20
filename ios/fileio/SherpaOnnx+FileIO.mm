/**
 * SherpaOnnx+FileIO.mm
 *
 * File I/O bridge methods: copyFile, saveText, shareFiles, cancelFileIO.
 */

#import "SherpaOnnx.h"
#import "FileIOResolver.h"
#import "FileIOStreamCopy.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

static void FIOCleanupHandles(NSArray<FileIOReadHandle *> *handles)
{
  for (FileIOReadHandle *h in handles) {
    [h cleanup];
  }
}

/**
 * One open share sheet. The completion handler also runs when a target is cancelled
 * while the sheet stays open, so the promise settles only once the sheet is gone; the
 * files stay readable until then.
 */
@interface FIOShareSession : NSObject
@property (nonatomic, strong) NSArray<FileIOReadHandle *> *handles;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, weak) UIActivityViewController *sheet;
@property (nonatomic, copy, nullable) NSString *activityType;
@property (nonatomic, assign) BOOL completed;
@property (nonatomic, assign) BOOL settled;
- (void)settleWhenClosed;
@end

@implementation FIOShareSession
- (void)settleWhenClosed
{
  if (self.settled) return;
  UIActivityViewController *sheet = self.sheet;
  if (!self.completed && sheet != nil && sheet.view.window != nil) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     [self settleWhenClosed];
                   });
    return;
  }
  self.settled = YES;
  FIOCleanupHandles(self.handles);
  self.resolve(@{
    @"completed": @(self.completed),
    @"activityType": self.activityType ?: (id)[NSNull null],
  });
}
@end

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

    SherpaOnnx * __weak weakSelf = self;
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

- (void)shareFiles:(NSArray *)sources
           options:(NSDictionary *)options
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  if (![sources isKindOfClass:[NSArray class]] || sources.count == 0) {
    reject(kFIOErrInvalidArgument, @"shareFiles needs at least one source", nil);
    return;
  }

  NSMutableArray<FileIOReadHandle *> *handles = [NSMutableArray arrayWithCapacity:sources.count];
  NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:sources.count];
  for (id source in sources) {
    if (![source isKindOfClass:[NSDictionary class]]) {
      FIOCleanupHandles(handles);
      reject(kFIOErrInvalidArgument, @"Each source must be an object", nil);
      return;
    }
    NSString *errCode = nil, *errMsg = nil;
    FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
    if (!rh) {
      FIOCleanupHandles(handles);
      reject(errCode, errMsg, nil);
      return;
    }
    [handles addObject:rh];
    if (!rh.isFilePath) {
      FIOCleanupHandles(handles);
      reject(kFIOErrInvalidArgument, @"Cannot share stream sources directly", nil);
      return;
    }
    [urls addObject:[NSURL fileURLWithPath:rh.filePath]];
  }

  NSDictionary *anchor = nil;
  if ([options isKindOfClass:[NSDictionary class]] &&
      [options[@"anchor"] isKindOfClass:[NSDictionary class]]) {
    anchor = options[@"anchor"];
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = RCTPresentedViewController();
    if (!controller) {
      FIOCleanupHandles(handles);
      reject(kFIOErrResolveError, @"No active view controller", nil);
      return;
    }

    UIActivityViewController *activity =
        [[UIActivityViewController alloc] initWithActivityItems:urls applicationActivities:nil];

    // On iPad the sheet is a popover; without a source it raises an exception.
    UIPopoverPresentationController *popover = activity.popoverPresentationController;
    if (popover) {
      UIView *view = controller.view;
      popover.sourceView = view;
      if (anchor) {
        CGRect inWindow = CGRectMake([anchor[@"x"] doubleValue], [anchor[@"y"] doubleValue],
                                     [anchor[@"width"] doubleValue], [anchor[@"height"] doubleValue]);
        popover.sourceRect = [view convertRect:inWindow fromView:nil];
      } else {
        popover.sourceRect = CGRectMake(CGRectGetMidX(view.bounds), CGRectGetMidY(view.bounds), 0, 0);
        popover.permittedArrowDirections = 0;
      }
    }

    FIOShareSession *session = [FIOShareSession new];
    session.handles = handles;
    session.resolve = resolve;
    session.sheet = activity;
    activity.completionWithItemsHandler =
        ^(UIActivityType activityType, BOOL completed, NSArray *returnedItems, NSError *error) {
          dispatch_async(dispatch_get_main_queue(), ^{
            session.activityType = activityType;
            session.completed = completed;
            [session settleWhenClosed];
          });
        };

    [controller presentViewController:activity animated:YES completion:nil];
  });
}

- (void)cancelFileIO:(NSString *)operationId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [FileIOStreamCopy cancelOperation:operationId];
  resolve(nil);
}

- (void)configureFileIO:(NSDictionary *)options
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  NSDictionary *cache = nil;
  if ([options isKindOfClass:[NSDictionary class]]) {
    id raw = options[@"noFdCache"];
    if ([raw isKindOfClass:[NSDictionary class]]) {
      cache = (NSDictionary *)raw;
    } else if (raw != nil && raw != [NSNull null]) {
      reject(kFIOErrInvalidArgument, @"noFdCache must be an object", nil);
      return;
    }
  }
  NSString *errCode = nil;
  NSString *errMsg = nil;
  NSNumber *maxBytes = nil;
  NSNumber *maxAgeMs = nil;
  if (cache[@"maxBytes"] != nil && cache[@"maxBytes"] != [NSNull null]) {
    maxBytes = cache[@"maxBytes"];
  }
  if (cache[@"maxAgeMs"] != nil && cache[@"maxAgeMs"] != [NSNull null]) {
    maxAgeMs = cache[@"maxAgeMs"];
  }
  [FileIOResolver configureNoFdCacheMaxBytes:maxBytes
                                    maxAgeMs:maxAgeMs
                                       error:&errCode
                                     message:&errMsg];
  if (errCode) {
    reject(errCode, errMsg, nil);
    return;
  }
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
