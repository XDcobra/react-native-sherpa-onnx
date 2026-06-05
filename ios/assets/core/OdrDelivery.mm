#import "OdrDelivery.h"

static void *kOdrProgressKvoContext = &kOdrProgressKvoContext;

@interface SherpaOnnxOdrEnsureWaiter : NSObject
@property(nonatomic, copy) void (^resolve)(id);
@property(nonatomic, copy) void (^reject)(NSString *, NSString *, NSError *_Nullable);
@end

@implementation SherpaOnnxOdrEnsureWaiter
@end

@interface SherpaOnnxOdrDelivery ()
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSBundleResourceRequest *> *activeRequests;
@property(nonatomic, strong) NSMutableSet<NSString *> *accessingTags;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSError *> *lastErrors;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableArray<SherpaOnnxOdrEnsureWaiter *> *> *ensureWaiters;
@property(nonatomic, strong) NSMutableSet<NSString *> *progressObservedTags;
@property(nonatomic, copy) SherpaOnnxOdrProgressHandler progressHandler;
@end

@implementation SherpaOnnxOdrDelivery

+ (instancetype)shared {
  static SherpaOnnxOdrDelivery *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[SherpaOnnxOdrDelivery alloc] init];
  });
  return instance;
}

- (instancetype)init {
  if (self = [super init]) {
    _activeRequests = [NSMutableDictionary dictionary];
    _accessingTags = [NSMutableSet set];
    _lastErrors = [NSMutableDictionary dictionary];
    _ensureWaiters = [NSMutableDictionary dictionary];
    _progressObservedTags = [NSMutableSet set];
  }
  return self;
}

- (NSSet<NSString *> *)tagSetForName:(NSString *)tag {
  return [NSSet setWithObject:tag];
}

/// PAD parity: models path is available only while ODR access is held for the tag.
- (BOOL)hasOdrAccessForTag:(NSString *)tag {
  return [self.accessingTags containsObject:tag];
}

/// Xcode ODR layout: ship content lives under bundle subdirectory `{tag}/models/`.
static NSString *OdrBundleSubdirectoryForTag(NSString *tag) {
  return [NSString stringWithFormat:@"%@/models", tag];
}

static NSString *OdrModelsPathNotFoundMessage(NSString *tag) {
  return [NSString stringWithFormat:
               @"ODR tag \"%@\" is accessible but resourcePath/%@/models does not exist.",
               tag ?: @"",
               tag ?: @""];
}

static NSString *OdrExpectedModelsDirectoryForTag(NSString *tag, NSBundle *bundle) {
  NSString *resourcePath = [bundle resourcePath];
  if (tag.length == 0 || resourcePath.length == 0) {
    return nil;
  }
  return [resourcePath stringByAppendingPathComponent:OdrBundleSubdirectoryForTag(tag)];
}

- (NSBundle *)bundleForTag:(NSString *)tag {
  NSBundleResourceRequest *request = self.activeRequests[tag];
  return request.bundle ?: [NSBundle mainBundle];
}

- (void)clearAccessForTag:(NSString *)tag {
  [self.accessingTags removeObject:tag];
  NSBundleResourceRequest *request = self.activeRequests[tag];
  if (!request) {
    return;
  }
  [self stopObservingProgressForTag:tag];
  [request endAccessingResources];
  [self.activeRequests removeObjectForKey:tag];
}

- (NSDictionary *)probeDictionaryForPath:(NSString *)path {
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL isDir = NO;
  BOOL exists = [fm fileExistsAtPath:path isDirectory:&isDir];
  NSMutableDictionary *probe = [NSMutableDictionary dictionary];
  probe[@"path"] = path ?: @"";
  probe[@"exists"] = @(exists);
  probe[@"isDirectory"] = @(exists && isDir);
  probe[@"entryCount"] = @0;
  probe[@"entries"] = @[];
  if (!exists || !isDir) {
    return probe;
  }
  NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:path error:nil] ?: @[];
  probe[@"entryCount"] = @(names.count);
  NSUInteger listLimit = MIN(names.count, (NSUInteger)32);
  probe[@"entries"] = [names subarrayWithRange:NSMakeRange(0, listLimit)];
  return probe;
}

/// Canonical `resourcePath/{tag}/models` (must exist on disk).
- (nullable NSString *)resolveModelsDirectoryForTag:(NSString *)tag
                                             bundle:(NSBundle *)bundle {
  if (tag.length == 0 || !bundle) {
    return nil;
  }
  NSString *expected = OdrExpectedModelsDirectoryForTag(tag, bundle);
  BOOL isDir = NO;
  if ([[NSFileManager defaultManager] fileExistsAtPath:expected isDirectory:&isDir] && isDir) {
    return expected;
  }
  return nil;
}

