/**
 * Foreground HTTP downloads with HTTP Range resume (pause, app restart, partial files on disk).
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

static const NSTimeInterval kConnectTimeout = 30.0;
static const NSTimeInterval kReadTimeout = 120.0;
static const NSUInteger kBufferSize = 64 * 1024;
static const NSTimeInterval kProgressMinInterval = 0.2;

@interface SherpaForegroundDownloadState : NSObject <NSURLSessionDataDelegate>
@property (nonatomic, copy) NSString *downloadId;
@property (nonatomic, copy) NSURL *url;
@property (nonatomic, copy) NSString *destination;
@property (nonatomic, copy) NSDictionary<NSString *, NSString *> *headers;
@property (atomic, assign) BOOL cancelled;
@property (atomic, assign) BOOL paused;
@property (nonatomic, assign) int64_t bytesDownloaded;
@property (nonatomic, assign) int64_t bytesTotal;
@property (nonatomic, assign) NSInteger sessionToken;
@property (nonatomic, assign) BOOL hasReportedBegin;
@property (nonatomic, weak) SherpaOnnx *eventModule;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSURLSessionDataTask *task;
@property (nonatomic, strong) NSFileHandle *fileHandle;
@property (nonatomic, assign) BOOL appendMode;
@property (nonatomic, assign) NSTimeInterval lastProgressEmit;
@end

@implementation SherpaForegroundDownloadState

- (instancetype)init
{
  self = [super init];
  if (self) {
    _cancelled = NO;
    _paused = NO;
    _bytesDownloaded = 0;
    _bytesTotal = -1;
    _sessionToken = 0;
    _hasReportedBegin = NO;
    _appendMode = NO;
    _lastProgressEmit = 0;
  }
  return self;
}

- (void)invalidateSession
{
  _sessionToken += 1;
  [_task cancel];
  _task = nil;
  [_session invalidateAndCancel];
  _session = nil;
  @try {
    [_fileHandle closeFile];
  } @catch (__unused NSException *e) {
  }
  _fileHandle = nil;
}

- (void)emitBegin
{
  if (!_eventModule || _hasReportedBegin) {
    return;
  }
  _hasReportedBegin = YES;
  [self.eventModule sendEventWithName:@"sherpaForegroundDownloadBegin"
                                 body:@{
                                   @"id" : self.downloadId ?: @"",
                                   @"expectedBytes" : @((double)self.bytesTotal),
                                   @"headers" : @{},
                                 }];
}

- (void)maybeEmitProgress
{
  if (!_eventModule) {
    return;
  }
  NSTimeInterval now = [NSDate date].timeIntervalSince1970;
  if (now - _lastProgressEmit < kProgressMinInterval) {
    return;
  }
  _lastProgressEmit = now;
  [self.eventModule sendEventWithName:@"sherpaForegroundDownloadProgress"
                                 body:@{
                                   @"id" : self.downloadId ?: @"",
                                   @"bytesDownloaded" : @((double)_bytesDownloaded),
                                   @"bytesTotal" : @((double)_bytesTotal),
                                 }];
}

- (void)emitComplete
{
  if (!_eventModule) {
    return;
  }
  [self.eventModule sendEventWithName:@"sherpaForegroundDownloadComplete"
                                 body:@{
                                   @"id" : self.downloadId ?: @"",
                                   @"location" : self.destination ?: @"",
                                   @"bytesDownloaded" : @((double)_bytesDownloaded),
                                   @"bytesTotal" : @((double)_bytesTotal),
                                 }];
}

- (void)emitError:(NSString *)message code:(int)code
{
  if (!_eventModule) {
    return;
  }
  [self.eventModule sendEventWithName:@"sherpaForegroundDownloadError"
                                 body:@{
                                   @"id" : self.downloadId ?: @"",
                                   @"error" : message ?: @"Unknown error",
                                   @"errorCode" : @(code),
                                 }];
}

#pragma mark - NSURLSessionDataDelegate

- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler
{
  (void)session;
  NSInteger token = _sessionToken;
  if (self.cancelled || self.paused) {
    completionHandler(NSURLSessionResponseCancel);
    return;
  }

  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  NSInteger status = http.statusCode;
  int64_t startByte = _bytesDownloaded;

  if (status == 200) {
    _bytesTotal = response.expectedContentLength > 0 ? response.expectedContentLength : -1;
    if (startByte > 0) {
      RCTLogWarn(@"[ForegroundDownload] Server returned 200 instead of 206; restarting %@",
                 self.downloadId);
      _bytesDownloaded = 0;
      _appendMode = NO;
      [[NSFileManager defaultManager] removeItemAtPath:self.destination error:nil];
      @try {
        [_fileHandle closeFile];
      } @catch (__unused NSException *e) {
      }
      _fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.destination];
      if (_fileHandle) {
        [_fileHandle truncateFileAtOffset:0];
      }
    } else {
      _appendMode = NO;
      if (!_fileHandle) {
        [[NSFileManager defaultManager] createFileAtPath:self.destination contents:nil attributes:nil];
        _fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.destination];
      }
    }
    [self emitBegin];
    completionHandler(NSURLSessionResponseAllow);
    return;
  }

  if (status == 206) {
    NSString *contentRange = http.allHeaderFields[@"Content-Range"];
    if ([contentRange isKindOfClass:[NSString class]]) {
      NSRange slash = [contentRange rangeOfString:@"/"];
      if (slash.location != NSNotFound) {
        NSString *totalPart = [contentRange substringFromIndex:slash.location + 1];
        _bytesTotal = [totalPart longLongValue];
      }
    }
    if (_bytesTotal <= 0 && response.expectedContentLength > 0) {
      _bytesTotal = startByte + response.expectedContentLength;
    }
    _appendMode = startByte > 0;
    if (!_fileHandle) {
      if (![[NSFileManager defaultManager] fileExistsAtPath:self.destination]) {
        [[NSFileManager defaultManager] createFileAtPath:self.destination contents:nil attributes:nil];
      }
      _fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.destination];
      if (_appendMode && _fileHandle) {
        [_fileHandle seekToEndOfFile];
      }
    }
    [self emitBegin];
    completionHandler(NSURLSessionResponseAllow);
    return;
  }

  if (status == 416) {
    NSDictionary *attrs =
      [[NSFileManager defaultManager] attributesOfItemAtPath:self.destination error:nil];
    unsigned long long fileLen = [attrs fileSize];
    if (_bytesTotal > 0 && fileLen >= (unsigned long long)_bytesTotal) {
      _bytesDownloaded = (int64_t)fileLen;
      completionHandler(NSURLSessionResponseCancel);
      dispatch_async(dispatch_get_main_queue(), ^{
        [self emitComplete];
        [SherpaOnnx removeForegroundDownloadState:self.downloadId];
      });
      return;
    }
    [self emitError:@"Range not satisfiable" code:416];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }

  [self emitError:[NSString stringWithFormat:@"HTTP %ld", (long)status] code:(int)status];
  completionHandler(NSURLSessionResponseCancel);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
  (void)session;
  (void)dataTask;
  if (self.cancelled || self.paused) {
    return;
  }
  if (!_fileHandle) {
    return;
  }
  @try {
    [_fileHandle writeData:data];
    _bytesDownloaded += (int64_t)data.length;
    [self maybeEmitProgress];
  } @catch (NSException *e) {
    [self emitError:e.reason ?: @"Write failed" code:-1];
    [self invalidateSession];
  }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
  (void)session;
  (void)task;
  if (self.paused && !error) {
    return;
  }
  if (self.cancelled) {
    return;
  }
  if (error) {
    if (error.code == NSURLErrorCancelled && self.paused) {
      return;
    }
    if (error.code != NSURLErrorCancelled) {
      [self emitError:error.localizedDescription ?: @"Download failed" code:(int)error.code];
    }
    return;
  }
  @try {
    [_fileHandle closeFile];
  } @catch (__unused NSException *e) {
  }
  _fileHandle = nil;
  [self emitComplete];
  [SherpaOnnx removeForegroundDownloadState:self.downloadId];
}

@end

#pragma mark - SherpaOnnx category

static NSMutableDictionary<NSString *, SherpaForegroundDownloadState *> *gForegroundDownloads;
static dispatch_queue_t gForegroundDownloadQueue;

@implementation SherpaOnnx (ForegroundDownload)

+ (void)load
{
  gForegroundDownloads = [NSMutableDictionary new];
  gForegroundDownloadQueue =
    dispatch_queue_create("com.sherpaonnx.foregroundDownload", DISPATCH_QUEUE_SERIAL);
}

+ (void)removeForegroundDownloadState:(NSString *)downloadId
{
  if (!downloadId) {
    return;
  }
  dispatch_sync(gForegroundDownloadQueue, ^{
    [gForegroundDownloads removeObjectForKey:downloadId];
  });
}

- (NSDictionary<NSString *, NSString *> *)normalizedForegroundHeaders:
    (NSDictionary *)headers
{
  if (!headers || ![headers isKindOfClass:[NSDictionary class]]) {
    return @{};
  }
  NSMutableDictionary<NSString *, NSString *> *out = [NSMutableDictionary new];
  for (id key in headers) {
    id val = headers[key];
    if ([key isKindOfClass:[NSString class]] && [val isKindOfClass:[NSString class]]) {
      out[(NSString *)key] = (NSString *)val;
    }
  }
  return out;
}

- (void)startForegroundDownload:(NSString *)downloadId
                            url:(NSString *)url
                    destination:(NSString *)destination
                        headers:(NSDictionary *)headers
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  if (downloadId.length == 0 || url.length == 0 || destination.length == 0) {
    reject(@"INVALID_ARGS", @"id, url and destination are required", nil);
    return;
  }

  NSURL *downloadURL = [NSURL URLWithString:url];
  if (!downloadURL) {
    reject(@"INVALID_URL", @"Invalid download URL", nil);
    return;
  }

  NSString *destDir = [destination stringByDeletingLastPathComponent];
  [[NSFileManager defaultManager] createDirectoryAtPath:destDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];

  dispatch_async(gForegroundDownloadQueue, ^{
    SherpaForegroundDownloadState *existing = gForegroundDownloads[downloadId];
    if (existing) {
      existing.cancelled = YES;
      [existing invalidateSession];
      [gForegroundDownloads removeObjectForKey:downloadId];
    }

    SherpaForegroundDownloadState *state = [SherpaForegroundDownloadState new];
    state.downloadId = downloadId;
    state.url = downloadURL;
    state.destination = destination;
    state.headers = [self normalizedForegroundHeaders:headers];
    state.eventModule = self;

    if ([[NSFileManager defaultManager] fileExistsAtPath:destination]) {
      NSDictionary *attrs =
        [[NSFileManager defaultManager] attributesOfItemAtPath:destination error:nil];
      int64_t diskBytes = (int64_t)[attrs fileSize];
      if (diskBytes > 0) {
        state.bytesDownloaded = diskBytes;
        state.hasReportedBegin = YES;
        RCTLogInfo(@"[ForegroundDownload] Resume from disk: %@ at %lld bytes",
                   downloadId,
                   diskBytes);
      }
    }

    gForegroundDownloads[downloadId] = state;
    [self runForegroundDownload:state];
    resolve(nil);
  });
}

- (void)runForegroundDownload:(SherpaForegroundDownloadState *)state
{
  NSMutableURLRequest *request =
    [NSMutableURLRequest requestWithURL:state.url
                            cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                        timeoutInterval:kReadTimeout];
  request.HTTPMethod = @"GET";
  for (NSString *key in state.headers) {
    [request setValue:state.headers[key] forHTTPHeaderField:key];
  }
  if (!state.headers[@"User-Agent"]) {
    [request setValue:@"react-native-sherpa-onnx/1.0" forHTTPHeaderField:@"User-Agent"];
  }

  int64_t startByte = state.bytesDownloaded;
  if (startByte > 0) {
    [request setValue:[NSString stringWithFormat:@"bytes=%lld-", startByte]
        forHTTPHeaderField:@"Range"];
  }

  NSURLSessionConfiguration *config =
    [NSURLSessionConfiguration defaultSessionConfiguration];
  config.timeoutIntervalForRequest = kConnectTimeout;
  config.timeoutIntervalForResource = kReadTimeout * 10;

  state.session = [NSURLSession sessionWithConfiguration:config
                                                delegate:state
                                           delegateQueue:nil];
  state.task = [state.session dataTaskWithRequest:request];
  [state.task resume];
}

- (void)pauseForegroundDownload:(NSString *)downloadId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  dispatch_async(gForegroundDownloadQueue, ^{
    SherpaForegroundDownloadState *state = gForegroundDownloads[downloadId];
    if (!state) {
      resolve(@NO);
      return;
    }
    state.paused = YES;
    state.sessionToken += 1;
    [state invalidateSession];
  // Sync bytes from disk after pause
    if ([[NSFileManager defaultManager] fileExistsAtPath:state.destination]) {
      NSDictionary *attrs =
        [[NSFileManager defaultManager] attributesOfItemAtPath:state.destination error:nil];
      state.bytesDownloaded = (int64_t)[attrs fileSize];
    }
    resolve(@YES);
  });
}

- (void)resumeForegroundDownload:(NSString *)downloadId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  dispatch_async(gForegroundDownloadQueue, ^{
    SherpaForegroundDownloadState *state = gForegroundDownloads[downloadId];
    if (!state) {
      resolve(@NO);
      return;
    }
    state.paused = NO;
    state.eventModule = self;
    if ([[NSFileManager defaultManager] fileExistsAtPath:state.destination]) {
      NSDictionary *attrs =
        [[NSFileManager defaultManager] attributesOfItemAtPath:state.destination error:nil];
      state.bytesDownloaded = (int64_t)[attrs fileSize];
    }
    [self runForegroundDownload:state];
    resolve(@YES);
  });
}

- (void)cancelForegroundDownload:(NSString *)downloadId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  dispatch_async(gForegroundDownloadQueue, ^{
    SherpaForegroundDownloadState *state = gForegroundDownloads[downloadId];
    if (!state) {
      resolve(@NO);
      return;
    }
    state.cancelled = YES;
    state.sessionToken += 1;
    [state invalidateSession];
    [gForegroundDownloads removeObjectForKey:downloadId];
    resolve(@YES);
  });
}

@end
