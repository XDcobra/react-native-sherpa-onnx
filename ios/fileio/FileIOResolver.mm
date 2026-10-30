#import "FileIOResolver.h"

#import <CommonCrypto/CommonDigest.h>
#include <math.h>
#include <string.h>

// Error code constants
NSString * const kFIOErrInvalidArgument       = @"FILEIO_INVALID_ARGUMENT";
NSString * const kFIOErrUnsupportedLocationKind = @"FILEIO_UNSUPPORTED_LOCATION_KIND";
NSString * const kFIOErrUnsupportedOnPlatform = @"FILEIO_UNSUPPORTED_ON_PLATFORM";
NSString * const kFIOErrPermissionDenied      = @"FILEIO_PERMISSION_DENIED";
NSString * const kFIOErrNotFound              = @"FILEIO_NOT_FOUND";
NSString * const kFIOErrAlreadyExists         = @"FILEIO_ALREADY_EXISTS";
NSString * const kFIOErrReadError             = @"FILEIO_READ_ERROR";
NSString * const kFIOErrWriteError            = @"FILEIO_WRITE_ERROR";
NSString * const kFIOErrResolveError          = @"FILEIO_RESOLVE_ERROR";
NSString * const kFIOErrCancelled             = @"FILEIO_CANCELLED";
NSString * const kFIOErrPathTraversalBlocked  = @"FILEIO_PATH_TRAVERSAL_BLOCKED";

static const uint64_t kNoFdDefaultMaxBytes = 512ull * 1024ull * 1024ull;
static const int64_t kNoFdDefaultMaxAgeMs = 24ll * 60ll * 60ll * 1000ll;
static uint64_t gNoFdMaxBytes = kNoFdDefaultMaxBytes;
static int64_t gNoFdMaxAgeMs = kNoFdDefaultMaxAgeMs;
static NSLock *gNoFdLock;
static NSMutableDictionary<NSString *, NSNumber *> *gNoFdPins;
static NSMutableDictionary<NSString *, NSString *> *gNoFdBufferPins;

static NSString *nofdCacheRoot(void) {
  NSArray<NSString *> *caches =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  return [[caches firstObject] stringByAppendingPathComponent:@"fileio_nofd"];
}

static NSString *nofdCanonical(NSString *path) {
  return path.stringByStandardizingPath ?: path;
}

static void nofdEnsureLocks(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gNoFdLock = [[NSLock alloc] init];
    gNoFdPins = [NSMutableDictionary dictionary];
    gNoFdBufferPins = [NSMutableDictionary dictionary];
  });
}

static BOOL nofdIsCachePath(NSString *path) {
  if (path.length == 0) return NO;
  NSString *root = nofdCacheRoot().stringByStandardizingPath;
  NSString *canon = nofdCanonical(path);
  return [canon isEqualToString:root] ||
         [canon hasPrefix:[root stringByAppendingString:@"/"]];
}

static void nofdEvict(void);

static void nofdPin(NSString *path) {
  if (!nofdIsCachePath(path)) return;
  NSString *key = nofdCanonical(path);
  nofdEnsureLocks();
  [gNoFdLock lock];
  NSInteger n = gNoFdPins[key].integerValue + 1;
  gNoFdPins[key] = @(n);
  [gNoFdLock unlock];
  NSLog(@"[SherpaOnnxFileIO] nofd pin path=%@ count=%ld", key, (long)n);
}

static void nofdUnpin(NSString *path) {
  if (!nofdIsCachePath(path)) return;
  NSString *key = nofdCanonical(path);
  nofdEnsureLocks();
  [gNoFdLock lock];
  NSInteger n = gNoFdPins[key].integerValue - 1;
  if (n <= 0) {
    [gNoFdPins removeObjectForKey:key];
  } else {
    gNoFdPins[key] = @(n);
  }
  [gNoFdLock unlock];
  NSLog(@"[SherpaOnnxFileIO] nofd unpin path=%@ count=%ld", key, (long)MAX(n, 0));
  nofdEvict();
}

static void nofdTouch(NSString *path) {
  NSDictionary *attrs = @{ NSFileModificationDate: [NSDate date] };
  [[NSFileManager defaultManager] setAttributes:attrs ofItemAtPath:path error:nil];
}