/// Canonical models path while ODR access is held.
- (nullable NSString *)odrModelsDirectoryForTag:(NSString *)tag bundle:(NSBundle *)bundle {
  if (tag.length == 0 || !bundle || ![self hasOdrAccessForTag:tag]) {
    return nil;
  }
  return [self resolveModelsDirectoryForTag:tag bundle:bundle];
}

- (NSDictionary *)odrSnapshotForTag:(NSString *)tag bundle:(NSBundle *)bundle {
  NSBundle *resolvedBundle = bundle ?: [NSBundle mainBundle];
  NSString *expected = OdrExpectedModelsDirectoryForTag(tag, resolvedBundle);
  NSMutableDictionary *snapshot = [NSMutableDictionary dictionary];
  snapshot[@"tag"] = tag ?: @"";
  snapshot[@"resolvedModelsPath"] =
      [self odrModelsDirectoryForTag:tag bundle:resolvedBundle] ?: [NSNull null];
#if DEBUG
  snapshot[@"bundlePath"] = [resolvedBundle bundlePath] ?: @"";
  snapshot[@"resourcePath"] = [resolvedBundle resourcePath] ?: @"";
  snapshot[@"expectedModelsPath"] = expected ?: @"";
  snapshot[@"bundleSubdirectory"] = OdrBundleSubdirectoryForTag(tag);
  snapshot[@"hasActiveRequest"] = @(self.activeRequests[tag] != nil);
  snapshot[@"isAccessingTag"] = @([self.accessingTags containsObject:tag]);
  snapshot[@"directoryProbe"] = [self probeDictionaryForPath:expected];
#endif
  return snapshot;
}

#if DEBUG
- (void)logOdrDiagnosticsForTag:(NSString *)tag bundle:(NSBundle *_Nullable)bundle {
  NSDictionary *snapshot = [self odrSnapshotForTag:tag bundle:bundle ?: [NSBundle mainBundle]];
  NSString *path = snapshot[@"resolvedModelsPath"];
  NSString *expected = snapshot[@"expectedModelsPath"];
  NSLog(@"[SherpaOnnx ODR] tag=%@ path=%@ expected=%@ accessing=%@ activeRequest=%@",
        tag,
        path.length > 0 ? path : @"null",
        expected.length > 0 ? expected : @"tag/models/",
        snapshot[@"isAccessingTag"],
        snapshot[@"hasActiveRequest"]);
}
#endif

- (nullable NSString *)assetPackModelsPath:(NSString *)tag {
  return [self odrModelsDirectoryForTag:tag bundle:[self bundleForTag:tag]];
}

- (nullable NSString *)assetPackModelsPath:(NSString *)tag request:(NSBundleResourceRequest *)request {
  NSBundle *bundle = request.bundle ?: [NSBundle mainBundle];
  return [self odrModelsDirectoryForTag:tag bundle:bundle];
}

- (BOOL)isTagReady:(NSString *)tag {
  if (![self hasOdrAccessForTag:tag]) {
    return NO;
  }
  return [self odrModelsDirectoryForTag:tag bundle:[self bundleForTag:tag]] != nil;
}

- (BOOL)hasActiveAccessForTag:(NSString *)tag {
  return [self.accessingTags containsObject:tag] || self.activeRequests[tag] != nil;
}

- (NSBundleResourceRequest *)requestForTag:(NSString *)tag create:(BOOL)create {
  NSBundleResourceRequest *existing = self.activeRequests[tag];
  if (existing || !create) {
    return existing;
  }
  NSBundleResourceRequest *request =
      [[NSBundleResourceRequest alloc] initWithTags:[self tagSetForName:tag]];
  request.loadingPriority = NSBundleResourceRequestLoadingPriorityUrgent;
  self.activeRequests[tag] = request;
  return request;
}

- (void)emitProgressForTag:(NSString *)tag {
  NSDictionary *state = [self stateDictionaryForTag:tag];
  if (self.progressHandler) {
    self.progressHandler(state);
  }
}

- (void)startObservingProgressForTag:(NSString *)tag request:(NSBundleResourceRequest *)request {
  if ([self.progressObservedTags containsObject:tag]) {
    return;
  }
  [self.progressObservedTags addObject:tag];
  [request.progress addObserver:self
                     forKeyPath:@"fractionCompleted"
                        options:NSKeyValueObservingOptionNew
                        context:kOdrProgressKvoContext];
  [request.progress addObserver:self
                     forKeyPath:@"completedUnitCount"
                        options:NSKeyValueObservingOptionNew
                        context:kOdrProgressKvoContext];
}

