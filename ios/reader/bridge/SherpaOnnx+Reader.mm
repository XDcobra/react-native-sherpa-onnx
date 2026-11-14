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

RCT_EXPORT_METHOD(releaseReaderDocument : (NSString *)documentId resolve : (
                      RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  resolve(@(sherpa_onnx::reader::BridgeReleaseDocument(Std(documentId))));
}

@end
