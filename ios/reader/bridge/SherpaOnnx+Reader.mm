#import "../../SherpaOnnx.h"
#import "../../fileio/FileIOResolver.h"
#import "../../fileio/FileIOSeekable.h"

#include "ReaderBridge.h"
#include "ReaderFileHash.h"

#include <string>
#include <vector>

namespace {

dispatch_queue_t ReaderQueue() {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("com.sherpaonnx.reader", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

std::string Std(NSString *s) { return s ? std::string([s UTF8String]) : std::string(); }

NSString *NS(const std::string &s) { return [NSString stringWithUTF8String:s.c_str()] ?: @""; }

std::vector<std::string> StdStrings(NSArray *a) {
  std::vector<std::string> out;
  for (id v in a) out.push_back([v isKindOfClass:NSString.class] ? Std(v) : std::string());
  return out;
}

void Finish(bool ok, const std::string &json, const sherpa_onnx::reader::ReaderError &err,
            RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject) {
  if (ok) {
    resolve(NS(json));
  } else {
    NSString *code = err.code.empty() ? @"ERR_READER_INVALID_ARGUMENT" : NS(err.code);
    reject(code, [NSString stringWithFormat:@"%@: %@", code, NS(err.message)], nil);
  }
}

}  // namespace

@implementation SherpaOnnx (Reader)

RCT_EXPORT_METHOD(computeFileSourceSha256 : (NSDictionary *)source resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    NSString *ioErr = nil;
    NSString *ioMsg = nil;
    FileIOReadHandle *handle = [FileIOResolver resolveSource:source error:&ioErr message:&ioMsg];
    if (!handle) {
      reject(ioErr ?: @"ERR_READER_INVALID_ARGUMENT", ioMsg ?: @"Failed to resolve FileSource", nil);
      return;
    }
    NSString *seekErr = nil;
    NSString *seekMsg = nil;
    const auto src = SherpaOnnxSeekableSourceFromHandle(handle, @"ERR_READER_INVALID_ARGUMENT",
                                                        @"SherpaOnnx:reader", &seekErr, &seekMsg);
    std::string hex;
    std::string err;
    const bool ok = !src.path.empty() && sherpa_onnx::reader::Sha256HexOfSource(src, &hex, &err);
    [handle cleanup];
    if (!ok) {
      reject(seekErr ?: @"ERR_READER_INVALID_ARGUMENT",
             seekMsg ?: (err.empty() ? @"Source is not readable" : NS(err)), nil);
      return;
    }
    resolve(NS(hex));
  });
}