static void nofdEvict(void) {
  nofdEnsureLocks();
  NSString *root = nofdCacheRoot();
  NSFileManager *fm = [NSFileManager defaultManager];
  NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:root error:nil];
  if (names.count == 0) return;
  NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
  int64_t ageLimit = gNoFdMaxAgeMs;
  uint64_t cap = gNoFdMaxBytes;

  NSMutableArray<NSDictionary *> *ents = [NSMutableArray array];
  [gNoFdLock lock];
  for (NSString *name in names) {
    if ([name hasSuffix:@".tmp"]) continue;
    NSString *path = nofdCanonical([root stringByAppendingPathComponent:name]);
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    if (![attrs.fileType isEqualToString:NSFileTypeRegular]) continue;
    BOOL pinned = gNoFdPins[path].integerValue > 0;
    NSDate *mtime = attrs.fileModificationDate ?: [NSDate distantPast];
    [ents addObject:@{
      @"path": path,
      @"size": @(attrs.fileSize),
      @"mtime": mtime,
      @"pinned": @(pinned),
    }];
  }
  [gNoFdLock unlock];

  for (NSDictionary *e in ents) {
    if ([e[@"pinned"] boolValue]) continue;
    NSTimeInterval ageMs =
        (now - [e[@"mtime"] timeIntervalSince1970]) * 1000.0;
    BOOL expired = ageLimit == 0 ? YES : ageMs > (NSTimeInterval)ageLimit;
    if (expired) {
      NSLog(@"[SherpaOnnxFileIO] nofd evict age path=%@ ageMs=%.0f", e[@"path"], ageMs);
      [fm removeItemAtPath:e[@"path"] error:nil];
    }
  }

  names = [fm contentsOfDirectoryAtPath:root error:nil];
  NSMutableArray<NSDictionary *> *live = [NSMutableArray array];
  uint64_t total = 0;
  [gNoFdLock lock];
  for (NSString *name in names ?: @[]) {
    if ([name hasSuffix:@".tmp"]) continue;
    NSString *path = nofdCanonical([root stringByAppendingPathComponent:name]);
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    if (![attrs.fileType isEqualToString:NSFileTypeRegular]) continue;
    BOOL pinned = gNoFdPins[path].integerValue > 0;
    NSDate *mtime = attrs.fileModificationDate ?: [NSDate distantPast];
    [live addObject:@{
      @"path": path,
      @"size": @(attrs.fileSize),
      @"mtime": mtime,
      @"pinned": @(pinned),
    }];
    total += attrs.fileSize;
  }
  [gNoFdLock unlock];
  if (total <= cap) return;
  NSArray *unpinned = [[live filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *e, NSDictionary *bindings) {
        (void)bindings;
        return ![e[@"pinned"] boolValue];
      }]]
      sortedArrayUsingDescriptors:@[
        [NSSortDescriptor sortDescriptorWithKey:@"mtime" ascending:YES]
      ]];
  for (NSDictionary *e in unpinned) {
    if (total <= cap) break;
    unsigned long long size = [e[@"size"] unsignedLongLongValue];
    NSLog(@"[SherpaOnnxFileIO] nofd evict lru path=%@ size=%llu total=%llu cap=%llu",
          e[@"path"], size, total, cap);
    if ([fm removeItemAtPath:e[@"path"] error:nil]) {
      if (total >= size) total -= size;
      else total = 0;
    }
  }
}

static void nofdAdopt(NSString *path) {
  nofdPin(path);
  nofdTouch(path);
  nofdEvict();
}

// ---- Handle implementations ----

@implementation FileIOReadHandle
- (instancetype)init {
  self = [super init];
  if (self) { _length = -1; }
  return self;
}
- (void)cleanup {
  if (_stream) { [_stream close]; _stream = nil; }
  if (_securityScopedURL) {
    [_securityScopedURL stopAccessingSecurityScopedResource];
    _securityScopedURL = nil;
  }
}
@end

@implementation FileIOWriteHandle
- (instancetype)init {
  self = [super init];
  return self;
}
- (void)cleanup {
  if (_stream) { [_stream close]; _stream = nil; }
  if (_securityScopedURL) {
    [_securityScopedURL stopAccessingSecurityScopedResource];
    _securityScopedURL = nil;
  }
}
@end

// ---- Helper: resolve AppBaseDir ----

