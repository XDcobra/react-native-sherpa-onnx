#import "OdrDelivery.h"

@interface SherpaOnnxOdrDelivery ()
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSBundleResourceRequest *> *activeRequests;
@property(nonatomic, strong) NSMutableSet<NSString *> *accessingTags;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSError *> *lastErrors;
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
  }
  return self;
}

- (NSSet<NSString *> *)tagSetForName:(NSString *)tag {
  return [NSSet setWithObject:tag];
}

- (nullable NSString *)assetPackModelsPath:(NSString *)tag {
  if (tag.length == 0) {
    return nil;
  }
  NSString *resourcePath = [[NSBundle mainBundle] resourcePath];
  NSString *tagged =
      [[resourcePath stringByAppendingPathComponent:tag] stringByAppendingPathComponent:@"models"];
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL isDir = NO;
  if ([fm fileExistsAtPath:tagged isDirectory:&isDir] && isDir) {
    return tagged;
  }
  NSString *legacy = [resourcePath stringByAppendingPathComponent:@"models"];
  if ([fm fileExistsAtPath:legacy isDirectory:&isDir] && isDir) {
    return legacy;
  }
  return nil;
}

- (BOOL)isTagReady:(NSString *)tag {
  if ([self assetPackModelsPath:tag] != nil) {
    return YES;
  }
  return [NSBundleResourceRequest resourcesAvailableWithTags:[self tagSetForName:tag]];
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

- (void)fetchAssetPack:(NSString *)tag
               resolve:(void (^)(id result))resolve
                reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject {
  if (tag.length == 0) {
    reject(@"ODR_INVALID_TAG", @"ODR tag is empty", nil);
    return;
  }

  if ([self isTagReady:tag]) {
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
      [self.activeRequests removeObjectForKey:tag];
      if (error) {
        self.lastErrors[tag] = error;
        reject(@"ODR_FETCH_FAILED", error.localizedDescription ?: @"ODR fetch failed", error);
        return;
      }
      [self.accessingTags addObject:tag];
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

  if ([NSBundleResourceRequest resourcesAvailableWithTags:[self tagSetForName:tag]]) {
    map[@"status"] = @"pending";
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
    [request endAccessingResources];
    [self.activeRequests removeObjectForKey:tag];
  }
  [self.accessingTags removeObject:tag];
  [self.lastErrors removeObjectForKey:tag];
  // Allow re-fetch after eviction; extracted Documents/models/ remain.
  resolve(@0);
}

@end
