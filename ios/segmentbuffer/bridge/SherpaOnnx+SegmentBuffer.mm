#import "../../SherpaOnnx.h"
#include "../core/SherpaOnnx+SegmentBufferGlobals.h"

#ifdef __cplusplus
#include <algorithm>
#include <cstdio>
#include <random>
#include <sstream>
#include <unistd.h>

std::unordered_map<std::string, std::shared_ptr<SegOfflineEntry>> g_seg_offline;
std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> g_seg_live;
std::mutex g_seg_mutex;

namespace {
std::string seg_uuid() {
  static const char *kHex = "0123456789abcdef";
  std::random_device rd;
  std::mt19937 gen(rd());
  std::uniform_int_distribution<int> dis(0, 15);
  int groups[] = {8, 4, 4, 4, 12};
  std::stringstream ss;
  for (size_t g = 0; g < 5; ++g) {
    if (g > 0) ss << "-";
    for (int i = 0; i < groups[g]; ++i) ss << kHex[dis(gen)];
  }
  return ss.str();
}

std::string seg_new_id(const std::string &prefix) {
  return prefix + "_" + seg_uuid();
}

std::string segment_records_to_json(const std::vector<SegRecord> &segments) {
  NSMutableArray *arr = [NSMutableArray arrayWithCapacity:segments.size()];
  for (const auto &s : segments) {
    NSMutableDictionary *item = [NSMutableDictionary dictionary];
    item[@"id"] = [NSString stringWithUTF8String:s.id.c_str()];
    item[@"kind"] = [NSString stringWithUTF8String:s.kind.c_str()];
    item[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:s.sourceAudioBufferId.c_str()];
    item[@"startSample"] = @(s.startSample);
    item[@"endSample"] = @(s.endSample);
    item[@"sampleRate"] = @(s.sampleRate);
    item[@"durationMs"] = @(s.durationMs);
    if (s.hasConfidence) item[@"confidence"] = @(s.confidence);
    if (!s.payloadJson.empty()) {
      NSData *payloadData = [[NSString stringWithUTF8String:s.payloadJson.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *payloadObj = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
      if (payloadObj) item[@"payload"] = payloadObj;
    }
    [arr addObject:item];
  }
  NSDictionary *root = @{@"segments": arr};
  NSData *data = [NSJSONSerialization dataWithJSONObject:root options:0 error:nil];
  return data ? std::string((const char *)data.bytes, data.length) : std::string("{\"segments\":[]}");
}

std::vector<SegRecord> segment_records_from_json(const std::string &json) {
  std::vector<SegRecord> out;
  NSData *data = [[NSString stringWithUTF8String:json.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return out;
  NSDictionary *root = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![root isKindOfClass:[NSDictionary class]]) return out;
  NSArray *arr = root[@"segments"];
  if (![arr isKindOfClass:[NSArray class]]) return out;
  out.reserve(arr.count);
  for (id obj in arr) {
    if (![obj isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *d = (NSDictionary *)obj;
    SegRecord r;
    r.id = [d[@"id"] isKindOfClass:[NSString class]] ? [d[@"id"] UTF8String] : "";
    r.kind = [d[@"kind"] isKindOfClass:[NSString class]] ? [d[@"kind"] UTF8String] : "speech";
    r.sourceAudioBufferId = [d[@"sourceAudioBufferId"] isKindOfClass:[NSString class]] ? [d[@"sourceAudioBufferId"] UTF8String] : "";
    r.startSample = [d[@"startSample"] respondsToSelector:@selector(intValue)] ? [d[@"startSample"] intValue] : 0;
    r.endSample = [d[@"endSample"] respondsToSelector:@selector(intValue)] ? [d[@"endSample"] intValue] : 0;
    r.sampleRate = [d[@"sampleRate"] respondsToSelector:@selector(intValue)] ? [d[@"sampleRate"] intValue] : 0;
    r.durationMs = [d[@"durationMs"] respondsToSelector:@selector(intValue)] ? [d[@"durationMs"] intValue] : 0;
    if ([d[@"confidence"] respondsToSelector:@selector(doubleValue)]) {
      r.hasConfidence = true;
      r.confidence = [d[@"confidence"] doubleValue];
    }
    if ([d[@"payload"] isKindOfClass:[NSDictionary class]]) {
      NSData *payloadData = [NSJSONSerialization dataWithJSONObject:d[@"payload"] options:0 error:nil];
      if (payloadData) r.payloadJson = std::string((const char *)payloadData.bytes, payloadData.length);
    }
    out.push_back(std::move(r));
  }
  return out;
}

struct SegLiveEntry {
  enum State { RECORDING, FINISHED };
  enum SpoolingMode { SPOOL_OFF, SPOOL_AUTO, SPOOL_ON };

  std::string bufferId;
  State state = RECORDING;
  std::string sourceAudioBufferId;
  std::vector<SegRecord> segments;
  int maxSegments = 1000;
  int64_t evictedCount = 0;
  int64_t totalSegmentsWritten = 0;

  SpoolingMode spoolingMode = SPOOL_ON;
  std::string spoolPath;
  bool spoolTemporary = true;
  int64_t spoolThresholdBytes = 0;
  bool spoolReady = false;
  int64_t spoolBytes = 0;
  int64_t spoolEstimatedBytes = 0;
  std::string spoolFailureCode;
  std::string spoolFailureMessage;
  FILE *spoolFile = nullptr;

  std::mutex lock;
  std::mutex spoolLock;

  ~SegLiveEntry() { release(); }

  static std::string modeRaw(SpoolingMode mode) {
    switch (mode) {
      case SPOOL_OFF: return "off";
      case SPOOL_AUTO: return "auto";
      case SPOOL_ON: return "on";
    }
    return "off";
  }

  bool spoolEnabled() const { return spoolingMode != SPOOL_OFF; }

  [[noreturn]] void throwSpoolError(const std::string &code, const std::string &message) {
    spoolFailureCode = code;
    spoolFailureMessage = message;
    throw std::runtime_error(code + ": " + message);
  }

  std::string snapshotForSpoolLocked() { return segment_records_to_json(segments); }

  void closeSpoolFileLocked(bool flushFirst) {
    if (!spoolFile) return;
    if (flushFirst) fflush(spoolFile);
    fclose(spoolFile);
    spoolFile = nullptr;
  }

  void appendSnapshotRecordLocked(const std::string &snapshot) {
    if (!spoolFile) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Spool file not open for " + bufferId);
    const uint32_t len = (uint32_t)snapshot.size();
    unsigned char header[4] = {
      (unsigned char)(len & 0xFF),
      (unsigned char)((len >> 8) & 0xFF),
      (unsigned char)((len >> 16) & 0xFF),
      (unsigned char)((len >> 24) & 0xFF)
    };
    const int64_t recordLength = 4 + (int64_t)len;
    if (fseek(spoolFile, 0, SEEK_SET) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to seek spool for " + bufferId);
    if (fwrite(header, 1, 4, spoolFile) != 4) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to write spool header for " + bufferId);
    if (len > 0 && fwrite(snapshot.data(), 1, len, spoolFile) != len) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to write spool payload for " + bufferId);
    if (fflush(spoolFile) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to flush spool for " + bufferId);
    if (ftruncate(fileno(spoolFile), recordLength) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to truncate spool for " + bufferId);
    spoolBytes = recordLength;
    spoolReady = true;
  }

  void ensureSpoolWriterActivatedLocked(const std::string &snapshot) {
    if (spoolFile) return;
    if (spoolPath.empty()) throwSpoolError("SEGMENT_SPOOL_UNAVAILABLE", "Segment spool path is not configured for " + bufferId);
    NSString *spoolPathNs = [NSString stringWithUTF8String:spoolPath.c_str()];
    NSString *parentPath = [spoolPathNs stringByDeletingLastPathComponent];
    if (parentPath.length > 0) {
      [[NSFileManager defaultManager] createDirectoryAtPath:parentPath withIntermediateDirectories:YES attributes:nil error:nil];
    }
    spoolFile = fopen(spoolPath.c_str(), "wb");
    if (!spoolFile) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to create segment spool for " + bufferId);
    spoolBytes = 0;
    appendSnapshotRecordLocked(snapshot);
  }

  void maybeWriteSnapshotToSpool(const std::string &snapshot, bool mayActivateAuto) {
    if (!spoolEnabled()) return;
    std::lock_guard<std::mutex> lockGuard(spoolLock);
    if (!spoolFailureCode.empty()) throw std::runtime_error(spoolFailureCode + ": " + spoolFailureMessage);
    if (!spoolFile) {
      switch (spoolingMode) {
        case SPOOL_OFF: return;
        case SPOOL_ON:
          ensureSpoolWriterActivatedLocked(snapshot);
          return;
        case SPOOL_AUTO: {
          if (!mayActivateAuto) return;
          spoolEstimatedBytes += (int64_t)(4 + snapshot.size());
          if (spoolEstimatedBytes < std::max<int64_t>(0, spoolThresholdBytes)) {
            spoolReady = false;
            return;
          }
          ensureSpoolWriterActivatedLocked(snapshot);
          return;
        }
      }
    }
    appendSnapshotRecordLocked(snapshot);
  }

  void finalize_() {
    {
      std::lock_guard<std::mutex> stateLock(lock);
      if (state == FINISHED) throw std::runtime_error("SEGMENT_ALREADY_FINALIZED: Already finalized: " + bufferId);
      state = FINISHED;
    }
    if (spoolEnabled()) {
      std::lock_guard<std::mutex> guard(spoolLock);
      if (spoolFile) {
        if (fflush(spoolFile) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to finalize segment spool for " + bufferId);
        closeSpoolFileLocked(false);
      }
    }
  }

  std::vector<SegRecord> snapshotWindow() {
    std::lock_guard<std::mutex> guard(lock);
    return segments;
  }

  std::vector<SegRecord> snapshotFullIfSpooled() {
    if (!spoolEnabled()) throw std::runtime_error("SEGMENT_SPOOL_UNAVAILABLE: Segment spooling is disabled for " + bufferId);
    std::string path;
    {
      std::lock_guard<std::mutex> guard(spoolLock);
      if (!spoolFailureCode.empty()) throw std::runtime_error(spoolFailureCode + ": " + spoolFailureMessage);
      if (!spoolReady) throw std::runtime_error("SEGMENT_SPOOL_UNAVAILABLE: Segment spool is not ready for " + bufferId);
      if (spoolPath.empty()) throw std::runtime_error("SEGMENT_SPOOL_UNAVAILABLE: Segment spool path missing for " + bufferId);
      path = spoolPath;
      if (spoolFile) fflush(spoolFile);
    }
    FILE *reader = fopen(path.c_str(), "rb");
    if (!reader) throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to open segment spool for " + bufferId);
    unsigned char header[4];
    if (fread(header, 1, 4, reader) != 4) {
      fclose(reader);
      throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Corrupted segment spool header for " + bufferId);
    }
    uint32_t len = (uint32_t)header[0] | ((uint32_t)header[1] << 8) | ((uint32_t)header[2] << 16) | ((uint32_t)header[3] << 24);
    std::string payload;
    payload.resize(len);
    if (len > 0 && fread(payload.data(), 1, len, reader) != len) {
      fclose(reader);
      throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Truncated segment spool payload for " + bufferId);
    }
    if (fgetc(reader) != EOF) {
      fclose(reader);
      throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Unexpected trailing data in segment spool for " + bufferId);
    }
    fclose(reader);
    return segment_records_from_json(payload);
  }

  void release() {
    std::string pathToDelete;
    bool shouldDelete = false;
    {
      std::lock_guard<std::mutex> guard(spoolLock);
      closeSpoolFileLocked(false);
      if (spoolTemporary && !spoolPath.empty()) {
        pathToDelete = spoolPath;
        shouldDelete = true;
      }
    }
    if (shouldDelete) remove(pathToDelete.c_str());
  }
};

static NSDictionary *segRecordToDict(const SegRecord &r) {
  NSMutableDictionary *dict = [@{
    @"id": [NSString stringWithUTF8String:r.id.c_str()],
    @"kind": [NSString stringWithUTF8String:r.kind.c_str()],
    @"sourceAudioBufferId": [NSString stringWithUTF8String:r.sourceAudioBufferId.c_str()],
    @"startSample": @(r.startSample),
    @"endSample": @(r.endSample),
    @"sampleRate": @(r.sampleRate),
    @"durationMs": @(r.durationMs),
  } mutableCopy];
  if (r.hasConfidence) dict[@"confidence"] = @(r.confidence);
  if (!r.payloadJson.empty()) {
    NSData *payloadData = [[NSString stringWithUTF8String:r.payloadJson.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *payloadObj = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if (payloadObj) dict[@"payload"] = payloadObj;
  }
  return dict;
}
} // namespace

void seg_release_all_entries() {
  std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> liveEntries;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    liveEntries.swap(g_seg_live);
    g_seg_offline.clear();
  }
  for (auto &pair : liveEntries) {
    try { pair.second->release(); } catch (...) {}
  }
}
#endif

@implementation SherpaOnnx (SegmentBuffer)

- (void)createLiveSegmentBuffer:(NSDictionary *)options
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  try {
    NSDictionary *opts = [options isKindOfClass:[NSDictionary class]] ? options : @{};
    auto entry = std::make_shared<SegLiveEntry>();
    entry->bufferId = seg_new_id("seg_live");
    entry->sourceAudioBufferId = [opts[@"sourceAudioBufferId"] isKindOfClass:[NSString class]] ? [opts[@"sourceAudioBufferId"] UTF8String] : "";
    entry->maxSegments = [opts[@"maxSegments"] respondsToSelector:@selector(intValue)] ? std::max(1, [opts[@"maxSegments"] intValue]) : 1000;
    NSString *modeRaw = [opts[@"spoolingMode"] isKindOfClass:[NSString class]] ? opts[@"spoolingMode"] : @"on";
    if ([modeRaw isEqualToString:@"off"]) entry->spoolingMode = SegLiveEntry::SPOOL_OFF;
    else if ([modeRaw isEqualToString:@"auto"]) entry->spoolingMode = SegLiveEntry::SPOOL_AUTO;
    else entry->spoolingMode = SegLiveEntry::SPOOL_ON;

    NSString *spoolPath = [opts[@"spoolingPath"] isKindOfClass:[NSString class]] ? opts[@"spoolingPath"] : nil;
    if (entry->spoolingMode != SegLiveEntry::SPOOL_OFF) {
      if (spoolPath.length > 0) {
        entry->spoolPath = spoolPath.UTF8String;
      } else {
        NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
                         [NSString stringWithFormat:@"seg_spool_%@.json", [NSUUID UUID].UUIDString]];
        entry->spoolPath = tmp.UTF8String;
      }
    }
    if ([opts[@"spoolingTemporary"] respondsToSelector:@selector(boolValue)]) {
      entry->spoolTemporary = [opts[@"spoolingTemporary"] boolValue];
    } else {
      entry->spoolTemporary = (spoolPath.length == 0);
    }
    if ([opts[@"spoolingThresholdBytes"] respondsToSelector:@selector(longLongValue)]) {
      entry->spoolThresholdBytes = [opts[@"spoolingThresholdBytes"] longLongValue];
    }
    if (entry->spoolingMode == SegLiveEntry::SPOOL_ON) {
      entry->maybeWriteSnapshotToSpool(entry->snapshotForSpoolLocked(), false);
    }
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_live[entry->bufferId] = entry;
    }
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:entry->bufferId.c_str()],
      @"kind": @"liveSegmentBuffer",
      @"state": @"recording",
      @"segmentCount": @(0),
      @"totalSegmentsWritten": @(0),
      @"spoolMode": [NSString stringWithUTF8String:SegLiveEntry::modeRaw(entry->spoolingMode).c_str()],
      @"spoolEnabled": @(entry->spoolEnabled()),
      @"spoolReady": @(entry->spoolReady),
      @"spoolBytes": @(entry->spoolBytes),
    } mutableCopy];
    if (!entry->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:entry->sourceAudioBufferId.c_str()];
    if (!entry->spoolPath.empty()) out[@"spoolPath"] = [NSString stringWithUTF8String:entry->spoolPath.c_str()];
    resolve(out);
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)createEmptyOfflineSegmentBuffer:(NSDictionary *)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  auto entry = std::make_shared<SegOfflineEntry>();
  entry->bufferId = seg_new_id("seg_off");
  if ([options[@"sourceAudioBufferId"] isKindOfClass:[NSString class]]) {
    entry->sourceAudioBufferId = [options[@"sourceAudioBufferId"] UTF8String];
  }
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    g_seg_offline[entry->bufferId] = entry;
  }
  NSMutableDictionary *out = [@{
    @"bufferId": [NSString stringWithUTF8String:entry->bufferId.c_str()],
    @"kind": @"offlineSegmentBuffer",
    @"state": @"immutable",
    @"segmentCount": @((int)entry->segments.size()),
  } mutableCopy];
  if (!entry->sourceAudioBufferId.empty()) {
    out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:entry->sourceAudioBufferId.c_str()];
  }
  resolve(out);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)appendLiveSegment:(NSString *)liveBufferId
                     kind:(NSString *)kind
      sourceAudioBufferId:(NSString *)sourceAudioBufferId
              startSample:(double)startSample
                endSample:(double)endSample
               sampleRate:(double)sampleRate
               durationMs:(NSNumber *)durationMs
               confidence:(NSNumber *)confidence
                  payload:(NSDictionary *)payload
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_live.find(liveBufferId.UTF8String);
    if (it == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    entry = it->second;
  }
  try {
    std::lock_guard<std::mutex> lock(entry->lock);
    if (entry->state == SegLiveEntry::FINISHED) {
      throw std::runtime_error("SEGMENT_ALREADY_FINALIZED: Live segment buffer is finalized");
    }
    SegRecord seg;
    seg.id = "seg_" + seg_uuid();
    seg.kind = kind.length > 0 ? kind.UTF8String : "speech";
    seg.sourceAudioBufferId = sourceAudioBufferId.length > 0 ? sourceAudioBufferId.UTF8String : entry->sourceAudioBufferId;
    seg.startSample = (int)startSample;
    seg.endSample = (int)endSample;
    seg.sampleRate = (int)sampleRate;
    seg.durationMs = durationMs != nil ? durationMs.intValue : (int)(((seg.endSample - seg.startSample) * 1000.0) / std::max(1, seg.sampleRate));
    if (confidence != nil) {
      seg.hasConfidence = true;
      seg.confidence = confidence.doubleValue;
    }
    if ([payload isKindOfClass:[NSDictionary class]]) {
      NSData *pd = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
      if (pd) seg.payloadJson = std::string((const char *)pd.bytes, pd.length);
    }
    const int segmentIndex = (int)(entry->evictedCount + (int64_t)entry->segments.size());
    entry->segments.push_back(seg);
    std::string snapshot = entry->snapshotForSpoolLocked();
    if ((int)entry->segments.size() > entry->maxSegments) {
      entry->segments.erase(entry->segments.begin());
      entry->evictedCount++;
    }
    entry->totalSegmentsWritten++;
    entry->maybeWriteSnapshotToSpool(snapshot, true);
    resolve(@{ @"segmentId": [NSString stringWithUTF8String:seg.id.c_str()], @"segmentIndex": @(segmentIndex) });
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)finalizeLiveSegmentBuffer:(NSString *)liveBufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_live.find(liveBufferId.UTF8String);
    if (it == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    entry = it->second;
  }
  try {
    entry->finalize_();
    resolve(nil);
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)createOfflineSegmentBufferFromLive:(NSString *)liveBufferId
                                      mode:(NSString *)mode
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_live.find(liveBufferId.UTF8String);
    if (it == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    live = it->second;
  }
  try {
    std::vector<SegRecord> records;
    if ([mode isEqualToString:@"windowSnapshot"]) records = live->snapshotWindow();
    else if (mode == nil || [mode isEqualToString:@"fullIfSpooled"]) records = live->snapshotFullIfSpooled();
    else {
      reject(@"SEGMENT_INVALID_ARGUMENT", [NSString stringWithFormat:@"Unknown mode: %@", mode], nil);
      return;
    }
    auto off = std::make_shared<SegOfflineEntry>();
    off->bufferId = seg_new_id("seg_off");
    off->segments = records;
    off->sourceAudioBufferId = live->sourceAudioBufferId;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_offline[off->bufferId] = off;
    }
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:off->bufferId.c_str()],
      @"kind": @"offlineSegmentBuffer",
      @"state": @"immutable",
      @"segmentCount": @((int)off->segments.size()),
    } mutableCopy];
    if (!off->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:off->sourceAudioBufferId.c_str()];
    resolve(out);
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getPipelineSegmentBufferInfo:(NSString *)bufferId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto offIt = g_seg_offline.find(bufferId.UTF8String);
  if (offIt != g_seg_offline.end()) {
    auto &off = offIt->second;
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:off->bufferId.c_str()],
      @"kind": @"offlineSegmentBuffer",
      @"state": @"immutable",
      @"segmentCount": @((int)off->segments.size()),
    } mutableCopy];
    if (!off->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:off->sourceAudioBufferId.c_str()];
    resolve(out);
    return;
  }
  auto liveIt = g_seg_live.find(bufferId.UTF8String);
  if (liveIt != g_seg_live.end()) {
    auto &live = liveIt->second;
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:live->bufferId.c_str()],
      @"kind": @"liveSegmentBuffer",
      @"state": live->state == SegLiveEntry::RECORDING ? @"recording" : @"finished",
      @"segmentCount": @((int)live->segments.size()),
      @"totalSegmentsWritten": @(live->totalSegmentsWritten),
      @"spoolMode": [NSString stringWithUTF8String:SegLiveEntry::modeRaw(live->spoolingMode).c_str()],
      @"spoolEnabled": @(live->spoolEnabled()),
      @"spoolReady": @(live->spoolReady),
      @"spoolBytes": @(live->spoolBytes),
    } mutableCopy];
    if (!live->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:live->sourceAudioBufferId.c_str()];
    if (!live->spoolPath.empty()) out[@"spoolPath"] = [NSString stringWithUTF8String:live->spoolPath.c_str()];
    resolve(out);
    return;
  }
  reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Segment buffer not found: %@", bufferId], nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getOfflineSegmentBufferSegments:(NSString *)bufferId
                                  start:(double)start
                               maxCount:(double)maxCount
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_offline.find(bufferId.UTF8String);
    if (it == g_seg_offline.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Offline segment buffer not found: %@", bufferId], nil);
      return;
    }
    entry = it->second;
  }
  int s = (int)start;
  int c = (int)maxCount;
  if (s < 0 || c < 0) {
    reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
    return;
  }
  NSMutableArray *arr = [NSMutableArray array];
  int end = std::min((int)entry->segments.size(), s + c);
  for (int i = s; i < end; ++i) [arr addObject:segRecordToDict(entry->segments[i])];
  resolve(@{@"segments": arr});
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getLiveSegmentBufferSegments:(NSString *)liveBufferId
                          startIndex:(double)startIndex
                            maxCount:(double)maxCount
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_live.find(liveBufferId.UTF8String);
    if (it == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    entry = it->second;
  }
  int s = (int)startIndex;
  int c = (int)maxCount;
  if (s < 0 || c < 0) {
    reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
    return;
  }
  std::vector<SegRecord> snap;
  {
    std::lock_guard<std::mutex> guard(entry->lock);
    int end = std::min((int)entry->segments.size(), s + c);
    if (s < (int)entry->segments.size() && end > s) {
      snap.assign(entry->segments.begin() + s, entry->segments.begin() + end);
    }
  }
  NSMutableArray *arr = [NSMutableArray arrayWithCapacity:snap.size()];
  for (const auto &r : snap) [arr addObject:segRecordToDict(r)];
  resolve(@{@"segments": arr});
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getLiveSegmentBufferSegmentCount:(NSString *)liveBufferId
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto it = g_seg_live.find(liveBufferId.UTF8String);
  if (it == g_seg_live.end()) {
    reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
    return;
  }
  resolve(@((int)it->second->segments.size()));
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)releasePipelineSegmentBuffer:(NSString *)bufferId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto lit = g_seg_live.find(bufferId.UTF8String);
    if (lit != g_seg_live.end()) {
      live = lit->second;
      g_seg_live.erase(lit);
    }
    g_seg_offline.erase(bufferId.UTF8String);
  }
  if (live) {
    try { live->release(); } catch (...) {}
  }
  resolve(nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

@end