static NSString *resolveAppBaseDir(NSString *base, NSString * _Nullable * _Nullable errCode, NSString * _Nullable * _Nullable errMsg) {
  if ([base isEqualToString:@"apkAsset"]) {
    if (errCode) *errCode = kFIOErrUnsupportedOnPlatform;
    if (errMsg) *errMsg = @"apkAsset is Android-only";
    return nil;
  }
  if ([base isEqualToString:@"appBundle"]) {
    if (errCode) *errCode = kFIOErrUnsupportedOnPlatform;
    if (errMsg) *errMsg = @"appBundle does not map to a sandbox directory. Use FileSource app:appBundle for reads.";
    return nil;
  }
  if ([base isEqualToString:@"cache"]) {
    return NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  } else if ([base isEqualToString:@"documents"]) {
    return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  } else if ([base isEqualToString:@"files"]) {
    return NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  } else if ([base isEqualToString:@"tmp"]) {
    return NSTemporaryDirectory();
  } else if ([base isEqualToString:@"externalFiles"]) {
    if (errCode) *errCode = kFIOErrUnsupportedOnPlatform;
    if (errMsg) *errMsg = @"externalFiles is not supported on iOS";
    return nil;
  }
  if (errCode) *errCode = kFIOErrUnsupportedLocationKind;
  if (errMsg) *errMsg = [NSString stringWithFormat:@"Unknown AppBaseDir: %@", base];
  return nil;
}

static NSString *resolveAppPath(NSString *base, NSString *relativePath, NSString * _Nullable * _Nullable errCode, NSString * _Nullable * _Nullable errMsg) {
  NSString *baseDir = resolveAppBaseDir(base, errCode, errMsg);
  if (!baseDir) return nil;

  NSString *fullPath = [baseDir stringByAppendingPathComponent:relativePath];
  NSString *canonical = [fullPath stringByStandardizingPath];
  NSString *canonicalBase = [baseDir stringByStandardizingPath];

  if (![canonical hasPrefix:canonicalBase]) {
    if (errCode) *errCode = kFIOErrPathTraversalBlocked;
    if (errMsg) *errMsg = @"Path escapes base directory";
    return nil;
  }
  return canonical;
}

static NSString *resolveAppBundleRelativePath(
  NSString *relativePath,
  NSString * _Nullable * _Nullable errCode,
  NSString * _Nullable * _Nullable errMsg
) {
  if ([relativePath containsString:@".."] ||
      [relativePath hasPrefix:@"/"] ||
      [relativePath hasPrefix:@"\\"] ||
      [relativePath containsString:@"\\"]) {
    if (errCode) *errCode = kFIOErrPathTraversalBlocked;
    if (errMsg) *errMsg = [NSString stringWithFormat:@"Invalid appBundle path: %@", relativePath];
    return nil;
  }

  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *bundleResourcePath = [[NSBundle mainBundle] resourcePath];
  NSString *sourcePath = [bundleResourcePath stringByAppendingPathComponent:relativePath];
  if ([fm fileExistsAtPath:sourcePath]) {
    return [sourcePath stringByStandardizingPath];
  }

  NSString *bundlePath = [[NSBundle mainBundle] pathForResource:relativePath ofType:nil];
  if (bundlePath && [fm fileExistsAtPath:bundlePath]) {
    return [bundlePath stringByStandardizingPath];
  }

  NSArray *pathComponents = [relativePath componentsSeparatedByString:@"/"];
  if (pathComponents.count > 1) {
    NSString *directory = pathComponents[0];
    for (NSUInteger i = 1; i < pathComponents.count - 1; i++) {
      directory = [directory stringByAppendingPathComponent:pathComponents[i]];
    }
    NSString *resourceName = pathComponents.lastObject;
    bundlePath = [[NSBundle mainBundle] pathForResource:resourceName ofType:nil inDirectory:directory];
    if (bundlePath && [fm fileExistsAtPath:bundlePath]) {
      return [bundlePath stringByStandardizingPath];
    }
  }

  if (errCode) *errCode = kFIOErrNotFound;
  if (errMsg) *errMsg = [NSString stringWithFormat:@"appBundle resource not found: %@", relativePath];
  return nil;
}

// ---- Resolver ----

@implementation FileIOResolver