- (void)stopObservingProgressForTag:(NSString *)tag {
  if (![self.progressObservedTags containsObject:tag]) {
    return;
  }
  NSBundleResourceRequest *request = self.activeRequests[tag];
  if (request) {
    @try {
      [request.progress removeObserver:self forKeyPath:@"fractionCompleted"];
      [request.progress removeObserver:self forKeyPath:@"completedUnitCount"];
    } @catch (__unused NSException *e) {
    }
  }
  [self.progressObservedTags removeObject:tag];
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  if (context != kOdrProgressKvoContext) {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    return;
  }
  for (NSString *tag in self.activeRequests) {
    NSBundleResourceRequest *request = self.activeRequests[tag];
    if (request.progress == object) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [self emitProgressForTag:tag];
      });
      break;
    }
  }
}

- (void)resolveEnsureWaitersForTag:(NSString *)tag {
  NSArray<SherpaOnnxOdrEnsureWaiter *> *waiters = [self.ensureWaiters[tag] copy];
  [self.ensureWaiters removeObjectForKey:tag];
  NSDictionary *state = [self stateDictionaryForTag:tag];
  for (SherpaOnnxOdrEnsureWaiter *waiter in waiters) {
    waiter.resolve(state);
  }
}

- (void)rejectEnsureWaitersForTag:(NSString *)tag
                             code:(NSString *)code
                          message:(NSString *)message
                            error:(NSError *_Nullable)error {
  NSArray<SherpaOnnxOdrEnsureWaiter *> *waiters = [self.ensureWaiters[tag] copy];
  [self.ensureWaiters removeObjectForKey:tag];
  for (SherpaOnnxOdrEnsureWaiter *waiter in waiters) {
    waiter.reject(code, message, error);
  }
}

- (void)finishEnsureForTag:(NSString *)tag error:(NSError *_Nullable)error {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSBundleResourceRequest *request = self.activeRequests[tag];
    [self stopObservingProgressForTag:tag];

    if (error) {
      [self clearAccessForTag:tag];
      self.lastErrors[tag] = error;
      [self rejectEnsureWaitersForTag:tag
                                  code:@"ODR_FETCH_FAILED"
                               message:error.localizedDescription ?: @"ODR fetch failed"
                                 error:error];
      return;
    }

    NSBundle *accessBundle = request.bundle ?: [NSBundle mainBundle];
    NSString *modelsPath = [self resolveModelsDirectoryForTag:tag bundle:accessBundle];
    if (modelsPath.length == 0) {
      [self clearAccessForTag:tag];
      [self rejectEnsureWaitersForTag:tag
                                  code:@"ODR_PATH_NOT_FOUND"
                               message:OdrModelsPathNotFoundMessage(tag)
                                 error:nil];
      return;
    }

    [self.accessingTags addObject:tag];
#if DEBUG
    [self logOdrDiagnosticsForTag:tag bundle:accessBundle];
#endif
    [self emitProgressForTag:tag];
    [self resolveEnsureWaitersForTag:tag];
  });
}

- (void)beginEnsureDownloadForTag:(NSString *)tag {
  [self.lastErrors removeObjectForKey:tag];
  NSBundleResourceRequest *request = [self requestForTag:tag create:YES];
  [self startObservingProgressForTag:tag request:request];
  [self emitProgressForTag:tag];

  __weak SherpaOnnxOdrDelivery *weakSelf = self;
  [request beginAccessingResourcesWithCompletionHandler:^(NSError *_Nullable accessError) {
    SherpaOnnxOdrDelivery *strongSelf = weakSelf;
    if (!strongSelf) {
      return;
    }
    [strongSelf finishEnsureForTag:tag error:accessError];
  }];
}

- (void)enqueueEnsureWaiter:(NSString *)tag
                    resolve:(void (^)(id))resolve
                     reject:(void (^)(NSString *, NSString *, NSError *_Nullable))reject {
  SherpaOnnxOdrEnsureWaiter *waiter = [[SherpaOnnxOdrEnsureWaiter alloc] init];
  waiter.resolve = resolve;
  waiter.reject = reject;
  NSMutableArray<SherpaOnnxOdrEnsureWaiter *> *list = self.ensureWaiters[tag];
  if (!list) {
    list = [NSMutableArray array];
    self.ensureWaiters[tag] = list;
  }
  [list addObject:waiter];
}

