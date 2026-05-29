#import "FileIOResolver.h"

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