+ (void)initialize {
  if (self != [FileIOResolver class]) return;
  nofdEnsureLocks();
  gNoFdMaxBytes = kNoFdDefaultMaxBytes;
  gNoFdMaxAgeMs = kNoFdDefaultMaxAgeMs;
  nofdEvict();
}

+ (nullable FileIOReadHandle *)resolveSource:(NSDictionary *)source
                                       error:(NSString * _Nullable * _Nullable)errorCode
                                     message:(NSString * _Nullable * _Nullable)errorMessage
{
  NSString *kind = source[@"kind"];
  if (!kind) {
    if (errorCode) *errorCode = kFIOErrInvalidArgument;
    if (errorMessage) *errorMessage = @"Missing 'kind' in source";
    return nil;
  }

  if ([kind isEqualToString:@"fs"]) {
    NSString *path = source[@"path"];
    if (!path) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'path' in fs source";
      return nil;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:path]) {
      if (errorCode) *errorCode = kFIOErrNotFound;
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Source file not found: %@", path];
      return nil;
    }
    FileIOReadHandle *handle = [[FileIOReadHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = path;
    return handle;
  }

  if ([kind isEqualToString:@"app"]) {
    NSString *base = source[@"base"];
    NSString *path = source[@"path"];
    if (!base || !path) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'base' or 'path' in app source";
      return nil;
    }
    if ([base isEqualToString:@"apkAsset"]) {
      if (errorCode) *errorCode = kFIOErrUnsupportedOnPlatform;
      if (errorMessage) *errorMessage = @"apkAsset is Android-only";
      return nil;
    }
    NSString *resolved = nil;
    if ([base isEqualToString:@"appBundle"]) {
      resolved = resolveAppBundleRelativePath(path, errorCode, errorMessage);
    } else {
      resolved = resolveAppPath(base, path, errorCode, errorMessage);
    }
    if (!resolved) return nil;
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:resolved]) {
      if (errorCode) *errorCode = kFIOErrNotFound;
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Source file not found: %@", resolved];
      return nil;
    }
    FileIOReadHandle *handle = [[FileIOReadHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = resolved;
    return handle;
  }

  if ([kind isEqualToString:@"securityScoped"]) {
    NSString *uriStr = source[@"uri"];
    if (!uriStr) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'uri' in securityScoped source";
      return nil;
    }
    NSURL *url = [NSURL URLWithString:uriStr];
    if (!url) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Invalid URL in securityScoped source";
      return nil;
    }
    if (![url startAccessingSecurityScopedResource]) {
      if (errorCode) *errorCode = kFIOErrPermissionDenied;
      if (errorMessage) *errorMessage = @"Failed to access security-scoped resource";
      return nil;
    }
    FileIOReadHandle *handle = [[FileIOReadHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = [url path];
    handle.securityScopedURL = url;
    return handle;
  }

  if ([kind isEqualToString:@"contentUri"] || [kind isEqualToString:@"contentTree"]) {
    if (errorCode) *errorCode = kFIOErrUnsupportedOnPlatform;
    if (errorMessage) *errorMessage = [NSString stringWithFormat:@"%@ is not supported on iOS", kind];
    return nil;
  }

  if ([kind isEqualToString:@"pad"]) {
    if (errorCode) *errorCode = kFIOErrUnsupportedOnPlatform;
    if (errorMessage) *errorMessage = @"PAD is not supported on iOS";
    return nil;
  }

  if (errorCode) *errorCode = kFIOErrUnsupportedLocationKind;
  if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Unknown source kind: %@", kind];
  return nil;
}