- (void)ensureAssetPackReady:(NSString *)tag
           progressHandler:(SherpaOnnxOdrProgressHandler)progressHandler
                   resolve:(void (^)(id))resolve
                    reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }

  if (progressHandler) {
    self.progressHandler = progressHandler;
  }

  if ([self.accessingTags containsObject:tag] && ![self isTagReady:tag]) {
    [self clearAccessForTag:tag];
  }

  if (self.activeRequests[tag] != nil && [self isTagReady:tag]) {
    [self.accessingTags addObject:tag];
    NSDictionary *state = [self stateDictionaryForTag:tag];
    if (progressHandler) {
      progressHandler(state);
    }
    resolve(state);
    return;
  }

  [self enqueueEnsureWaiter:tag resolve:resolve reject:reject];

  if (self.activeRequests[tag] != nil) {
    [self emitProgressForTag:tag];
    return;
  }

  [self beginEnsureDownloadForTag:tag];
}

- (void)fetchAssetPack:(NSString *)tag
               resolve:(void (^)(id result))resolve
                reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }

  if ([self.accessingTags containsObject:tag] && ![self isTagReady:tag]) {
    [self clearAccessForTag:tag];
  }

  if (self.activeRequests[tag] != nil && [self isTagReady:tag]) {
    [self.accessingTags addObject:tag];
    resolve(@YES);
    return;
  }

  if (self.activeRequests[tag] != nil) {
    resolve(@YES);
    return;
  }

  [self.lastErrors removeObjectForKey:tag];
  NSBundleResourceRequest *request = [self requestForTag:tag create:YES];
  [request beginAccessingResourcesWithCompletionHandler:^(NSError *_Nullable error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error) {
        [self clearAccessForTag:tag];
        self.lastErrors[tag] = error;
        reject(@"ODR_FETCH_FAILED", error.localizedDescription ?: @"ODR fetch failed", error);
        return;
      }
      NSBundle *accessBundle = request.bundle ?: [NSBundle mainBundle];
      NSString *modelsPath = [self resolveModelsDirectoryForTag:tag bundle:accessBundle];
      if (modelsPath.length == 0) {
        [self clearAccessForTag:tag];
        reject(@"ODR_PATH_NOT_FOUND", OdrModelsPathNotFoundMessage(tag), nil);
        return;
      }
      [self.accessingTags addObject:tag];
#if DEBUG
      [self logOdrDiagnosticsForTag:tag bundle:accessBundle];
#endif
      resolve(@YES);
    });
  }];
}

- (NSDictionary *)stateDictionaryForTag:(NSString *)tag {
  NSMutableDictionary *map = [NSMutableDictionary dictionary];
  map[@"packName"] = tag;
  map[@"errorCode"] = @0;

  NSError *lastError = self.lastErrors[tag];
  if (lastError) {
    map[@"status"] = @"failed";
    map[@"bytesDownloaded"] = @0;
    map[@"totalBytes"] = @0;
    map[@"errorCode"] = @(lastError.code);
    return map;
  }

  if ([self isTagReady:tag]) {
    map[@"status"] = @"completed";
    map[@"bytesDownloaded"] = @100;
    map[@"totalBytes"] = @100;
    return map;
  }

  NSBundleResourceRequest *request = self.activeRequests[tag];
  if (request) {
    NSProgress *progress = request.progress;
    map[@"status"] = @"downloading";
    int64_t total = progress.totalUnitCount > 0 ? progress.totalUnitCount : 0;
    map[@"bytesDownloaded"] = @(progress.completedUnitCount);
    map[@"totalBytes"] = @(total);
    return map;
  }

  if ([self hasActiveAccessForTag:tag]) {
    map[@"status"] = @"downloading";
  } else {
    map[@"status"] = @"not_installed";
  }
  map[@"bytesDownloaded"] = @0;
  map[@"totalBytes"] = @0;
  return map;
}

- (void)getAssetPackState:(NSString *)tag
                  resolve:(void (^)(id result))resolve
                   reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }
  resolve([self stateDictionaryForTag:tag]);
}

- (void)removeAssetPack:(NSString *)tag
                resolve:(void (^)(id result))resolve
                 reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }
  NSBundleResourceRequest *request = self.activeRequests[tag];
  if (request) {
    [self stopObservingProgressForTag:tag];
    [request endAccessingResources];
    [self.activeRequests removeObjectForKey:tag];
  }
  [self.accessingTags removeObject:tag];
  [self.lastErrors removeObjectForKey:tag];
  [self.ensureWaiters removeObjectForKey:tag];
  resolve(@0);
}

- (void)listOdrDeliverySnapshot:(NSString *)tag
                        resolve:(void (^)(id result))resolve
                         reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }
  resolve([self odrSnapshotForTag:tag bundle:[self bundleForTag:tag]]);
}

@end