RCT_EXPORT_METHOD(createReaderDocument : (NSString *)textBufferId imageBufferId : (
                      NSString *)imageBufferId documentKey : (NSString *)documentKey resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeCreateDocument(
        Std(textBufferId), Std(imageBufferId), Std(documentKey), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(createReaderPagesDocument : (NSString *)imageBufferId documentKey : (
                      NSString *)documentKey resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeCreatePagesDocument(Std(imageBufferId),
                                                                  Std(documentKey), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(attachReaderPageText : (NSString *)documentId textBufferId : (
                      NSString *)textBufferId resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeAttachPageText(Std(documentId), Std(textBufferId),
                                                             &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(getReaderPages : (NSString *)documentId resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeGetPages(Std(documentId), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(insertReaderSection : (NSString *)documentId after : (NSString *)
                      after sectionId : (NSString *)sectionId title : (NSString *)
                          title keys : (NSArray *)keys types : (NSArray *)types texts : (
                              NSArray *)texts levels : (NSArray *)levels resolve : (
                                  RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                                  reject) {
  std::vector<int> lv;
  for (id v in levels) lv.push_back([v respondsToSelector:@selector(intValue)] ? [v intValue] : 0);
  const auto k = StdStrings(keys);
  const auto ty = StdStrings(types);
  const auto tx = StdStrings(texts);
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeInsertSection(
        Std(documentId), Std(after), Std(sectionId), Std(title), k, ty, tx, lv, &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(removeReaderSection : (NSString *)documentId sectionId : (NSString *)
                      sectionId resolve : (RCTPromiseResolveBlock)
                          resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok =
        sherpa_onnx::reader::BridgeRemoveSection(Std(documentId), Std(sectionId), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(getReaderBlocks : (NSString *)documentId start : (double)start maxCount : (
                      double)maxCount includeText : (BOOL)includeText resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const int max = (int)MIN(4096.0, MAX(0.0, maxCount));
    const bool ok = sherpa_onnx::reader::BridgeGetBlocks(Std(documentId), (int)start, max,
                                                        includeText, &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(findReaderBlockByHash : (NSString *)documentId textHash : (NSString *)
                      textHash hintBlockId : (NSString *)hintBlockId resolve : (
                          RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeFindBlockByHash(
        Std(documentId), Std(textHash), Std(hintBlockId), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(mapReaderTextRanges : (NSString *)documentId starts : (NSArray *)
                      starts ends : (NSArray *)ends sliceBufferId : (NSString *)
                          sliceBufferId resolve : (RCTPromiseResolveBlock)
                              resolve reject : (RCTPromiseRejectBlock)reject) {
  std::vector<int> s;
  std::vector<int> e;
  s.reserve(starts.count);
  e.reserve(ends.count);
  for (id v in starts) s.push_back([v respondsToSelector:@selector(intValue)] ? [v intValue] : 0);
  for (id v in ends) e.push_back([v respondsToSelector:@selector(intValue)] ? [v intValue] : 0);
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok =
        sherpa_onnx::reader::BridgeMapTextRanges(Std(documentId), s, e, Std(sliceBufferId), &json,
                                                 &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(createReaderTextSlice : (NSString *)documentId fromBlockId : (
                      NSString *)fromBlockId fromOffset : (double)fromOffset toBlockId : (
                          NSString *)toBlockId maxLength : (double)maxLength resolve : (
                              RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                              reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeCreateTextSlice(
        Std(documentId), Std(fromBlockId), (int)fromOffset, Std(toBlockId), (int)maxLength, &json,
        &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(saveReaderRecognition : (NSString *)documentId destination : (
                      NSDictionary *)destination modelId : (NSString *)modelId overwrite : (
                          BOOL)overwrite createParentDirectories : (BOOL)
                              createParentDirectories resolve : (RCTPromiseResolveBlock)
                                  resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::vector<uint8_t> bytes;
    int pages = 0;
    sherpa_onnx::reader::ReaderError err;
    if (!sherpa_onnx::reader::BridgeEncodeRecognition(Std(documentId), Std(modelId), &bytes,
                                                      &pages, &err)) {
      Finish(false, "", err, resolve, reject);
      return;
    }
    NSString *errCode = nil;
    NSString *errMsg = nil;
    FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination
                                                     overwrite:overwrite
                                       createParentDirectories:createParentDirectories
                                                         error:&errCode
                                                       message:&errMsg];
    if (!wh) {
      reject(errCode ?: @"FILEIO_RESOLVE_ERROR", errMsg ?: @"Failed to resolve destination", nil);
      return;
    }
    NSData *data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
    if (wh.isFilePath) {
      NSError *writeErr = nil;
      if (![data writeToFile:wh.filePath options:NSDataWritingAtomic error:&writeErr]) {
        [wh cleanup];
        reject(@"ERR_READER_SIDECAR_WRITE", writeErr.localizedDescription ?: @"Write failed",
               writeErr);
        return;
      }
    } else if (wh.stream != nil) {
      [wh.stream open];
      const NSInteger written = [wh.stream write:(const uint8_t *)bytes.data()
                                       maxLength:bytes.size()];
      [wh.stream close];
      if (written != (NSInteger)bytes.size()) {
        [wh cleanup];
        reject(@"ERR_READER_SIDECAR_WRITE", @"Write failed", nil);
        return;
      }
    }
    NSString *outputPath = wh.resultPath ?: wh.filePath ?: @"";
    const BOOL isPath = wh.isFilePath;
    [wh cleanup];
    resolve(@{
      @"pages" : @(pages),
      @"outputKind" : isPath ? @"path" : @"stream",
      @"outputPath" : outputPath,
    });
  });
}

RCT_EXPORT_METHOD(loadReaderRecognition : (NSString *)documentId source : (
                      NSDictionary *)source modelId : (NSString *)modelId resolve : (
                          RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    NSString *errCode = nil;
    NSString *errMsg = nil;
    FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
    if (!rh) {
      reject(errCode ?: @"FILEIO_RESOLVE_ERROR", errMsg ?: @"Failed to resolve source", nil);
      return;
    }
    NSData *data = nil;
    if (rh.isFilePath) {
      data = [NSData dataWithContentsOfFile:rh.filePath];
    } else if (rh.stream != nil) {
      [rh.stream open];
      NSMutableData *buffer = [NSMutableData data];
      uint8_t chunk[65536];
      NSInteger n = 0;
      while ((n = [rh.stream read:chunk maxLength:sizeof(chunk)]) > 0) {
        [buffer appendBytes:chunk length:n];
      }
      [rh.stream close];
      data = buffer;
    }
    [rh cleanup];
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeLoadRecognition(
        Std(documentId), static_cast<const uint8_t *>(data.bytes), data.length, Std(modelId), &json,
        &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(getReaderToc : (NSString *)documentId resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(ReaderQueue(), ^{
    std::string json;
    sherpa_onnx::reader::ReaderError err;
    const bool ok = sherpa_onnx::reader::BridgeGetToc(Std(documentId), &json, &err);
    Finish(ok, json, err, resolve, reject);
  });
}

RCT_EXPORT_METHOD(releaseReaderDocument : (NSString *)documentId resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  resolve(@(sherpa_onnx::reader::BridgeReleaseDocument(Std(documentId))));
}

@end