+ (nullable FileIOWriteHandle *)resolveDestination:(NSDictionary *)destination
                                         overwrite:(BOOL)overwrite
                            createParentDirectories:(BOOL)createParentDirs
                                              error:(NSString * _Nullable * _Nullable)errorCode
                                            message:(NSString * _Nullable * _Nullable)errorMessage
{
  NSString *kind = destination[@"kind"];
  if (!kind) {
    if (errorCode) *errorCode = kFIOErrInvalidArgument;
    if (errorMessage) *errorMessage = @"Missing 'kind' in destination";
    return nil;
  }
  NSFileManager *fm = [NSFileManager defaultManager];

  if ([kind isEqualToString:@"fs"]) {
    NSString *path = destination[@"path"];
    if (!path) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'path' in fs destination";
      return nil;
    }
    if ([fm fileExistsAtPath:path] && !overwrite) {
      if (errorCode) *errorCode = kFIOErrAlreadyExists;
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Destination already exists: %@", path];
      return nil;
    }
    if (createParentDirs) {
      NSString *parent = [path stringByDeletingLastPathComponent];
      [fm createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:nil];
    }
    FileIOWriteHandle *handle = [[FileIOWriteHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = path;
    handle.resultPath = path;
    return handle;
  }

  if ([kind isEqualToString:@"app"]) {
    NSString *base = destination[@"base"];
    NSString *path = destination[@"path"];
    if (!base || !path) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'base' or 'path' in app destination";
      return nil;
    }
    if ([base isEqualToString:@"apkAsset"] || [base isEqualToString:@"appBundle"]) {
      if (errorCode) *errorCode = kFIOErrUnsupportedOnPlatform;
      if (errorMessage) *errorMessage = @"Bundled app sources are read-only";
      return nil;
    }
    NSString *resolved = resolveAppPath(base, path, errorCode, errorMessage);
    if (!resolved) return nil;
    if ([fm fileExistsAtPath:resolved] && !overwrite) {
      if (errorCode) *errorCode = kFIOErrAlreadyExists;
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Destination already exists: %@", resolved];
      return nil;
    }
    if (createParentDirs) {
      NSString *parent = [resolved stringByDeletingLastPathComponent];
      [fm createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:nil];
    }
    FileIOWriteHandle *handle = [[FileIOWriteHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = resolved;
    handle.resultPath = resolved;
    return handle;
  }

  if ([kind isEqualToString:@"securityScoped"]) {
    NSString *uriStr = destination[@"uri"];
    if (!uriStr) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Missing 'uri' in securityScoped destination";
      return nil;
    }
    NSURL *url = [NSURL URLWithString:uriStr];
    if (!url) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"Invalid URL in securityScoped destination";
      return nil;
    }
    if (![url startAccessingSecurityScopedResource]) {
      if (errorCode) *errorCode = kFIOErrPermissionDenied;
      if (errorMessage) *errorMessage = @"Failed to access security-scoped resource";
      return nil;
    }
    NSString *filePath = [url path];
    if ([fm fileExistsAtPath:filePath] && !overwrite) {
      [url stopAccessingSecurityScopedResource];
      if (errorCode) *errorCode = kFIOErrAlreadyExists;
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Destination already exists: %@", filePath];
      return nil;
    }
    FileIOWriteHandle *handle = [[FileIOWriteHandle alloc] init];
    handle.isFilePath = YES;
    handle.filePath = filePath;
    handle.resultPath = filePath;
    handle.securityScopedURL = url;
    return handle;
  }

  if ([kind isEqualToString:@"contentUri"] || [kind isEqualToString:@"contentTree"]) {
    if (errorCode) *errorCode = kFIOErrUnsupportedOnPlatform;
    if (errorMessage) *errorMessage = [NSString stringWithFormat:@"%@ is not supported on iOS", kind];
    return nil;
  }

  if (errorCode) *errorCode = kFIOErrUnsupportedLocationKind;
  if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Unknown destination kind: %@", kind];
  return nil;
}

+ (nullable NSString *)seekableFilePathFromHandle:(FileIOReadHandle *)handle
                                   openFailedCode:(NSString *)openFailedCode
                                           logTag:(NSString *)logTag
                                            error:(NSString * _Nullable * _Nullable)errorCode
                                          message:(NSString * _Nullable * _Nullable)errorMessage
{
  NSString *code = openFailedCode.length > 0 ? openFailedCode : kFIOErrResolveError;
  NSString *tag = logTag.length > 0 ? logTag : @"SherpaOnnx:fileio";
  if (handle && handle.isFilePath && handle.filePath.length > 0) {
    NSLog(@"[%@] open path=%@", tag, handle.filePath);
    return handle.filePath;
  }
  NSLog(@"[%@] reject non-path FileSource", tag);
  if (errorCode) *errorCode = code;
  if (errorMessage) {
    *errorMessage = [NSString stringWithFormat:
        @"%@: source is not seekable (requires a filesystem path)", code];
  }
  return nil;
}

static NSString *sha256Hex(NSString *value) {
  const char *c = value.UTF8String ?: "";
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(c, (CC_LONG)strlen(c), digest);
  NSMutableString *out = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    [out appendFormat:@"%02x", digest[i]];
  }
  return out;
}

static NSString *demuxCacheIdentity(NSDictionary *source) {
  NSString *kind = source[@"kind"] ?: @"unknown";
  NSString *ident = @"";
  if ([kind isEqualToString:@"contentUri"] || [kind isEqualToString:@"securityScoped"]) {
    ident = source[@"uri"] ?: @"";
  } else if ([kind isEqualToString:@"app"]) {
    ident = [NSString stringWithFormat:@"%@:%@", source[@"base"] ?: @"", source[@"path"] ?: @""];
  } else if ([kind isEqualToString:@"pad"]) {
    ident = [NSString stringWithFormat:@"%@:%@", source[@"packName"] ?: @"", source[@"path"] ?: @""];
  } else {
    ident = source[@"path"] ?: (source[@"uri"] ?: @"");
  }
  return [NSString stringWithFormat:@"%@|%@", kind, ident];
}

static NSString *extensionHint(NSDictionary *source) {
  NSString *name = source[@"displayName"];
  if (![name isKindOfClass:[NSString class]] || name.length == 0) {
    name = source[@"path"];
  }
  if (![name isKindOfClass:[NSString class]] || name.length == 0) {
    name = source[@"uri"];
  }
  if (![name isKindOfClass:[NSString class]] || name.length == 0) {
    return @"";
  }
  NSString *leaf = name.lastPathComponent ?: name;
  NSString *ext = leaf.pathExtension.lowercaseString;
  if (ext.length == 0 || ext.length > 8) {
    return @"";
  }
  for (NSUInteger i = 0; i < ext.length; i++) {
    unichar c = [ext characterAtIndex:i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) {
      return @"";
    }
  }
  return [@"." stringByAppendingString:ext];
}

+ (nullable NSString *)demuxableFilePathFromHandle:(FileIOReadHandle *)handle
                                            source:(NSDictionary *)source
                                             error:(NSString * _Nullable * _Nullable)errorCode
                                           message:(NSString * _Nullable * _Nullable)errorMessage
{
  if (handle && handle.isFilePath && handle.filePath.length > 0) {
    NSLog(@"[SherpaOnnxFileIO] demux FilePath path=%@", handle.filePath);
    if (nofdIsCachePath(handle.filePath)) {
      nofdAdopt(handle.filePath);
    }
    return handle.filePath;
  }
  if (!handle || handle.stream == nil) {
    if (errorCode) *errorCode = kFIOErrInvalidArgument;
    if (errorMessage) *errorMessage = @"FileSource is not a readable file";
    return nil;
  }

  NSString *cacheRoot = nofdCacheRoot();
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *mkErr = nil;
  [fm createDirectoryAtPath:cacheRoot withIntermediateDirectories:YES attributes:nil error:&mkErr];
  if (mkErr) {
    if (errorCode) *errorCode = kFIOErrWriteError;
    if (errorMessage) *errorMessage = [NSString stringWithFormat:
        @"Failed to create nofd cache: %@", mkErr.localizedDescription];
    return nil;
  }

  NSString *key = sha256Hex(demuxCacheIdentity(source ?: @{}));
  NSString *outPath = [cacheRoot stringByAppendingPathComponent:
                       [key stringByAppendingString:extensionHint(source ?: @{})]];
  if ([fm fileExistsAtPath:outPath]) {
    NSDictionary *attrs = [fm attributesOfItemAtPath:outPath error:nil];
    unsigned long long size = [attrs fileSize];
    int64_t known = handle.length;
    if (size > 0 && (known <= 0 || (unsigned long long)known == size)) {
      NSLog(@"[SherpaOnnxFileIO] nofd cache hit path=%@", outPath);
      nofdAdopt(outPath);
      return outPath;
    }
    NSLog(@"[SherpaOnnxFileIO] nofd cache stale path=%@ size=%llu expected=%lld — recopy",
          outPath, size, (long long)known);
  }

  NSString *tmpPath = [outPath stringByAppendingString:@".tmp"];
  NSLog(@"[SherpaOnnxFileIO] nofd copy -> %@", outPath);
  NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
  [out open];
  [handle.stream open];
  uint8_t buf[65536];
  NSInteger bytesRead;
  while ((bytesRead = [handle.stream read:buf maxLength:sizeof(buf)]) > 0) {
    [out write:buf maxLength:(NSUInteger)bytesRead];
  }
  NSInteger streamErr = handle.stream.streamError ? 1 : 0;
  [out close];
  if (bytesRead < 0 || streamErr) {
    [fm removeItemAtPath:tmpPath error:nil];
    if (errorCode) *errorCode = kFIOErrReadError;
    if (errorMessage) *errorMessage = @"Failed to materialize stream source for demux";
    return nil;
  }
  [fm removeItemAtPath:outPath error:nil];
  NSError *mvErr = nil;
  if (![fm moveItemAtPath:tmpPath toPath:outPath error:&mvErr]) {
    [fm removeItemAtPath:tmpPath error:nil];
    if (errorCode) *errorCode = kFIOErrWriteError;
    if (errorMessage) {
      *errorMessage = [NSString stringWithFormat:
          @"Failed to commit nofd cache file: %@", mvErr.localizedDescription];
    }
    return nil;
  }
  nofdAdopt(outPath);
  return outPath;
}

+ (BOOL)isNofdCachePath:(NSString *)path {
  return nofdIsCachePath(path);
}

+ (void)unpinNofdPath:(NSString *)path {
  nofdUnpin(path);
}

+ (void)retainNofdPinForBuffer:(NSString *)bufferId path:(NSString *)path {
  if (bufferId.length == 0 || path.length == 0) return;
  nofdEnsureLocks();
  [gNoFdLock lock];
  NSString *old = gNoFdBufferPins[bufferId];
  gNoFdBufferPins[bufferId] = path;
  [gNoFdLock unlock];
  if (old.length > 0 && ![nofdCanonical(old) isEqualToString:nofdCanonical(path)]) {
    nofdUnpin(old);
  }
}

+ (void)releaseNofdPinForBuffer:(NSString *)bufferId {
  if (bufferId.length == 0) return;
  nofdEnsureLocks();
  [gNoFdLock lock];
  NSString *path = gNoFdBufferPins[bufferId];
  [gNoFdBufferPins removeObjectForKey:bufferId];
  [gNoFdLock unlock];
  if (path.length > 0) {
    nofdUnpin(path);
  }
}

+ (void)configureNoFdCacheMaxBytes:(NSNumber *)maxBytes
                          maxAgeMs:(NSNumber *)maxAgeMs
                             error:(NSString * _Nullable * _Nullable)errorCode
                           message:(NSString * _Nullable * _Nullable)errorMessage
{
  if (maxBytes != nil) {
    double v = maxBytes.doubleValue;
    if (v <= 0 || v != floor(v)) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"noFdCache.maxBytes must be an integer > 0";
      return;
    }
    gNoFdMaxBytes = (uint64_t)v;
  }
  if (maxAgeMs != nil) {
    double v = maxAgeMs.doubleValue;
    if (v < 0 || v != floor(v)) {
      if (errorCode) *errorCode = kFIOErrInvalidArgument;
      if (errorMessage) *errorMessage = @"noFdCache.maxAgeMs must be an integer >= 0";
      return;
    }
    gNoFdMaxAgeMs = (int64_t)v;
  }
  NSLog(@"[SherpaOnnxFileIO] nofd policy maxBytes=%llu maxAgeMs=%lld",
        gNoFdMaxBytes, (long long)gNoFdMaxAgeMs);
  nofdEvict();
}

+ (nullable NSString *)resolveSourceToFilePath:(NSDictionary *)source
                                         error:(NSString * _Nullable * _Nullable)errorCode
                                       message:(NSString * _Nullable * _Nullable)errorMessage
{
  FileIOReadHandle *handle = [self resolveSource:source error:errorCode message:errorMessage];
  if (!handle) return nil;

  if (handle.isFilePath) {
    // Keep security scoped URL alive — caller must call cleanup
    return handle.filePath;
  }

  // Stream → copy to temp
  NSString *tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"fileio_tmp_%@", [[NSUUID UUID] UUIDString]]];
  NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
  [out open];
  [handle.stream open];

  uint8_t buf[65536];
  NSInteger bytesRead;
  while ((bytesRead = [handle.stream read:buf maxLength:sizeof(buf)]) > 0) {
    [out write:buf maxLength:bytesRead];
  }
  [out close];
  [handle cleanup];

  return tmpPath;
}

@end
