#import "../../SherpaOnnx.h"
#import <Foundation/Foundation.h>
#include "../core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../vad/core/VadRuntime.h"
#include "pyannote-segmentation-session.h"

#ifdef __cplusplus
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <memory>
#include <random>
#include <sstream>
#include <unordered_set>
#include <vector>
#include <unistd.h>
#include <zlib.h>

extern "C" bool sherpaonnx_punct_offline_add_punctuation_if_exists(
  const std::string &instanceId,
  const std::string &text,
  std::string *outText);
extern "C" bool sherpaonnx_punct_online_add_punctuation_if_exists(
  const std::string &instanceId,
  const std::string &text,
  std::string *outText);
extern "C" bool sherpaonnx_punct_offline_has_instance(const std::string &instanceId);
extern "C" bool sherpaonnx_punct_online_has_instance(const std::string &instanceId);

#include "../../punctuation/core/PunctuationTextInputNormalization.hpp"

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

/**
 * Sentence / clause boundaries for text segmentation: Latin punctuation, newline,
 * and common full-width CJK marks plus Arabic question mark and Devanagari danda.
 * Uses NSString so UTF-8 boundaries are not split mid-codepoint (find_first_of on bytes is unsafe for multibyte UTF-8).
 */
static NSCharacterSet *seg_text_sentence_boundary_charset(void) {
  static NSCharacterSet *set = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSMutableCharacterSet *m =
      [NSMutableCharacterSet characterSetWithCharactersInString:@".!?\n;:"];
    [m addCharactersInString:@"\u3002\uFF01\uFF1F\uFF61\u061F\u0964\u0965"];
    set = [m copy];
  });
  return set;
}

/** UTF-8 byte length of `remaining` through and including the first boundary character, or npos if none. */
static size_t seg_utf8_sentence_boundary_prefix_len_first(const std::string &remaining) {
  if (remaining.empty()) {
    return std::string::npos;
  }
  NSString *ns = [[NSString alloc] initWithBytes:remaining.data()
                                            length:remaining.size()
                                          encoding:NSUTF8StringEncoding];
  if (!ns) {
    return std::string::npos;
  }
  NSRange r = [ns rangeOfCharacterFromSet:seg_text_sentence_boundary_charset()
                                  options:0
                                    range:NSMakeRange(0, ns.length)];
  if (r.location == NSNotFound) {
    return std::string::npos;
  }
  NSString *through = [ns substringToIndex:r.location + r.length];
  return (size_t)[through lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}

/** UTF-8 byte length through and including the last boundary character in `s`, or npos. */
static size_t seg_utf8_sentence_boundary_prefix_len_last(const std::string &s) {
  if (s.empty()) {
    return std::string::npos;
  }
  NSString *ns = [[NSString alloc] initWithBytes:s.data()
                                            length:s.size()
                                          encoding:NSUTF8StringEncoding];
  if (!ns) {
    return std::string::npos;
  }
  NSRange r = [ns rangeOfCharacterFromSet:seg_text_sentence_boundary_charset()
                                   options:NSBackwardsSearch
                                     range:NSMakeRange(0, ns.length)];
  if (r.location == NSNotFound) {
    return std::string::npos;
  }
  NSString *through = [ns substringToIndex:r.location + r.length];
  return (size_t)[through lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}

/** Byte length through first boundary (forward scan); uses UTF-8 NSString suffix matching. */
static size_t seg_utf8_custom_delimiter_prefix_len_first(
  const std::string &remaining,
  const std::vector<std::string> &delims
) {
  if (remaining.empty() || delims.empty()) {
    return std::string::npos;
  }
  NSString *ns =
    [[NSString alloc] initWithBytes:remaining.data()
                               length:remaining.size()
                             encoding:NSUTF8StringEncoding];
  if (!ns) {
    return std::string::npos;
  }
  for (NSUInteger len = 1; len <= ns.length; len++) {
    NSString *prefix = [ns substringToIndex:len];
    for (const auto &d : delims) {
      if (d.empty()) {
        continue;
      }
      NSString *ds = [NSString stringWithUTF8String:d.c_str()];
      if (!ds || ds.length == 0) {
        continue;
      }
      if ([prefix hasSuffix:ds]) {
        return (size_t)[prefix lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
      }
    }
  }
  return std::string::npos;
}

/** Byte length through last boundary in `s` (live text commit-at-last-boundary). */
static size_t seg_utf8_custom_delimiter_prefix_len_last(
  const std::string &s,
  const std::vector<std::string> &delims
) {
  if (s.empty() || delims.empty()) {
    return std::string::npos;
  }
  NSString *ns =
    [[NSString alloc] initWithBytes:s.data()
                               length:s.size()
                             encoding:NSUTF8StringEncoding];
  if (!ns) {
    return std::string::npos;
  }
  for (NSUInteger len = ns.length; len >= 1; len--) {
    NSString *prefix = [ns substringToIndex:len];
    for (const auto &d : delims) {
      if (d.empty()) {
        continue;
      }
      NSString *ds = [NSString stringWithUTF8String:d.c_str()];
      if (!ds || ds.length == 0) {
        continue;
      }
      if ([prefix hasSuffix:ds]) {
        return (size_t)[prefix lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
      }
    }
  }
  return std::string::npos;
}

static NSString *seg_validate_sentence_boundary_chars_field(NSDictionary *policy) {
  id raw = policy[@"sentenceBoundaryChars"];
  if (raw == nil) {
    return nil;
  }
  if (![raw isKindOfClass:[NSArray class]]) {
    return @"sentenceBoundaryChars must be an array of strings";
  }
  NSArray *arr = (NSArray *)raw;
  if (arr.count > 128) {
    return @"sentenceBoundaryChars must have at most 128 entries";
  }
  for (id o in arr) {
    if (![o isKindOfClass:[NSString class]]) {
      return @"sentenceBoundaryChars must only contain strings";
    }
    NSString *s = (NSString *)o;
    if (s.length == 0) {
      continue;
    }
    if (s.length > 64) {
      return @"sentenceBoundaryChars entries must be at most 64 characters";
    }
  }
  return nil;
}

bool seg_is_valid_kind(const std::string &kind) {
  return kind == "speech" || kind == "alignment" || kind == "diarization";
}

bool seg_validate_strict_speech_payload(NSDictionary *payload, NSString **errorMessage) {
  if (![payload isKindOfClass:[NSDictionary class]]) {
    if (errorMessage) *errorMessage = @"speech payload is required and must include source";
    return false;
  }
  NSString *source = [payload[@"source"] isKindOfClass:[NSString class]] ? payload[@"source"] : nil;
  if (source.length == 0) {
    if (errorMessage) *errorMessage = @"speech payload.source must be one of vad, stt, tts, sid";
    return false;
  }
  NSSet<NSString *> *allowed = nil;
  if ([source isEqualToString:@"vad"]) {
    allowed = [NSSet setWithArray:@[@"source", @"engine", @"decision", @"score", @"__annotationReason", @"__annotationSource", @"__annotationCreatedAtMs"]];
  } else if ([source isEqualToString:@"stt"]) {
    allowed = [NSSet setWithArray:@[@"source", @"transcript", @"tokenCount", @"isFinal", @"__annotationReason", @"__annotationSource", @"__annotationCreatedAtMs"]];
  } else if ([source isEqualToString:@"tts"]) {
    allowed = [NSSet setWithArray:@[@"source", @"text", @"chunkIndex", @"isFinalChunk", @"__annotationReason", @"__annotationSource", @"__annotationCreatedAtMs"]];
  } else if ([source isEqualToString:@"sid"]) {
    allowed = [NSSet setWithArray:@[@"source", @"speakerName", @"__annotationReason", @"__annotationSource", @"__annotationCreatedAtMs"]];
  } else if ([source isEqualToString:@"manual"]) {
    allowed = [NSSet setWithArray:@[@"source", @"__annotationReason", @"__annotationSource", @"__annotationCreatedAtMs"]];
  } else {
    if (errorMessage) *errorMessage = @"speech payload.source must be one of vad, stt, tts, sid, manual";
    return false;
  }

  for (NSString *key in payload) {
    if (![allowed containsObject:key]) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"speech payload.%@ is not allowed for source=%@", key, source];
      return false;
    }
  }

  if ([source isEqualToString:@"vad"] && payload[@"engine"] != nil) {
    NSString *engine = [payload[@"engine"] isKindOfClass:[NSString class]] ? payload[@"engine"] : nil;
    if (!(engine && [engine isEqualToString:@"vad"])) {
      if (errorMessage) *errorMessage = @"speech payload.engine must be vad";
      return false;
    }
  }
  if ([source isEqualToString:@"vad"] && payload[@"decision"] != nil) {
    NSString *decision = [payload[@"decision"] isKindOfClass:[NSString class]] ? payload[@"decision"] : nil;
    if (!(decision && [decision isEqualToString:@"model"])) {
      if (errorMessage) *errorMessage = @"speech payload.decision must be model";
      return false;
    }
  }
  if ([source isEqualToString:@"sid"]) {
    if (![[payload allKeys] containsObject:@"speakerName"]) {
      if (errorMessage) *errorMessage = @"speech payload.speakerName is required for source=sid (string or null)";
      return false;
    }
    id speakerName = payload[@"speakerName"];
    if (!(speakerName == [NSNull null] || [speakerName isKindOfClass:[NSString class]])) {
      if (errorMessage) *errorMessage = @"speech payload.speakerName must be a string or null";
      return false;
    }
  }
  return true;
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

} // namespace

struct SegLiveEntry {
  static constexpr uint32_t kMagic = 0x32474553; // SEG2
  static constexpr uint16_t kVersion = 2;
  static constexpr uint16_t kRecordSegmentAppend = 1;
  static constexpr uint16_t kRecordCheckpointMark = 2;
  static constexpr uint16_t kRecordFinalizeMark = 3;
  static constexpr int kHeaderBytes = 16;
  static constexpr int kCheckpointEveryEvents = 128;
  static constexpr int64_t kCheckpointEveryBytes = 1048576;
  enum State { RECORDING, FINISHED };
  enum SpoolingMode { SPOOL_OFF, SPOOL_AUTO, SPOOL_ON };

  std::string bufferId;
  State state = RECORDING;
  std::string sourceAudioBufferId;
  std::vector<SegRecord> segments;
  int maxSegments = 4096;
  int64_t evictedCount = 0;
  int64_t totalSegmentsWritten = 0;

  SpoolingMode spoolingMode = SPOOL_ON;
  std::string spoolPath;
  bool spoolTemporary = true;
  int64_t spoolThresholdBytes = 0;
  bool spoolReady = false;
  int64_t spoolBytes = 0;
  int64_t spoolEstimatedBytes = 0;
  int64_t journalBytesSinceCheckpoint = 0;
  int journalEventCount = 0;
  std::string spoolFailureCode;
  std::string spoolFailureMessage;
  FILE *journalFile = nullptr;
  bool emitSegmentAppended = false;
  int64_t segmentEventMinIntervalMs = 0;
  int64_t lastSegmentEmitWallMs = 0;
  std::function<void(
    const std::string &liveBufferId,
    const SegRecord &rec,
    int segmentIndex,
    int totalSegments)>
    segmentAppendedEmitter;

  std::mutex lock;
  std::mutex spoolLock;
  std::mutex commitListenerMutex;
  std::mutex cursorMutex;
  std::atomic<int> nextCommitListenerToken{0};
  std::atomic<int> nextCursorId{0};

  struct NativeCommitListener {
    int token;
    std::function<void(const std::string &, int, const SegRecord &)> callback;
  };

  struct SegmentCursor {
    int cursorId;
    std::atomic<int> readPos{0};
  };

  std::vector<NativeCommitListener> commitListeners;
  std::unordered_map<int, std::unique_ptr<SegmentCursor>> cursors;

  ~SegLiveEntry() { release(); }

  int addCommitListener(
    std::function<void(const std::string &, int, const SegRecord &)> listener
  ) {
    int token = nextCommitListenerToken.fetch_add(1);
    std::lock_guard<std::mutex> lockGuard(commitListenerMutex);
    commitListeners.push_back({token, std::move(listener)});
    return token;
  }

  void removeCommitListener(int token) {
    std::lock_guard<std::mutex> lockGuard(commitListenerMutex);
    commitListeners.erase(
      std::remove_if(
        commitListeners.begin(),
        commitListeners.end(),
        [token](const NativeCommitListener &entry) {
          return entry.token == token;
        }
      ),
      commitListeners.end()
    );
  }

  void notifyCommitListeners(const std::string &segmentId, int segmentIndex, const SegRecord &record) {
    std::vector<std::function<void(const std::string &, int, const SegRecord &)>> callbacks;
    {
      std::lock_guard<std::mutex> lockGuard(commitListenerMutex);
      callbacks.reserve(commitListeners.size());
      for (auto &entry : commitListeners) {
        callbacks.push_back(entry.callback);
      }
    }
    for (auto &callback : callbacks) {
      callback(segmentId, segmentIndex, record);
    }
  }

  int createSegmentCursor() {
    int cursorId = nextCursorId.fetch_add(1);
    auto cursor = std::make_unique<SegmentCursor>();
    cursor->cursorId = cursorId;
    cursor->readPos.store(0);
    std::lock_guard<std::mutex> lockGuard(cursorMutex);
    cursors[cursorId] = std::move(cursor);
    return cursorId;
  }

  std::vector<SegRecord> drainSegments(int cursorId, int maxCount, int *startIndex) {
    if (maxCount <= 0) {
      if (startIndex) *startIndex = -1;
      return {};
    }

    std::unique_lock<std::mutex> cursorLock(cursorMutex);
    auto it = cursors.find(cursorId);
    if (it == cursors.end()) {
      if (startIndex) *startIndex = -1;
      return {};
    }
    int position = it->second->readPos.load();
    cursorLock.unlock();

    std::lock_guard<std::mutex> segmentLock(lock);
    if (position >= static_cast<int>(segments.size())) {
      if (startIndex) *startIndex = -1;
      return {};
    }

    int end = std::min(position + maxCount, static_cast<int>(segments.size()));
    std::vector<SegRecord> result(segments.begin() + position, segments.begin() + end);
    if (startIndex) {
      *startIndex = static_cast<int>(evictedCount + static_cast<int64_t>(position));
    }

    cursorLock.lock();
    auto itAfter = cursors.find(cursorId);
    if (itAfter != cursors.end()) {
      itAfter->second->readPos.store(end);
    }
    return result;
  }

  void releaseSegmentCursor(int cursorId) {
    std::lock_guard<std::mutex> lockGuard(cursorMutex);
    cursors.erase(cursorId);
  }

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
  std::string journalPath() const { return spoolPath + ".segj"; }
  std::string checkpointPath() const { return spoolPath + ".segc"; }

  uint32_t computeSpoolChecksum(const std::string &payload) const {
    uLong crc = ::crc32(0L, Z_NULL, 0);
    if (!payload.empty()) {
      crc = ::crc32(
        crc,
        reinterpret_cast<const Bytef *>(payload.data()),
        static_cast<uInt>(payload.size())
      );
    }
    return static_cast<uint32_t>(crc);
  }

  bool isKnownRecordType(uint16_t type) const {
    return type == kRecordSegmentAppend ||
      type == kRecordCheckpointMark ||
      type == kRecordFinalizeMark;
  }

  void decodeHeaderOrThrow(
    const unsigned char *header,
    const std::string &path,
    uint16_t *recordType,
    uint32_t *payloadLength,
    uint32_t *checksum
  ) const {
    uint32_t magic =
      (static_cast<uint32_t>(header[0])) |
      (static_cast<uint32_t>(header[1]) << 8) |
      (static_cast<uint32_t>(header[2]) << 16) |
      (static_cast<uint32_t>(header[3]) << 24);
    uint16_t version =
      (static_cast<uint16_t>(header[4])) |
      (static_cast<uint16_t>(header[5]) << 8);
    uint16_t type =
      (static_cast<uint16_t>(header[6])) |
      (static_cast<uint16_t>(header[7]) << 8);
    uint32_t len =
      (static_cast<uint32_t>(header[8])) |
      (static_cast<uint32_t>(header[9]) << 8) |
      (static_cast<uint32_t>(header[10]) << 16) |
      (static_cast<uint32_t>(header[11]) << 24);
    uint32_t crc =
      (static_cast<uint32_t>(header[12])) |
      (static_cast<uint32_t>(header[13]) << 8) |
      (static_cast<uint32_t>(header[14]) << 16) |
      (static_cast<uint32_t>(header[15]) << 24);

    if (magic != kMagic || version != kVersion || !isKnownRecordType(type)) {
      throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Unexpected segment spool record format in " + path);
    }

    *recordType = type;
    *payloadLength = len;
    *checksum = crc;
  }

  void closeSpoolFileLocked(bool flushFirst) {
    if (!journalFile) return;
    if (flushFirst) fflush(journalFile);
    fclose(journalFile);
    journalFile = nullptr;
  }

  void appendJournalRecordLocked(uint16_t type, const std::string &payload) {
    if (!journalFile) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Segment journal not open for " + bufferId);
    const uint32_t len = (uint32_t)payload.size();
    const uint32_t crc = computeSpoolChecksum(payload);
    unsigned char header[kHeaderBytes] = {
      (unsigned char)(kMagic & 0xFF),
      (unsigned char)((kMagic >> 8) & 0xFF),
      (unsigned char)((kMagic >> 16) & 0xFF),
      (unsigned char)((kMagic >> 24) & 0xFF),
      (unsigned char)(kVersion & 0xFF),
      (unsigned char)((kVersion >> 8) & 0xFF),
      (unsigned char)(type & 0xFF),
      (unsigned char)((type >> 8) & 0xFF),
      (unsigned char)(len & 0xFF),
      (unsigned char)((len >> 8) & 0xFF),
      (unsigned char)((len >> 16) & 0xFF),
      (unsigned char)((len >> 24) & 0xFF),
      (unsigned char)(crc & 0xFF),
      (unsigned char)((crc >> 8) & 0xFF),
      (unsigned char)((crc >> 16) & 0xFF),
      (unsigned char)((crc >> 24) & 0xFF)
    };
    if (fseek(journalFile, 0, SEEK_END) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to seek segment journal for " + bufferId);
    if (fwrite(header, 1, kHeaderBytes, journalFile) != kHeaderBytes) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to write segment journal header for " + bufferId);
    if (len > 0 && fwrite(payload.data(), 1, len, journalFile) != len) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to write segment journal payload for " + bufferId);
    if (fflush(journalFile) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to flush segment journal for " + bufferId);
    spoolBytes = ftell(journalFile);
    spoolReady = true;
  }

  void writeCheckpointSnapshotLocked(const std::string &snapshot) {
    std::string cpPath = checkpointPath();
    std::string tmpPath = cpPath + ".tmp";
    FILE *tmp = fopen(tmpPath.c_str(), "wb");
    if (!tmp) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to create segment checkpoint for " + bufferId);
    const uint32_t len = (uint32_t)snapshot.size();
    const uint32_t crc = computeSpoolChecksum(snapshot);
    unsigned char header[kHeaderBytes] = {
      (unsigned char)(kMagic & 0xFF), (unsigned char)((kMagic >> 8) & 0xFF), (unsigned char)((kMagic >> 16) & 0xFF), (unsigned char)((kMagic >> 24) & 0xFF),
      (unsigned char)(kVersion & 0xFF), (unsigned char)((kVersion >> 8) & 0xFF),
      (unsigned char)(kRecordCheckpointMark & 0xFF), (unsigned char)((kRecordCheckpointMark >> 8) & 0xFF),
      (unsigned char)(len & 0xFF), (unsigned char)((len >> 8) & 0xFF), (unsigned char)((len >> 16) & 0xFF), (unsigned char)((len >> 24) & 0xFF),
      (unsigned char)(crc & 0xFF), (unsigned char)((crc >> 8) & 0xFF), (unsigned char)((crc >> 16) & 0xFF), (unsigned char)((crc >> 24) & 0xFF)
    };
    if (fwrite(header, 1, kHeaderBytes, tmp) != kHeaderBytes || (len > 0 && fwrite(snapshot.data(), 1, len, tmp) != len)) {
      fclose(tmp);
      remove(tmpPath.c_str());
      throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to write segment checkpoint payload for " + bufferId);
    }
    fflush(tmp);
    fclose(tmp);
    remove(cpPath.c_str());
    if (rename(tmpPath.c_str(), cpPath.c_str()) != 0) {
      remove(tmpPath.c_str());
      throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to finalize segment checkpoint for " + bufferId);
    }
  }

  void ensureSpoolWriterActivatedLocked(const std::string &snapshot) {
    if (journalFile) return;
    if (spoolPath.empty()) throwSpoolError("SEGMENT_SPOOL_UNAVAILABLE", "Segment spool path is not configured for " + bufferId);
    NSString *spoolPathNs = [NSString stringWithUTF8String:spoolPath.c_str()];
    NSString *parentPath = [spoolPathNs stringByDeletingLastPathComponent];
    if (parentPath.length > 0) {
      [[NSFileManager defaultManager] createDirectoryAtPath:parentPath withIntermediateDirectories:YES attributes:nil error:nil];
    }
    journalFile = fopen(journalPath().c_str(), "ab+");
    if (!journalFile) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to create segment journal for " + bufferId);
    spoolBytes = 0;
    writeCheckpointSnapshotLocked(snapshot);
    appendJournalRecordLocked(kRecordCheckpointMark, "{}");
    journalBytesSinceCheckpoint = 0;
    journalEventCount = 0;
  }

  void activateSpoolIfNeeded() {
    if (!spoolEnabled()) return;
    std::lock_guard<std::mutex> lockGuard(spoolLock);
    if (!spoolFailureCode.empty() || journalFile) return;
    if (spoolingMode == SPOOL_ON) {
      ensureSpoolWriterActivatedLocked(segment_records_to_json({}));
    }
  }

  void maybeAppendSegmentToSpool(
    const SegRecord &seg,
    bool mayActivateAuto,
    const std::string &checkpointSnapshot
  ) {
    if (!spoolEnabled()) return;
    std::lock_guard<std::mutex> lockGuard(spoolLock);
    if (!spoolFailureCode.empty()) {
      throw std::runtime_error(spoolFailureCode + ": " + spoolFailureMessage);
    }
    if (!journalFile) {
      switch (spoolingMode) {
        case SPOOL_OFF:
          return;
        case SPOOL_ON:
          ensureSpoolWriterActivatedLocked(checkpointSnapshot);
          break;
        case SPOOL_AUTO: {
          if (!mayActivateAuto) return;
          const std::vector<SegRecord> one = {seg};
          const std::string estimated = segment_records_to_json(one);
          spoolEstimatedBytes += (int64_t)(kHeaderBytes + estimated.size());
          if (spoolEstimatedBytes < std::max<int64_t>(0, spoolThresholdBytes)) {
            spoolReady = false;
            return;
          }
          ensureSpoolWriterActivatedLocked(checkpointSnapshot);
          break;
        }
      }
    }
    if (!journalFile) return;

    const std::vector<SegRecord> one = {seg};
    const std::string payload = segment_records_to_json(one);
    appendJournalRecordLocked(kRecordSegmentAppend, payload);
    journalEventCount += 1;
    journalBytesSinceCheckpoint += (kHeaderBytes + payload.size());
    if (journalEventCount >= kCheckpointEveryEvents ||
        journalBytesSinceCheckpoint >= kCheckpointEveryBytes) {
      writeCheckpointSnapshotLocked(checkpointSnapshot);
      fclose(journalFile);
      journalFile = fopen(journalPath().c_str(), "wb");
      if (!journalFile) {
        throwSpoolError(
          "SEGMENT_SPOOL_WRITE_FAILED",
          "Failed to rotate segment journal for " + bufferId);
      }
      appendJournalRecordLocked(kRecordCheckpointMark, "{}");
      journalBytesSinceCheckpoint = 0;
      journalEventCount = 0;
    }
  }

  void finalize_() {
    {
      std::lock_guard<std::mutex> stateLock(lock);
      if (state == FINISHED) throw std::runtime_error("SEGMENT_ALREADY_FINALIZED: Already finalized: " + bufferId);
      state = FINISHED;
    }
    if (spoolEnabled()) {
      std::lock_guard<std::mutex> guard(spoolLock);
      if (journalFile) {
        appendJournalRecordLocked(kRecordFinalizeMark, "{}");
        if (fflush(journalFile) != 0) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to finalize segment spool for " + bufferId);
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
      if (journalFile) fflush(journalFile);
    }
    std::string cpPath = path + ".segc";
    std::string jPath = path + ".segj";
    bool hasCheckpoint = [[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:cpPath.c_str()]];
    bool hasJournal = [[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:jPath.c_str()]];
    if (!hasCheckpoint && !hasJournal) {
      throw std::runtime_error("SEGMENT_SPOOL_UNAVAILABLE: Missing segment spool files for " + bufferId);
    }

    std::vector<SegRecord> result;
    if (hasCheckpoint) {
      FILE *cp = fopen(cpPath.c_str(), "rb");
      if (!cp) throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to open segment checkpoint for " + bufferId);

      if (fseek(cp, 0, SEEK_END) != 0) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to inspect segment checkpoint for " + bufferId);
      }
      long checkpointSize = ftell(cp);
      if (checkpointSize < kHeaderBytes) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Corrupted segment checkpoint header for " + bufferId);
      }
      if (fseek(cp, 0, SEEK_SET) != 0) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to read segment checkpoint for " + bufferId);
      }

      unsigned char header[kHeaderBytes];
      if (fread(header, 1, kHeaderBytes, cp) != kHeaderBytes) { fclose(cp); throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Corrupted segment checkpoint header for " + bufferId); }

      uint16_t type = 0;
      uint32_t len = 0;
      uint32_t checksum = 0;
      decodeHeaderOrThrow(header, cpPath, &type, &len, &checksum);
      if (type != kRecordCheckpointMark) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Unexpected segment checkpoint record type for " + bufferId);
      }
      if (checkpointSize != static_cast<long>(kHeaderBytes + len)) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Unexpected segment checkpoint size for " + bufferId);
      }

      std::string payload;
      payload.resize(len);
      if (len > 0 && fread(payload.data(), 1, len, cp) != len) { fclose(cp); throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Truncated segment checkpoint payload for " + bufferId); }

      uint32_t actualChecksum = computeSpoolChecksum(payload);
      if (actualChecksum != checksum) {
        fclose(cp);
        throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Segment checkpoint checksum mismatch for " + bufferId);
      }

      fclose(cp);
      result = segment_records_from_json(payload);
    }

    if (hasJournal) {
      FILE *jr = fopen(jPath.c_str(), "rb");
      if (!jr) throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to open segment journal for " + bufferId);

      if (fseek(jr, 0, SEEK_END) != 0) {
        fclose(jr);
        throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to inspect segment journal for " + bufferId);
      }
      long journalSize = ftell(jr);
      if (journalSize < 0 || fseek(jr, 0, SEEK_SET) != 0) {
        fclose(jr);
        throw std::runtime_error("SEGMENT_SPOOL_READ_FAILED: Failed to read segment journal for " + bufferId);
      }

      while (true) {
        unsigned char h[kHeaderBytes];
        size_t n = fread(h, 1, kHeaderBytes, jr);
        if (n == 0) break;
        if (n != kHeaderBytes) {
          fclose(jr);
          throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Corrupted segment journal header for " + bufferId);
        }

        uint16_t type = 0;
        uint32_t len = 0;
        uint32_t checksum = 0;
        decodeHeaderOrThrow(h, jPath, &type, &len, &checksum);

        long payloadStart = ftell(jr);
        if (payloadStart < 0 || payloadStart + static_cast<long>(len) > journalSize) {
          fclose(jr);
          throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Truncated segment journal payload for " + bufferId);
        }

        std::string payload;
        payload.resize(len);
        if (len > 0 && fread(payload.data(), 1, len, jr) != len) {
          fclose(jr);
          throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Truncated segment journal payload for " + bufferId);
        }

        uint32_t actualChecksum = computeSpoolChecksum(payload);
        if (actualChecksum != checksum) {
          fclose(jr);
          throw std::runtime_error("SEGMENT_SPOOL_CORRUPTED: Segment journal checksum mismatch for " + bufferId);
        }

        if (type == kRecordSegmentAppend) {
          auto parsed = segment_records_from_json(payload);
          result.insert(result.end(), parsed.begin(), parsed.end());
        }
      }

      fclose(jr);
    }

    return result;
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
    if (shouldDelete) {
      remove((pathToDelete + ".segj").c_str());
      remove((pathToDelete + ".segc").c_str());
    }

    {
      std::lock_guard<std::mutex> listenerLock(commitListenerMutex);
      commitListeners.clear();
    }
    {
      std::lock_guard<std::mutex> cursorLock(cursorMutex);
      cursors.clear();
    }
  }
};

namespace {

static void seg_debug_log(NSString *message) {
#if DEBUG
  NSLog(@"[SegmentBuffer][iOS] %@", message ?: @"<nil>");
#endif
}

static NSString *seg_nsstring_from_std(const std::string &value) {
  if (value.empty()) {
    return @"";
  }
  NSString *s = [[NSString alloc] initWithBytes:value.data()
                                          length:value.size()
                                        encoding:NSUTF8StringEncoding];
  if (s) {
    return s;
  }
  // Keep bridge stable even if native payload contains malformed UTF-8.
  s = [[NSString alloc] initWithBytes:value.data()
                               length:value.size()
                             encoding:NSISOLatin1StringEncoding];
  return s ?: @"";
}

static NSDictionary *segRecordToDict(const SegRecord &r) {
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"segRecordToDict idLen=%lu kindLen=%lu srcLen=%lu payloadBytes=%lu",
    (unsigned long)r.id.size(),
    (unsigned long)r.kind.size(),
    (unsigned long)r.sourceAudioBufferId.size(),
    (unsigned long)r.payloadJson.size()]);
#endif
  NSMutableDictionary *dict = [NSMutableDictionary dictionaryWithCapacity:10];
  dict[@"id"] = seg_nsstring_from_std(r.id);
  dict[@"kind"] = seg_nsstring_from_std(r.kind);
  dict[@"sourceAudioBufferId"] = seg_nsstring_from_std(r.sourceAudioBufferId);
  dict[@"startSample"] = @(r.startSample);
  dict[@"endSample"] = @(r.endSample);
  dict[@"sampleRate"] = @(r.sampleRate);
  dict[@"durationMs"] = @(r.durationMs);
  std::string annReason;
  std::string annSource;
  int64_t annCreatedAtMs = 0;
  int annSegmentIndex = 0;
  if (seg_engine_peek_annotation(r.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
    dict[@"reason"] = seg_nsstring_from_std(annReason);
    dict[@"source"] = seg_nsstring_from_std(annSource);
    dict[@"createdAtMs"] = @(annCreatedAtMs);
  }
  if (r.hasConfidence) dict[@"confidence"] = @(r.confidence);
  if (!r.payloadJson.empty() && r.payloadJson.size() <= NSUIntegerMax) {
    NSData *payloadData = [NSData dataWithBytes:r.payloadJson.data()
                                         length:(NSUInteger)r.payloadJson.size()];
    id payloadObj =
      payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if ([payloadObj isKindOfClass:[NSDictionary class]]) {
      dict[@"payload"] = (NSDictionary *)payloadObj;
    }
  }
  return dict;
}

static void seg_notify_segment_appended(
  const std::shared_ptr<SegLiveEntry> &entry,
  const SegRecord &seg,
  int segmentIndex
) {
  if (!entry->emitSegmentAppended || !entry->segmentAppendedEmitter) {
    return;
  }
  const int64_t now = (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
  if (entry->segmentEventMinIntervalMs > 0 &&
      now - entry->lastSegmentEmitWallMs < entry->segmentEventMinIntervalMs) {
    return;
  }
  entry->lastSegmentEmitWallMs = now;
  const int totalSegCount = static_cast<int>(entry->segments.size());
  entry->segmentAppendedEmitter(entry->bufferId, seg, segmentIndex, totalSegCount);
}
} // namespace

std::shared_ptr<SegLiveEntry> seg_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto it = g_seg_live.find(bufferId);
  if (it == g_seg_live.end()) {
    return nullptr;
  }
  return it->second;
}

int seg_live_add_commit_listener(
  const std::string &liveBufferId,
  std::function<void(const std::string &, int, const SegRecord &)> listener,
  std::string *error
) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return -1;
  }
  try {
    return entry->addCommitListener(std::move(listener));
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return -1;
  }
}

void seg_live_remove_commit_listener(const std::string &liveBufferId, int token) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) return;
  entry->removeCommitListener(token);
}

int seg_live_create_cursor(const std::string &liveBufferId, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return -1;
  }
  try {
    return entry->createSegmentCursor();
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return -1;
  }
}

std::vector<SegRecord> seg_live_drain_segments(
  const std::string &liveBufferId,
  int cursorId,
  int maxCount,
  int *startIndex,
  std::string *error
) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    if (startIndex) *startIndex = -1;
    return {};
  }
  try {
    return entry->drainSegments(cursorId, maxCount, startIndex);
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    if (startIndex) *startIndex = -1;
    return {};
  }
}

void seg_live_release_cursor(const std::string &liveBufferId, int cursorId) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) return;
  entry->releaseSegmentCursor(cursorId);
}

bool seg_live_append_segment(
  const std::string &liveBufferId,
  const std::string &kind,
  const std::string &sourceAudioBufferId,
  int startSample,
  int endSample,
  int sampleRate,
  int durationMs,
  bool hasConfidence,
  double confidence,
  const std::string &payloadJson,
  std::string *segmentId,
  int *segmentIndex,
  std::string *error
) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return false;
  }
  try {
    SegRecord seg;
    seg.id = "seg_" + seg_uuid();
    seg.kind = kind.empty() ? "speech" : kind;
    if (!seg_is_valid_kind(seg.kind)) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: kind must be one of speech, alignment, or diarization";
      return false;
    }
    if (seg.kind == "speech") {
      NSData *payloadData = [[NSString stringWithUTF8String:payloadJson.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *payloadObj =
        payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
      NSString *validationError = nil;
      if (!seg_validate_strict_speech_payload(payloadObj, &validationError)) {
        if (error) {
          *error =
            std::string("SEGMENT_INVALID_ARGUMENT: ") +
            (validationError ? validationError.UTF8String : "Invalid speech payload");
        }
        return false;
      }
    }
    if (sampleRate <= 0) {
      if (error) {
        *error = "SEGMENT_INVALID_ARGUMENT: sampleRate must be > 0";
      }
      return false;
    }
    seg.sourceAudioBufferId = sourceAudioBufferId.empty() ? entry->sourceAudioBufferId : sourceAudioBufferId;
    seg.startSample = startSample;
    seg.endSample = endSample;
    seg.sampleRate = sampleRate;
    seg.durationMs = durationMs > 0 ? durationMs : static_cast<int>(((seg.endSample - seg.startSample) * 1000.0) / std::max(1, seg.sampleRate));
    seg.hasConfidence = hasConfidence;
    if (hasConfidence) seg.confidence = confidence;
    seg.payloadJson = payloadJson;

    int idx = 0;
    std::string checkpointSnapshot;
    {
      std::lock_guard<std::mutex> lock(entry->lock);
      if (entry->state == SegLiveEntry::FINISHED) {
        if (error) *error = "SEGMENT_ALREADY_FINALIZED: Live segment buffer is finalized";
        return false;
      }
      idx = static_cast<int>(entry->evictedCount + static_cast<int64_t>(entry->segments.size()));
      entry->segments.push_back(seg);
      if (static_cast<int>(entry->segments.size()) > entry->maxSegments) {
        entry->segments.erase(entry->segments.begin());
        entry->evictedCount++;
      }
      entry->totalSegmentsWritten++;
      checkpointSnapshot = entry->snapshotForSpoolLocked();
    }
    entry->maybeAppendSegmentToSpool(seg, true, checkpointSnapshot);

    seg_notify_segment_appended(entry, seg, idx);
    entry->notifyCommitListeners(seg.id, idx, seg);

    if (segmentId) *segmentId = seg.id;
    if (segmentIndex) *segmentIndex = idx;
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

namespace {

enum class SegEngineDomain {
  TEXT,
  SPEECH,
};

enum class SegEngineState {
  ACTIVE,
  DETACHED,
  RELEASED,
};

struct SegEnginePolicy {
  std::string evaluator;
  int maxLengthChars = 2000;
  bool sentenceBoundary = true;
  /** Non-empty => replace built-in delimiter set (UTF-8 delimiter strings). */
  std::vector<std::string> sentenceBoundaryChars;
  int silenceThresholdMs = 500;
  double energyThresholdDb = -40.0;
  int minSegmentMs = 1000;
  int maxSegmentMs = 120000;
  int hangoverMs = 300;
  int checkpointIntervalMs = 0;
  std::string punctuationInstanceId;
  /** Absolute path to VAD `.onnx` (from JS `detectVadModel`). */
  std::string modelPath;
  /** `silero_vad` or `ten_vad` (from JS `detectVadModel`). */
  std::string modelType;
  double vadThreshold = 0.5;
  int vadMinSpeechMs = 250;
  int vadMinSilenceMs = 250;
  double windowShiftRatio = 0.1;
  double minDurationOn = 0.3;
  double minDurationOff = 0.5;
};

struct SegEngineAnnotation {
  std::string reason;
  std::string source;
  int64_t createdAtMs;
  int segmentIndex;
};

struct SegEngine {
  std::string engineId;
  SegEngineDomain domain = SegEngineDomain::TEXT;
  SegEngineState state = SegEngineState::ACTIVE;
  std::string attachedBufferId;
  SegEnginePolicy policy;
  std::string segmentBufferId;
  int totalSegmentsCommitted = 0;
  std::string lastSegmentId;
  std::vector<std::string> annotatedSegmentIds;

  // Speech runtime state
  int64_t segmentStartSample = 0;
  int64_t checkpointStartSample = 0;
  double silenceAccumulatedMs = 0.0;
  std::shared_ptr<VadRuntime> vadRuntime;
  int vadFrameSize = 0;
  std::vector<float> pendingVadSamples;
};

std::unordered_map<std::string, std::shared_ptr<SegEngine>> g_seg_engine_by_id;
std::unordered_map<std::string, std::string> g_seg_engine_id_by_buffer;
std::unordered_map<std::string, SegEngineAnnotation> g_seg_engine_annotation_by_segment;
std::unordered_set<std::string> g_seg_engine_eval_guard;
std::mutex g_seg_engine_mutex;
std::condition_variable g_seg_engine_eval_cv;

} // namespace

void seg_release_all_entries() {
  std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> liveEntries;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    liveEntries.swap(g_seg_live);
    g_seg_offline.clear();
  }
  for (auto &pair : liveEntries) {
    try {
      pair.second->release();
    } catch (...) {
    }
  }

  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_by_id.clear();
    g_seg_engine_id_by_buffer.clear();
    g_seg_engine_annotation_by_segment.clear();
    g_seg_engine_eval_guard.clear();
  }
}

namespace {

static int64_t seg_now_ms() {
  return (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
}

static std::string seg_new_engine_id() {
  return "seg_engine_" + seg_uuid();
}

static bool seg_file_exists(const std::string &path) {
  if (path.empty()) return false;
  return [[NSFileManager defaultManager]
    fileExistsAtPath:[NSString stringWithUTF8String:path.c_str()]];
}

static bool seg_is_regular_file(const std::string &path) {
  if (path.empty()) return false;
  BOOL isDir = NO;
  BOOL exists = [[NSFileManager defaultManager]
    fileExistsAtPath:[NSString stringWithUTF8String:path.c_str()]
    isDirectory:&isDir];
  return exists && !isDir;
}

static bool seg_init_vad_runtime(
  const std::shared_ptr<SegEngine> &engine,
  int sampleRate,
  std::string *errorOut
) {
  if (!engine) {
    if (errorOut) *errorOut = "Segmentation engine is null";
    return false;
  }

  const std::string &onnxPath = engine->policy.modelPath;
  if (onnxPath.empty() || !seg_is_regular_file(onnxPath)) {
    if (errorOut) {
      *errorOut = "speech_vad_model modelPath must be an existing .onnx file: " + onnxPath;
    }
    return false;
  }

  const std::string &mt = engine->policy.modelType;
  if (mt != "silero_vad" && mt != "ten_vad") {
    if (errorOut) {
      *errorOut = "speech_vad_model requires modelType silero_vad or ten_vad";
    }
    return false;
  }

  VadRuntimeConfig cfg;
  cfg.modelType = mt;
  cfg.modelPath = onnxPath;
  cfg.sampleRate = std::max(1, sampleRate);
  cfg.numThreads = 1;
  cfg.provider = "cpu";
  cfg.debug = false;
  cfg.scoreThreshold = engine->policy.vadThreshold;
  cfg.minSpeechDurationMs = std::max(1, engine->policy.vadMinSpeechMs);
  cfg.minSilenceDurationMs = std::max(1, engine->policy.vadMinSilenceMs);
  cfg.maxSpeechDurationMs = std::max(cfg.minSpeechDurationMs, engine->policy.maxSegmentMs);
  cfg.windowSize = cfg.modelType == "ten_vad" ? 256 : 512;

  std::string runtimeError;
  auto runtime = VadRuntime::Create(cfg, &runtimeError);
  if (!runtime) {
    if (errorOut) {
      *errorOut =
        "speech_vad_model failed to initialize runtime: " +
        (runtimeError.empty() ? std::string("unknown error") : runtimeError);
    }
    return false;
  }

  engine->vadRuntime = runtime;
  engine->vadFrameSize = std::max(1, cfg.windowSize);
  engine->pendingVadSamples.clear();
  return true;
}

static std::string seg_reason_from_eval(const std::string &eval, bool silenceCommit) {
  if (eval == "speech_vad_model") return "vad_boundary";
  if (eval == "speech_pyannote_segmentation") return "pyannote_boundary";
  return silenceCommit ? "energy_silence" : "length_limit";
}

static double seg_rms_db(const float *samples, size_t count) {
  if (!samples || count == 0) return -120.0;
  double sum = 0.0;
  for (size_t i = 0; i < count; ++i) {
    double v = samples[i];
    sum += v * v;
  }
  double rms = std::sqrt(sum / (double)count);
  if (rms <= 1e-9) return -120.0;
  return 20.0 * std::log10(rms);
}

static void seg_record_annotation(
  const std::string &segmentId,
  const std::string &reason,
  int segmentIndex
) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
    reason,
    "segmentation_engine",
    seg_now_ms(),
    segmentIndex,
  };
}

static void seg_record_annotation_for_engine(
  const std::shared_ptr<SegEngine> &engine,
  const std::string &segmentId,
  const std::string &reason,
  int segmentIndex
) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
    reason,
    "segmentation_engine",
    seg_now_ms(),
    segmentIndex,
  };
  if (engine) {
    engine->annotatedSegmentIds.push_back(segmentId);
  }
}

static bool seg_append_speech_segment(
  const std::shared_ptr<SegEngine> &engine,
  int64_t endSampleExclusive,
  const std::string &reason,
  double score
) {
  if (!engine || engine->segmentBufferId.empty()) return false;
  if (endSampleExclusive <= engine->segmentStartSample) return false;

  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live || live->sampleRate <= 0) return false;

  int64_t lengthSamples = endSampleExclusive - engine->segmentStartSample;
  int durationMs = (int)((lengthSamples * 1000.0) / live->sampleRate);
  if (durationMs <= 0) return false;

  NSDictionary *payloadObj = @{
    @"source": @"vad",
    @"engine": @"vad",
    @"decision": @"model",
    @"score": @(score),
  };
  NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];
  std::string payloadJson;
  if (payloadData) {
    payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
  }

  std::string segmentId;
  int segmentIndex = 0;
  std::string err;
  bool ok = seg_live_append_segment(
    engine->segmentBufferId,
    "speech",
    engine->attachedBufferId,
    (int)engine->segmentStartSample,
    (int)endSampleExclusive,
    live->sampleRate,
    durationMs,
    false,
    0.0,
    payloadJson,
    &segmentId,
    &segmentIndex,
    &err
  );
  if (!ok) {
    return false;
  }

  {
    const int64_t createdAtMs =
      (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
    std::lock_guard<std::mutex> annLock(g_seg_engine_mutex);
    g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
      reason,
      "segmentation_engine",
      createdAtMs,
      segmentIndex,
    };
  }

  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId = segmentId;
  engine->segmentStartSample = endSampleExclusive;
  engine->checkpointStartSample = endSampleExclusive;
  engine->silenceAccumulatedMs = 0.0;
  return true;
}

static bool seg_append_speech_segment_range(
  const std::shared_ptr<SegEngine> &engine,
  int64_t startSample,
  int64_t endSampleExclusive,
  const std::string &reason
) {
  if (!engine || engine->segmentBufferId.empty()) return false;
  if (endSampleExclusive <= startSample) return false;

  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live || live->sampleRate <= 0) return false;

  const int durationMs = static_cast<int>(
    ((endSampleExclusive - startSample) * 1000.0) / live->sampleRate
  );
  if (durationMs <= 0) return false;

  NSDictionary *payloadObj = @{
    @"source": @"vad",
    @"engine": @"vad",
    @"decision": @"model",
  };
  NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];
  std::string payloadJson;
  if (payloadData) {
    payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
  }

  std::string segmentId;
  int segmentIndex = 0;
  std::string err;
  bool ok = seg_live_append_segment(
    engine->segmentBufferId,
    "speech",
    engine->attachedBufferId,
    static_cast<int>(startSample),
    static_cast<int>(endSampleExclusive),
    live->sampleRate,
    durationMs,
    false,
    0.0,
    payloadJson,
    &segmentId,
    &segmentIndex,
    &err
  );
  if (!ok) {
    return false;
  }

  {
    const int64_t createdAtMs =
      (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
    std::lock_guard<std::mutex> annLock(g_seg_engine_mutex);
    g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
      reason,
      "segmentation_engine",
      createdAtMs,
      segmentIndex,
    };
  }

  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId = segmentId;
  return true;
}

static void seg_append_runtime_vad_segments(
  const std::shared_ptr<SegEngine> &engine,
  const std::string &reason
) {
  if (!engine || !engine->vadRuntime) return;
  auto segments = engine->vadRuntime->PopSegments();
  for (const auto &segment : segments) {
    seg_append_speech_segment_range(
      engine,
      segment.startSample,
      segment.endSample,
      reason
    );
  }
}

static bool seg_punctuation_instance_exists(const std::string &instanceId) {
  if (instanceId.empty()) return false;
  return sherpaonnx_punct_online_has_instance(instanceId) ||
         sherpaonnx_punct_offline_has_instance(instanceId);
}

static std::string seg_add_punctuation_or_throw(
  const std::string &instanceId,
  const std::string &text
) {
  std::string out;
  if (sherpaonnx_punct_online_add_punctuation_if_exists(instanceId, text, &out)) {
    return out;
  }
  if (sherpaonnx_punct_offline_add_punctuation_if_exists(instanceId, text, &out)) {
    return out;
  }
  throw std::runtime_error(
    "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND: Punctuation instance not found: " +
    instanceId
  );
}

static size_t seg_first_delimiter_end_exclusive(
  const std::string &text,
  const SegEnginePolicy &policy
) {
  if (policy.sentenceBoundaryChars.empty()) {
    return seg_utf8_sentence_boundary_prefix_len_first(text);
  }
  return seg_utf8_custom_delimiter_prefix_len_first(text, policy.sentenceBoundaryChars);
}

static int seg_assisted_commit_length(
  const std::string &partial,
  const std::string &instanceId,
  const SegEnginePolicy &policy
) {
  if (partial.empty()) return 0;
  const std::string normalized =
      punct_text_input_normalization::normalize(partial, "lower");
  const std::string punctuated =
      seg_add_punctuation_or_throw(instanceId, normalized);
  const size_t endInPunctuated = seg_first_delimiter_end_exclusive(punctuated, policy);
  if (endInPunctuated == std::string::npos || endInPunctuated == 0) return 0;
  if (endInPunctuated <= normalized.size()) {
    return (int)std::min(partial.size(), endInPunctuated);
  }
  int n = (int)std::min(normalized.size(), endInPunctuated);
  while (n > 0) {
    const std::string prefixPunctuated = seg_add_punctuation_or_throw(
        instanceId, normalized.substr(0, (size_t)n));
    const size_t prefixEnd =
        seg_first_delimiter_end_exclusive(prefixPunctuated, policy);
    if (prefixEnd != std::string::npos && prefixEnd == prefixPunctuated.size()) {
      return (int)std::min(partial.size(), (size_t)n);
    }
    n--;
  }
  return 0;
}

static void seg_engine_evaluate_text(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::ACTIVE) return;
  auto entry = txt_get_live_entry(engine->attachedBufferId);
  if (!entry) return;

  while (true) {
    std::string partial = entry->snapshotText();
    if (partial.empty()) break;

    int commitLength = 0;
    std::string reason = "policy_checkpoint";

    if (engine->policy.evaluator == "text_punctuation_assisted") {
      if (engine->policy.punctuationInstanceId.empty()) {
        throw std::runtime_error(
          "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND: text_punctuation_assisted requires punctuationInstanceId"
        );
      }
      if (engine->policy.sentenceBoundary) {
        commitLength = seg_assisted_commit_length(
            partial, engine->policy.punctuationInstanceId, engine->policy);
        if (commitLength > 0) {
          reason = "punctuation";
        }
      }
    } else if (engine->policy.sentenceBoundary) {
      const size_t prefixLen =
          seg_first_delimiter_end_exclusive(partial, engine->policy);
      if (prefixLen != std::string::npos && prefixLen > 0) {
        commitLength = std::min((int)partial.size(), (int)prefixLen);
        reason = "punctuation";
      }
    }

    if (commitLength <= 0 && (int)partial.size() >= engine->policy.maxLengthChars) {
      int maxLen = std::max(1, engine->policy.maxLengthChars);
      std::string prefix = partial.substr(0, (size_t)maxLen);
      size_t space = prefix.find_last_of(' ');
      commitLength = (int)(space == std::string::npos ? maxLen : space + 1);
      reason = "length_limit";
    }

    if (commitLength <= 0) {
      break;
    }

    std::string committed = partial.substr(0, (size_t)commitLength);
    std::string remainder = partial.substr((size_t)commitLength);
    if (committed.empty()) break;

    NSDictionary *meta = @{
      @"__segmentReason": [NSString stringWithUTF8String:reason.c_str()],
      @"__segmentSource": @"segmentation_engine",
      @"__segmentCreatedAtMs": @(seg_now_ms()),
      @"punctuationInstanceId": [NSString stringWithUTF8String:engine->policy.punctuationInstanceId.c_str()] ?: @"",
    };
    int segmentIndex = entry->commitSegment(
      committed,
      {},
      {},
      "stt_stream",
      meta
    );
    entry->writePartial(remainder);

    engine->totalSegmentsCommitted += 1;
    engine->lastSegmentId = "txtseg_" + engine->attachedBufferId + "_" + std::to_string(segmentIndex);
  }
}

static void seg_engine_flush_text(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::ACTIVE) return;
  auto entry = txt_get_live_entry(engine->attachedBufferId);
  if (!entry) return;
  std::string partial = entry->snapshotText();
  if (partial.empty()) return;

  NSDictionary *meta = @{
    @"__segmentReason": @"finalize",
    @"__segmentSource": @"segmentation_engine",
    @"__segmentCreatedAtMs": @(seg_now_ms()),
  };
  int segmentIndex = entry->commitSegment(partial, {}, {}, "stt_stream", meta);
  entry->writePartial("");
  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId = "txtseg_" + engine->attachedBufferId + "_" + std::to_string(segmentIndex);
}

static void seg_engine_evaluate_audio(
  const std::shared_ptr<SegEngine> &engine,
  const float *samples,
  size_t count,
  int sampleRate,
  int64_t totalSamplesWritten
) {
  if (!engine || engine->state != SegEngineState::ACTIVE) return;
  if (!samples || count == 0 || sampleRate <= 0) return;

  if (engine->policy.evaluator == "continuous_frames") {
    if (engine->policy.checkpointIntervalMs <= 0) return;
    double checkpointMs =
      ((double)std::max<int64_t>(0, totalSamplesWritten - engine->checkpointStartSample) * 1000.0) /
      sampleRate;
    if (checkpointMs >= engine->policy.checkpointIntervalMs) {
      double db = seg_rms_db(samples, count);
      seg_append_speech_segment(engine, totalSamplesWritten, "policy_checkpoint", db);
    }
    return;
  }

  if (engine->policy.evaluator == "speech_vad_model") {
    if (!engine->vadRuntime || engine->vadFrameSize <= 0) {
      return;
    }
    const int frameSize = std::max(1, engine->vadFrameSize);
    engine->pendingVadSamples.insert(
      engine->pendingVadSamples.end(),
      samples,
      samples + count
    );
    while ((int)engine->pendingVadSamples.size() >= frameSize) {
      engine->vadRuntime->AcceptWaveform(engine->pendingVadSamples.data(), frameSize);
      seg_append_runtime_vad_segments(engine, "vad_boundary");
      engine->pendingVadSamples.erase(
        engine->pendingVadSamples.begin(),
        engine->pendingVadSamples.begin() + frameSize
      );
    }
    return;
  }

  double chunkDurationMs = ((double)count * 1000.0) / sampleRate;
  double db = seg_rms_db(samples, count);

  if (db < engine->policy.energyThresholdDb) {
    engine->silenceAccumulatedMs += chunkDurationMs;
  } else {
    engine->silenceAccumulatedMs = 0.0;
  }

  double segmentDurationMs =
    ((double)std::max<int64_t>(0, totalSamplesWritten - engine->segmentStartSample) * 1000.0) /
    sampleRate;

  bool silenceCommit =
    engine->silenceAccumulatedMs >= (engine->policy.silenceThresholdMs + engine->policy.hangoverMs) &&
    segmentDurationMs >= engine->policy.minSegmentMs;
  bool lengthCommit = segmentDurationMs >= engine->policy.maxSegmentMs;

  if (silenceCommit || lengthCommit) {
    std::string reason = seg_reason_from_eval(engine->policy.evaluator, silenceCommit);
    seg_append_speech_segment(engine, totalSamplesWritten, reason, db);
    return;
  }
}

static void seg_engine_flush_audio(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::ACTIVE) return;
  if (engine->policy.evaluator == "speech_vad_model") {
    if (!engine->vadRuntime || engine->vadFrameSize <= 0) {
      return;
    }
    const int frameSize = std::max(1, engine->vadFrameSize);
    if (!engine->pendingVadSamples.empty()) {
      std::vector<float> tail(frameSize, 0.0f);
      std::copy(
        engine->pendingVadSamples.begin(),
        engine->pendingVadSamples.end(),
        tail.begin()
      );
      engine->vadRuntime->AcceptWaveform(tail.data(), frameSize);
      engine->pendingVadSamples.clear();
      seg_append_runtime_vad_segments(engine, "vad_boundary");
    }
    engine->vadRuntime->Flush();
    seg_append_runtime_vad_segments(engine, "finalize");
    return;
  }

  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live) return;
  if (live->totalSamplesWritten > engine->segmentStartSample) {
    const char *reason = "finalize";
    seg_append_speech_segment(engine, live->totalSamplesWritten, reason, 0.0);
  }
}

static SegEnginePolicy seg_policy_from_dict(NSDictionary *policy, SegEngineDomain domain) {
  NSDictionary *p = [policy isKindOfClass:[NSDictionary class]] ? policy : @{};
  SegEnginePolicy out;
  out.evaluator = domain == SegEngineDomain::TEXT ? "text_synthetic_auto" : "speech_energy_silence";
  if ([p[@"evaluator"] isKindOfClass:[NSString class]]) {
    out.evaluator = [p[@"evaluator"] UTF8String] ?: out.evaluator;
    std::transform(out.evaluator.begin(), out.evaluator.end(), out.evaluator.begin(), ::tolower);
  }
  if ([p[@"maxLengthChars"] respondsToSelector:@selector(intValue)]) out.maxLengthChars = std::max(1, [p[@"maxLengthChars"] intValue]);
  if ([p[@"sentenceBoundary"] respondsToSelector:@selector(boolValue)]) out.sentenceBoundary = [p[@"sentenceBoundary"] boolValue];
  id rawSbc = p[@"sentenceBoundaryChars"];
  if ([rawSbc isKindOfClass:[NSArray class]]) {
    for (id item in (NSArray *)rawSbc) {
      if (![item isKindOfClass:[NSString class]]) {
        continue;
      }
      NSString *s = (NSString *)item;
      if (s.length == 0) {
        continue;
      }
      out.sentenceBoundaryChars.push_back([s UTF8String] ?: "");
    }
  }
  if ([p[@"silenceThresholdMs"] respondsToSelector:@selector(intValue)]) out.silenceThresholdMs = std::max(50, [p[@"silenceThresholdMs"] intValue]);
  if ([p[@"energyThresholdDb"] respondsToSelector:@selector(doubleValue)]) out.energyThresholdDb = [p[@"energyThresholdDb"] doubleValue];
  if ([p[@"minSegmentMs"] respondsToSelector:@selector(intValue)]) out.minSegmentMs = std::max(100, [p[@"minSegmentMs"] intValue]);
  if ([p[@"maxSegmentMs"] respondsToSelector:@selector(intValue)]) out.maxSegmentMs = std::max(out.minSegmentMs, [p[@"maxSegmentMs"] intValue]);
  if ([p[@"hangoverMs"] respondsToSelector:@selector(intValue)]) out.hangoverMs = std::max(0, [p[@"hangoverMs"] intValue]);
  if ([p[@"checkpointIntervalMs"] respondsToSelector:@selector(intValue)]) out.checkpointIntervalMs = std::max(0, [p[@"checkpointIntervalMs"] intValue]);
  if ([p[@"punctuationInstanceId"] isKindOfClass:[NSString class]]) out.punctuationInstanceId = [p[@"punctuationInstanceId"] UTF8String] ?: "";
  id rawModelPath = p[@"modelPath"];
  if ([rawModelPath isKindOfClass:[NSString class]]) {
    out.modelPath = [rawModelPath UTF8String] ?: "";
  } else if ([rawModelPath isKindOfClass:[NSDictionary class]]) {
    NSDictionary *mp = (NSDictionary *)rawModelPath;
    id pathVal = mp[@"path"];
    if ([pathVal isKindOfClass:[NSString class]]) {
      out.modelPath = [pathVal UTF8String] ?: "";
    }
  }
  if ([p[@"modelType"] isKindOfClass:[NSString class]]) {
    out.modelType = [p[@"modelType"] UTF8String] ?: "";
  }
  if ([p[@"vadThreshold"] respondsToSelector:@selector(doubleValue)]) out.vadThreshold = [p[@"vadThreshold"] doubleValue];
  if ([p[@"vadMinSpeechMs"] respondsToSelector:@selector(intValue)]) out.vadMinSpeechMs = std::max(1, [p[@"vadMinSpeechMs"] intValue]);
  if ([p[@"vadMinSilenceMs"] respondsToSelector:@selector(intValue)]) out.vadMinSilenceMs = std::max(1, [p[@"vadMinSilenceMs"] intValue]);
  if ([p[@"windowShiftRatio"] respondsToSelector:@selector(doubleValue)]) {
    double ratio = [p[@"windowShiftRatio"] doubleValue];
    if (ratio > 0.0 && ratio <= 1.0) {
      out.windowShiftRatio = ratio;
    }
  }
  if ([p[@"minDurationOn"] respondsToSelector:@selector(doubleValue)]) {
    out.minDurationOn = std::max(0.0, [p[@"minDurationOn"] doubleValue]);
  }
  if ([p[@"minDurationOff"] respondsToSelector:@selector(doubleValue)]) {
    out.minDurationOff = std::max(0.0, [p[@"minDurationOff"] doubleValue]);
  }
  return out;
}

static NSDictionary *seg_engine_policy_to_dict(const SegEnginePolicy &p) {
  NSMutableDictionary *md = [@{
    @"evaluator": [NSString stringWithUTF8String:p.evaluator.c_str()] ?: @"",
    @"maxLengthChars": @(p.maxLengthChars),
    @"sentenceBoundary": @(p.sentenceBoundary),
    @"silenceThresholdMs": @(p.silenceThresholdMs),
    @"energyThresholdDb": @(p.energyThresholdDb),
    @"minSegmentMs": @(p.minSegmentMs),
    @"maxSegmentMs": @(p.maxSegmentMs),
    @"hangoverMs": @(p.hangoverMs),
    @"checkpointIntervalMs": @(p.checkpointIntervalMs),
    @"punctuationInstanceId": [NSString stringWithUTF8String:p.punctuationInstanceId.c_str()] ?: @"",
    @"vadThreshold": @(p.vadThreshold),
    @"vadMinSpeechMs": @(p.vadMinSpeechMs),
    @"vadMinSilenceMs": @(p.vadMinSilenceMs),
    @"windowShiftRatio": @(p.windowShiftRatio),
    @"minDurationOn": @(p.minDurationOn),
    @"minDurationOff": @(p.minDurationOff),
  } mutableCopy];
  if (!p.sentenceBoundaryChars.empty()) {
    NSMutableArray *arr = [NSMutableArray array];
    for (const auto &s : p.sentenceBoundaryChars) {
      [arr addObject:[NSString stringWithUTF8String:s.c_str()] ?: @""];
    }
    md[@"sentenceBoundaryChars"] = arr;
  }
  if (!p.modelPath.empty()) {
    md[@"modelPath"] = @{
      @"kind": @"fs",
      @"path": [NSString stringWithUTF8String:p.modelPath.c_str()] ?: @"",
    };
  }
  return md;
}

static NSDictionary *seg_engine_info_to_dict(const std::shared_ptr<SegEngine> &engine) {
  if (!engine) return @{};
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  out[@"engineId"] = [NSString stringWithUTF8String:engine->engineId.c_str()] ?: @"";
  out[@"attachedBufferId"] = [NSString stringWithUTF8String:engine->attachedBufferId.c_str()] ?: @"";
  out[@"domain"] = engine->domain == SegEngineDomain::TEXT ? @"text" : @"speech";
  out[@"policy"] = seg_engine_policy_to_dict(engine->policy);
  out[@"state"] = engine->state == SegEngineState::ACTIVE ? @"active" : @"detached";
  out[@"totalSegmentsCommitted"] = @(engine->totalSegmentsCommitted);
  if (!engine->lastSegmentId.empty()) out[@"lastSegmentId"] = [NSString stringWithUTF8String:engine->lastSegmentId.c_str()];
  if (!engine->segmentBufferId.empty()) out[@"segmentBufferId"] = [NSString stringWithUTF8String:engine->segmentBufferId.c_str()];
  return out;
}

} // namespace

void seg_engine_on_text_write(const std::string &liveBufferId) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto itId = g_seg_engine_id_by_buffer.find(liveBufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    engine = itEngine->second;
    if (!g_seg_engine_eval_guard.insert(liveBufferId).second) return;
  }

  seg_engine_evaluate_text(engine);

  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_eval_guard.erase(liveBufferId);
  }
  g_seg_engine_eval_cv.notify_all();
}

void seg_engine_on_audio_append(
  const std::string &liveBufferId,
  const float *samples,
  size_t count,
  int sampleRate,
  int64_t totalSamplesWritten
) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto itId = g_seg_engine_id_by_buffer.find(liveBufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    engine = itEngine->second;
    if (!g_seg_engine_eval_guard.insert(liveBufferId).second) return;
  }

  seg_engine_evaluate_audio(engine, samples, count, sampleRate, totalSamplesWritten);

  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_eval_guard.erase(liveBufferId);
  }
  g_seg_engine_eval_cv.notify_all();
}

void seg_engine_on_buffer_finalized(const std::string &bufferId) {
  std::shared_ptr<SegEngine> engine;
  {
    std::unique_lock<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_eval_cv.wait(lock, [&bufferId] {
      return g_seg_engine_eval_guard.find(bufferId) == g_seg_engine_eval_guard.end();
    });
    auto itId = g_seg_engine_id_by_buffer.find(bufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    g_seg_engine_eval_guard.insert(bufferId);
    engine = itEngine->second;
  }

  if (engine->state == SegEngineState::ACTIVE) {
    if (engine->domain == SegEngineDomain::TEXT) seg_engine_flush_text(engine);
    else seg_engine_flush_audio(engine);
  }

  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    if (engine->state == SegEngineState::ACTIVE) {
      engine->state = SegEngineState::DETACHED;
    }
    g_seg_engine_id_by_buffer.erase(bufferId);
    g_seg_engine_eval_guard.erase(bufferId);
  }
  g_seg_engine_eval_cv.notify_all();
}

void seg_engine_on_buffer_released(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto itId = g_seg_engine_id_by_buffer.find(bufferId);
  if (itId == g_seg_engine_id_by_buffer.end()) return;
  auto itEngine = g_seg_engine_by_id.find(itId->second);
  if (itEngine != g_seg_engine_by_id.end()) {
    auto &engine = itEngine->second;
    for (const auto &sid : engine->annotatedSegmentIds) {
      g_seg_engine_annotation_by_segment.erase(sid);
    }
    engine->state = SegEngineState::RELEASED;
    g_seg_engine_by_id.erase(itEngine);
  }
  g_seg_engine_id_by_buffer.erase(itId);
}

bool seg_engine_peek_annotation(
  const std::string &segmentId,
  std::string *reason,
  std::string *source,
  int64_t *createdAtMs,
  int *segmentIndex
) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto it = g_seg_engine_annotation_by_segment.find(segmentId);
  if (it == g_seg_engine_annotation_by_segment.end()) return false;
  if (reason) *reason = it->second.reason;
  if (source) *source = it->second.source;
  if (createdAtMs) *createdAtMs = it->second.createdAtMs;
  if (segmentIndex) *segmentIndex = it->second.segmentIndex;
  return true;
}

bool seg_engine_detach(const std::string &engineId, bool flushFinal, std::string *error) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto it = g_seg_engine_by_id.find(engineId);
    if (it == g_seg_engine_by_id.end()) {
      if (error) *error = "ENGINE_DETACHED: Segmentation engine not found: " + engineId;
      return false;
    }
    engine = it->second;
  }

  if (engine->state != SegEngineState::ACTIVE) {
    if (error) *error = "ENGINE_DETACHED: Segmentation engine already detached: " + engineId;
    return false;
  }

  if (flushFinal) {
    if (engine->domain == SegEngineDomain::TEXT) {
      seg_engine_flush_text(engine);
    } else {
      seg_engine_flush_audio(engine);
    }
  }

  engine->state = SegEngineState::DETACHED;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_id_by_buffer.erase(engine->attachedBufferId);
  }
  return true;
}

bool seg_engine_flush(const std::string &engineId, std::string *error) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto it = g_seg_engine_by_id.find(engineId);
    if (it == g_seg_engine_by_id.end()) {
      return true;
    }
    engine = it->second;
    if (engine->state != SegEngineState::ACTIVE) {
      return true;
    }
  }

  if (engine->domain == SegEngineDomain::TEXT) {
    seg_engine_flush_text(engine);
  } else {
    seg_engine_flush_audio(engine);
  }
  return true;
}
#endif

@implementation SherpaOnnx (SegmentBuffer)

- (void)attachSegmentationEngine:(NSString *)bufferId
                          domain:(NSString *)domain
                          policy:(NSDictionary *)policy
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  try {
    std::string bid = [bufferId UTF8String] ?: "";
    std::string domainRaw = [domain UTF8String] ?: "";
    std::transform(domainRaw.begin(), domainRaw.end(), domainRaw.begin(), ::tolower);
    SegEngineDomain d;
    if (domainRaw == "text") d = SegEngineDomain::TEXT;
    else if (domainRaw == "speech") d = SegEngineDomain::SPEECH;
    else {
      reject(@"POLICY_INVALID", [NSString stringWithFormat:@"Unsupported segmentation domain: %@", domain ?: @""], nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
      if (g_seg_engine_id_by_buffer.find(bid) != g_seg_engine_id_by_buffer.end()) {
        reject(@"ENGINE_ALREADY_ATTACHED", [NSString stringWithFormat:@"Segmentation engine already attached for buffer: %@", bufferId], nil);
        return;
      }
    }

    if (d == SegEngineDomain::TEXT) {
      auto live = txt_get_live_entry(bid);
      if (!live || live->state != TxtLiveEntry::RECORDING) {
        reject(@"BUFFER_STATE_INVALID", [NSString stringWithFormat:@"Live text buffer is not recording: %@", bufferId], nil);
        return;
      }
    } else {
      auto live = pa_get_live_entry(bid);
      if (!live || live->state != PaLiveEntry::RECORDING) {
        reject(@"BUFFER_STATE_INVALID", [NSString stringWithFormat:@"Live audio buffer is not recording: %@", bufferId], nil);
        return;
      }
    }

    NSString *sbcErrAttach = seg_validate_sentence_boundary_chars_field(policy);
    if (sbcErrAttach != nil) {
      reject(@"POLICY_INVALID", sbcErrAttach, nil);
      return;
    }

    auto engine = std::make_shared<SegEngine>();
    engine->engineId = seg_new_engine_id();
    engine->domain = d;
    engine->state = SegEngineState::ACTIVE;
    engine->attachedBufferId = bid;
    engine->policy = seg_policy_from_dict(policy, d);
    if (d == SegEngineDomain::TEXT) {
      if (!(engine->policy.evaluator == "text_synthetic_auto" ||
            engine->policy.evaluator == "text_punctuation_assisted")) {
        reject(@"POLICY_INVALID",
               [NSString stringWithFormat:@"Policy evaluator '%@' is invalid for text domain",
                                          policy[@"evaluator"] ?: @""],
               nil);
        return;
      }
      if (engine->policy.evaluator == "text_punctuation_assisted") {
        if (engine->policy.punctuationInstanceId.empty()) {
          reject(@"POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                 @"text_punctuation_assisted requires policy.punctuationInstanceId",
                 nil);
          return;
        }
        if (!seg_punctuation_instance_exists(engine->policy.punctuationInstanceId)) {
          reject(@"POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                 [NSString stringWithFormat:@"Punctuation instance not found for segmentation policy: %@",
                                            [NSString stringWithUTF8String:engine->policy.punctuationInstanceId.c_str()] ?: @""],
                 nil);
          return;
        }
      }
    }
    if (d == SegEngineDomain::SPEECH) {
      if (!(engine->policy.evaluator == "speech_energy_silence" ||
            engine->policy.evaluator == "speech_vad_model" ||
            engine->policy.evaluator == "speech_pyannote_segmentation" ||
            engine->policy.evaluator == "continuous_frames")) {
        reject(@"POLICY_INVALID",
               [NSString stringWithFormat:@"Policy evaluator '%@' is invalid for speech domain",
                                          policy[@"evaluator"] ?: @""],
               nil);
        return;
      }
      if (engine->policy.evaluator == "speech_pyannote_segmentation") {
        reject(@"POLICY_INVALID",
               @"Policy evaluator 'speech_pyannote_segmentation' is offline-only and invalid for live attach",
               nil);
        return;
      }
    }

    if (d == SegEngineDomain::SPEECH) {
      auto entry = std::make_shared<SegLiveEntry>();
      entry->bufferId = seg_new_id("seg_live");
      entry->sourceAudioBufferId = bid;
      entry->maxSegments = 4096;
      entry->spoolingMode = SegLiveEntry::SPOOL_ON;
      NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"seg_spool_%@.json", [NSUUID UUID].UUIDString]];
      entry->spoolPath = tmp.UTF8String ?: "";
      entry->spoolTemporary = true;
      entry->emitSegmentAppended = true;
      entry->segmentEventMinIntervalMs = 0;

      __weak SherpaOnnx *weakModule = self;
      entry->segmentAppendedEmitter = [weakModule](
        const std::string &segmentBufferId,
        const SegRecord &rec,
        int segIdx,
        int totalSegments
      ) {
        SherpaOnnx *module = weakModule;
        if (!module) return;
        NSMutableDictionary *body = [NSMutableDictionary dictionary];
        body[@"segmentBufferId"] = [NSString stringWithUTF8String:segmentBufferId.c_str()] ?: @"";
        body[@"segmentId"] = [NSString stringWithUTF8String:rec.id.c_str()] ?: @"";
        body[@"segmentIndex"] = @(segIdx);
        body[@"totalSegments"] = @(totalSegments);
        body[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:rec.sourceAudioBufferId.c_str()] ?: @"";
        body[@"startSample"] = @(rec.startSample);
        body[@"endSample"] = @(rec.endSample);
        body[@"sampleRate"] = @(rec.sampleRate);
        body[@"durationMs"] = @(rec.durationMs);
        std::string annReason;
        std::string annSource;
        int64_t annCreatedAtMs = 0;
        int annSegmentIndex = 0;
        if (seg_engine_peek_annotation(rec.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
          body[@"reason"] = [NSString stringWithUTF8String:annReason.c_str()] ?: @"manual_commit";
          body[@"source"] = [NSString stringWithUTF8String:annSource.c_str()] ?: @"manual";
          body[@"createdAtMs"] = @(annCreatedAtMs);
        } else {
          body[@"reason"] = @"manual_commit";
          body[@"source"] = @"manual";
          body[@"createdAtMs"] = @((int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0));
        }
        if (rec.hasConfidence) body[@"confidence"] = @(rec.confidence);
        if (!rec.payloadJson.empty()) {
          NSData *payloadData = [[NSString stringWithUTF8String:rec.payloadJson.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
          NSDictionary *payloadObj = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
          if (payloadObj) body[@"payload"] = payloadObj;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          [module sendEventWithName:@"pipelineLiveSegmentAppended" body:body];
        });
      };

      {
        std::lock_guard<std::mutex> lock(g_seg_mutex);
        g_seg_live[entry->bufferId] = entry;
      }
      engine->segmentBufferId = entry->bufferId;

      if (engine->policy.evaluator == "speech_vad_model") {
        auto live = pa_get_live_entry(bid);
        if (!live) {
          {
            std::lock_guard<std::mutex> lock(g_seg_mutex);
            g_seg_live.erase(entry->bufferId);
          }
          try { entry->release(); } catch (...) {}
          reject(@"BUFFER_STATE_INVALID", [NSString stringWithFormat:@"Live audio buffer not found: %@", bufferId], nil);
          return;
        }
        std::string vadError;
        if (!seg_init_vad_runtime(engine, live->sampleRate, &vadError)) {
          {
            std::lock_guard<std::mutex> lock(g_seg_mutex);
            g_seg_live.erase(entry->bufferId);
          }
          try { entry->release(); } catch (...) {}
          NSString *message = [NSString stringWithUTF8String:vadError.c_str()] ?: @"speech_vad_model runtime init failed";
          reject(@"POLICY_MODEL_UNAVAILABLE", message, nil);
          return;
        }
      }
    }

    {
      std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
      g_seg_engine_by_id[engine->engineId] = engine;
      g_seg_engine_id_by_buffer[engine->attachedBufferId] = engine->engineId;
    }

    resolve(seg_engine_info_to_dict(engine));
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Unknown segmentation engine error";
    reject(@"SEGMENT_INTERNAL_ERROR", msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)detachSegmentationEngine:(NSString *)engineId
                       flushFinal:(NSNumber *)flushFinal
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto it = g_seg_engine_by_id.find(engineId.UTF8String ?: "");
    if (it == g_seg_engine_by_id.end()) {
      reject(@"ENGINE_DETACHED", [NSString stringWithFormat:@"Segmentation engine not found: %@", engineId], nil);
      return;
    }
    engine = it->second;
  }

  if (engine->state != SegEngineState::ACTIVE) {
    reject(@"ENGINE_DETACHED", [NSString stringWithFormat:@"Segmentation engine already detached: %@", engineId], nil);
    return;
  }

  if (flushFinal.boolValue) {
    if (engine->domain == SegEngineDomain::TEXT) seg_engine_flush_text(engine);
    else seg_engine_flush_audio(engine);
  }
  engine->state = SegEngineState::DETACHED;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_id_by_buffer.erase(engine->attachedBufferId);
  }
  resolve(nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)getSegmentationEngineInfo:(NSString *)engineId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto it = g_seg_engine_by_id.find(engineId.UTF8String ?: "");
  if (it == g_seg_engine_by_id.end()) {
    reject(@"ENGINE_DETACHED", [NSString stringWithFormat:@"Segmentation engine not found: %@", engineId], nil);
    return;
  }
  resolve(seg_engine_info_to_dict(it->second));
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)segmentOfflineBuffer:(NSString *)bufferId
                       domain:(NSString *)domain
                       policy:(NSDictionary *)policy
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string bid = [bufferId UTF8String] ?: "";
    std::string domainRaw = [domain UTF8String] ?: "";
    std::transform(domainRaw.begin(), domainRaw.end(), domainRaw.begin(), ::tolower);

    if (domainRaw == "text") {
      NSString *sbcErr = seg_validate_sentence_boundary_chars_field(policy);
      if (sbcErr != nil) {
        reject(@"POLICY_INVALID", sbcErr, nil);
        return;
      }
      std::string text;
      std::string err;
      if (!txt_read_offline_text(bid, &text, &err)) {
        reject(@"BUFFER_STATE_INVALID", [NSString stringWithUTF8String:err.c_str()] ?: @"Offline text buffer not found", nil);
        return;
      }
      SegEnginePolicy p = seg_policy_from_dict(policy, SegEngineDomain::TEXT);
      if (!(p.evaluator == "text_synthetic_auto" ||
            p.evaluator == "text_punctuation_assisted")) {
        reject(@"POLICY_INVALID",
               [NSString stringWithFormat:@"Policy evaluator '%@' is invalid for text domain",
                                          policy[@"evaluator"] ?: @""],
               nil);
        return;
      }
      if (p.evaluator == "text_punctuation_assisted") {
        if (p.punctuationInstanceId.empty()) {
          reject(@"POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                 @"text_punctuation_assisted requires policy.punctuationInstanceId",
                 nil);
          return;
        }
        try {
          text = seg_add_punctuation_or_throw(p.punctuationInstanceId, text);
        } catch (const std::exception &e) {
          reject(@"POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                 [NSString stringWithUTF8String:e.what()] ?: @"Punctuation instance not found",
                 nil);
          return;
        }
      }
      NSString *full = [NSString stringWithUTF8String:text.c_str()] ?: @"";
      NSMutableArray *segments = [NSMutableArray array];
      int index = 0;
      const int totalLen = (int)full.length;
      const int maxLen = std::max(1, p.maxLengthChars);
      while (index < totalLen) {
        const int remainingLen = totalLen - index;
        NSString *remaining = [full substringWithRange:NSMakeRange((NSUInteger)index, (NSUInteger)remainingLen)];
        int split = 0;
        BOOL foundBoundary = NO;
        if (p.sentenceBoundary) {
          if (p.sentenceBoundaryChars.empty()) {
            NSRange boundaryRange = [remaining rangeOfCharacterFromSet:seg_text_sentence_boundary_charset()
                                                               options:0
                                                                 range:NSMakeRange(0, remaining.length)];
            if (boundaryRange.location != NSNotFound) {
              split = (int)(boundaryRange.location + boundaryRange.length);
              foundBoundary = YES;
            }
          } else {
            NSData *remainingUtf8 = [remaining dataUsingEncoding:NSUTF8StringEncoding];
            if (remainingUtf8 != nil) {
              std::string remainingStd((const char *)remainingUtf8.bytes, remainingUtf8.length);
              const size_t byteLen =
                seg_utf8_custom_delimiter_prefix_len_first(remainingStd, p.sentenceBoundaryChars);
              if (byteLen != std::string::npos && byteLen > 0) {
                NSString *prefixNs = [[NSString alloc] initWithBytes:remainingStd.data()
                                                               length:byteLen
                                                             encoding:NSUTF8StringEncoding];
                if (prefixNs != nil) {
                  split = (int)prefixNs.length;
                  foundBoundary = YES;
                }
              }
            }
          }
        }
        if (split <= 0) {
          split = std::min(maxLen, remainingLen);
          if (split < remainingLen) {
            NSRange spaceRange = [remaining rangeOfString:@" "
                                                  options:NSBackwardsSearch
                                                    range:NSMakeRange(0, (NSUInteger)split)];
            if (spaceRange.location != NSNotFound && spaceRange.location > 0) {
              split = (int)(spaceRange.location + 1);
            }
          }
        }
        NSString *chunk = [remaining substringToIndex:(NSUInteger)split];
        const int end = index + split;
        const BOOL isFinalChunk = split >= remainingLen;
        NSString *reason = isFinalChunk ? @"finalize" : (foundBoundary ? @"punctuation" : @"length_limit");
        [segments addObject:@{
          @"segmentId": [NSString stringWithFormat:@"txtseg_%@_%ld", bufferId ?: @"", (long)segments.count],
          @"startOffset": @(index),
          @"endOffset": @(end),
          @"reason": reason,
          @"source": @"segmentation_engine",
          @"text": chunk ?: @"",
        }];
        index = end;
      }
      resolve(@{
        @"bufferId": bufferId ?: @"",
        @"kind": @"offlineTextBuffer",
        @"state": @"immutable",
        @"segmentCount": @(segments.count),
        @"segments": segments,
      });
      return;
    }

    if (domainRaw != "speech") {
      reject(@"POLICY_INVALID", [NSString stringWithFormat:@"Unsupported segmentation domain: %@", domain ?: @""], nil);
      return;
    }

    int sampleRate = 0;
    int totalSamples = 0;
    std::string metaErrCode;
    std::string metaErrMessage;
    if (!pa_get_offline_metadata(
          bid,
          &sampleRate,
          &totalSamples,
          &metaErrCode,
          &metaErrMessage
        )) {
      reject(@"BUFFER_STATE_INVALID", [NSString stringWithFormat:@"Offline audio buffer not found: %@", bufferId], nil);
      return;
    }

    SegEnginePolicy p = seg_policy_from_dict(policy, SegEngineDomain::SPEECH);
    if (p.evaluator == "continuous_frames") {
      reject(@"POLICY_INVALID_FOR_OFFLINE", @"Policy evaluator 'continuous_frames' is streaming-only and invalid for offline segmentation", nil);
      return;
    }

    std::vector<SegRecord> records;
    if (p.evaluator == "speech_vad_model") {
      auto tempEngine = std::make_shared<SegEngine>();
      tempEngine->attachedBufferId = bid;
      tempEngine->policy = p;
      std::string vadError;
      if (!seg_init_vad_runtime(tempEngine, sampleRate, &vadError)) {
        NSString *message = [NSString stringWithUTF8String:vadError.c_str()] ?: @"speech_vad_model runtime init failed";
        reject(@"POLICY_MODEL_UNAVAILABLE", message, nil);
        return;
      }

      const int frameSize = std::max(1, tempEngine->vadFrameSize);
      const int chunkSize = std::max(frameSize, frameSize * 8);
      std::vector<float> pending;

      auto appendRecord = [&](int startSample, int endSample, const std::string &reason) {
        if (endSample <= startSample) return;
        SegRecord rec;
        rec.id = "seg_" + seg_uuid();
        rec.kind = "speech";
        rec.sourceAudioBufferId = bid;
        rec.startSample = startSample;
        rec.endSample = endSample;
        rec.sampleRate = sampleRate;
        rec.durationMs = (int)(((endSample - startSample) * 1000.0) / std::max(1, sampleRate));
        NSDictionary *payloadObj = @{
          @"source": @"vad",
          @"engine": @"vad",
          @"decision": @"model",
        };
        NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];
        if (payloadData) rec.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
        records.push_back(rec);
        seg_record_annotation(rec.id, reason, (int)records.size() - 1);
      };

      int cursor = 0;
      while (cursor < totalSamples) {
        std::vector<float> chunk;
        std::string sliceErrCode;
        std::string sliceErrMessage;
        const int readCount = std::min(chunkSize, totalSamples - cursor);
        if (!pa_get_offline_samples_slice(
              bid,
              cursor,
              readCount,
              &chunk,
              &sliceErrCode,
              &sliceErrMessage
            )) {
          NSString *message = [NSString stringWithUTF8String:sliceErrMessage.c_str()] ?: @"Failed to read offline audio slice";
          reject(@"BUFFER_STATE_INVALID", message, nil);
          return;
        }
        cursor += (int)chunk.size();
        if (chunk.empty()) break;

        pending.insert(pending.end(), chunk.begin(), chunk.end());
        while ((int)pending.size() >= frameSize) {
          tempEngine->vadRuntime->AcceptWaveform(pending.data(), frameSize);
          auto segments = tempEngine->vadRuntime->PopSegments();
          for (const auto &segment : segments) {
            appendRecord(segment.startSample, segment.endSample, "vad_boundary");
          }
          pending.erase(pending.begin(), pending.begin() + frameSize);
        }
      }

      if (!pending.empty()) {
        std::vector<float> tail(frameSize, 0.0f);
        std::copy(pending.begin(), pending.end(), tail.begin());
        tempEngine->vadRuntime->AcceptWaveform(tail.data(), frameSize);
        auto segments = tempEngine->vadRuntime->PopSegments();
        for (const auto &segment : segments) {
          appendRecord(segment.startSample, segment.endSample, "vad_boundary");
        }
      }

      tempEngine->vadRuntime->Flush();
      {
        auto segments = tempEngine->vadRuntime->PopSegments();
        for (const auto &segment : segments) {
          appendRecord(segment.startSample, segment.endSample, "finalize");
        }
      }
    } else if (p.evaluator == "speech_pyannote_segmentation") {
      if (p.modelPath.empty()) {
        reject(@"POLICY_MODEL_UNAVAILABLE",
               @"speech_pyannote_segmentation modelPath must be an existing .onnx file",
               nil);
        return;
      }
      {
        NSString *path = [NSString stringWithUTF8String:p.modelPath.c_str()];
        if (path == nil || ![[NSFileManager defaultManager] fileExistsAtPath:path]) {
          reject(@"POLICY_MODEL_UNAVAILABLE",
                 [NSString stringWithFormat:
                   @"speech_pyannote_segmentation modelPath must be an existing .onnx file: %@",
                   path ?: @""],
                 nil);
          return;
        }
      }

      auto session =
        std::make_shared<sherpaonnx::diarization::PyannoteSegmentationSession>();
      sherpaonnx::diarization::PyannoteSegOptions options;
      options.model_path = p.modelPath;
      options.window_shift_ratio = static_cast<float>(p.windowShiftRatio);
      options.min_duration_on = static_cast<float>(p.minDurationOn);
      options.min_duration_off = static_cast<float>(p.minDurationOff);
      auto initStatus = session->Initialize(options);
      if (!initStatus.ok) {
        NSString *message =
          [NSString stringWithUTF8String:
            (initStatus.message.empty()
               ? (initStatus.code.empty() ? "init failed"
                                          : initStatus.code.c_str())
               : initStatus.message.c_str())]
          ?: @"speech_pyannote_segmentation failed to initialize runtime";
        reject(@"POLICY_MODEL_UNAVAILABLE", message, nil);
        return;
      }

      std::vector<float> samples;
      if (totalSamples > 0) {
        std::string sliceErrCode;
        std::string sliceErrMessage;
        if (!pa_get_offline_samples_slice(
              bid,
              0,
              totalSamples,
              &samples,
              &sliceErrCode,
              &sliceErrMessage
            )) {
          NSString *message =
            [NSString stringWithUTF8String:sliceErrMessage.c_str()]
            ?: @"Failed to read offline audio slice";
          reject(@"BUFFER_STATE_INVALID", message, nil);
          return;
        }
      }

      std::vector<sherpaonnx::diarization::PyannoteSpeechSpan> spans;
      if (!samples.empty()) {
        auto processStatus = session->ProcessMono(
          samples.data(),
          static_cast<int32_t>(samples.size()),
          sampleRate,
          &spans
        );
        if (!processStatus.ok) {
          NSString *message =
            [NSString stringWithUTF8String:
              (processStatus.message.empty()
                 ? (processStatus.code.empty() ? "process failed"
                                               : processStatus.code.c_str())
                 : processStatus.message.c_str())]
            ?: @"speech_pyannote_segmentation process failed";
          reject(@"POLICY_MODEL_UNAVAILABLE", message, nil);
          return;
        }
      }

      const int minSamples =
        std::max(1, (int)((p.minSegmentMs / 1000.0) * sampleRate));
      const int maxSamples =
        std::max(minSamples, (int)((p.maxSegmentMs / 1000.0) * sampleRate));
      NSDictionary *payloadObj = @{ @"source": @"pyannote" };
      NSData *payloadData =
        [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];

      auto appendPyannote = [&](int startSample, int endSample, const std::string &reason) {
        if (endSample <= startSample) return;
        const int durationMs =
          (int)(((endSample - startSample) * 1000.0) / std::max(1, sampleRate));
        if (durationMs < p.minSegmentMs) return;
        SegRecord rec;
        rec.id = "seg_" + seg_uuid();
        rec.kind = "speech";
        rec.sourceAudioBufferId = bid;
        rec.startSample = startSample;
        rec.endSample = endSample;
        rec.sampleRate = sampleRate;
        rec.durationMs = durationMs;
        if (payloadData) {
          rec.payloadJson.assign(
            (const char *)payloadData.bytes, payloadData.length
          );
        }
        records.push_back(rec);
        seg_record_annotation(rec.id, reason, (int)records.size() - 1);
      };

      for (size_t i = 0; i < spans.size(); ++i) {
        int start = (int)std::lround(spans[i].start * sampleRate);
        int end = (int)std::lround(spans[i].end * sampleRate);
        start = std::max(0, std::min(start, totalSamples));
        end = std::max(0, std::min(end, totalSamples));
        if (end <= start) continue;
        if (end - start < minSamples) continue;

        while (end - start > maxSamples) {
          const int chunkEnd = start + maxSamples;
          appendPyannote(start, chunkEnd, "length_limit");
          start = chunkEnd;
        }
        const std::string reason =
          (i + 1 == spans.size()) ? "finalize" : "pyannote_boundary";
        appendPyannote(start, end, reason);
      }
    } else {
      int minSamples = std::max(1, (int)((p.minSegmentMs / 1000.0) * sampleRate));
      int maxSamples = std::max(minSamples, (int)((p.maxSegmentMs / 1000.0) * sampleRate));
      int silenceSamples = std::max(1, (int)(((p.silenceThresholdMs + p.hangoverMs) / 1000.0) * sampleRate));
      int frameSize = std::max(160, sampleRate / 50);

      int start = 0;
      int cursor = 0;
      int silenceRun = 0;
      while (cursor < totalSamples) {
        int readCount = std::min(frameSize, totalSamples - cursor);
        std::vector<float> frame;
        std::string sliceErrCode;
        std::string sliceErrMessage;
        if (!pa_get_offline_samples_slice(
              bid,
              cursor,
              readCount,
              &frame,
              &sliceErrCode,
              &sliceErrMessage
            )) {
          NSString *message = [NSString stringWithUTF8String:sliceErrMessage.c_str()] ?: @"Failed to read offline audio slice";
          reject(@"BUFFER_STATE_INVALID", message, nil);
          return;
        }
        if (frame.empty()) break;

        int end = cursor + (int)frame.size();
        double db = seg_rms_db(frame.data(), frame.size());
        if (db < p.energyThresholdDb) silenceRun += (int)frame.size();
        else silenceRun = 0;

        int segLen = end - start;
        bool silenceCommit = silenceRun >= silenceSamples && segLen >= minSamples;
        bool lengthCommit = segLen >= maxSamples;
        if (silenceCommit || lengthCommit) {
          SegRecord rec;
          rec.id = "seg_" + seg_uuid();
          rec.kind = "speech";
          rec.sourceAudioBufferId = bid;
          rec.startSample = start;
          rec.endSample = end;
          rec.sampleRate = sampleRate;
          rec.durationMs = (int)(((end - start) * 1000.0) / sampleRate);
          NSDictionary *payloadObj = @{
            @"source": @"vad",
            @"engine": @"vad",
            @"decision": @"model",
            @"score": @(db),
          };
          NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];
          if (payloadData) rec.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
          records.push_back(rec);
          std::string reason = seg_reason_from_eval(p.evaluator, silenceCommit);
          seg_record_annotation(rec.id, reason, (int)records.size() - 1);
          start = end;
          silenceRun = 0;
        }
        cursor = end;
      }

      if (start < totalSamples) {
        SegRecord rec;
        rec.id = "seg_" + seg_uuid();
        rec.kind = "speech";
        rec.sourceAudioBufferId = bid;
        rec.startSample = start;
        rec.endSample = totalSamples;
        rec.sampleRate = sampleRate;
        rec.durationMs = (int)(((totalSamples - start) * 1000.0) / sampleRate);
        NSDictionary *payloadObj = @{
          @"source": @"vad",
          @"engine": @"vad",
          @"decision": @"model",
        };
        NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payloadObj options:0 error:nil];
        if (payloadData) rec.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
        records.push_back(rec);
        seg_record_annotation(rec.id, "finalize", (int)records.size() - 1);
      }
    }

    auto off = std::make_shared<SegOfflineEntry>();
    off->bufferId = seg_new_id("seg_off");
    off->segments = records;
    off->sourceAudioBufferId = bid;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_offline[off->bufferId] = off;
    }
    resolve(@{
      @"bufferId": [NSString stringWithUTF8String:off->bufferId.c_str()] ?: @"",
      @"kind": @"offlineSegmentBuffer",
      @"state": @"immutable",
      @"segmentCount": @((int)records.size()),
      @"sourceAudioBufferId": bufferId ?: @"",
    });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)createLiveSegmentBuffer:(JS::NativeSherpaOnnx::SpecCreateLiveSegmentBufferOptions &)options
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  try {
    auto entry = std::make_shared<SegLiveEntry>();
    entry->bufferId = seg_new_id("seg_live");
    NSString *sourceAudioBufferId = options.sourceAudioBufferId();
    entry->sourceAudioBufferId = sourceAudioBufferId != nil ? [sourceAudioBufferId UTF8String] : "";
    auto maxSegmentsOpt = options.maxSegments();
    entry->maxSegments = maxSegmentsOpt.has_value() ? std::max(1, static_cast<int>(maxSegmentsOpt.value())) : 4096;
    NSString *modeRaw = options.spoolingMode();
    if (modeRaw == nil || modeRaw.length == 0) modeRaw = @"on";
    if ([modeRaw isEqualToString:@"off"]) entry->spoolingMode = SegLiveEntry::SPOOL_OFF;
    else if ([modeRaw isEqualToString:@"auto"]) entry->spoolingMode = SegLiveEntry::SPOOL_AUTO;
    else entry->spoolingMode = SegLiveEntry::SPOOL_ON;

    NSString *spoolPath = options.spoolingPath();
    if (entry->spoolingMode != SegLiveEntry::SPOOL_OFF) {
      if (spoolPath.length > 0) {
        entry->spoolPath = spoolPath.UTF8String;
      } else {
        NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
                         [NSString stringWithFormat:@"seg_spool_%@.json", [NSUUID UUID].UUIDString]];
        entry->spoolPath = tmp.UTF8String;
      }
    }
    if (auto spoolingTemporaryOpt = options.spoolingTemporary()) {
      entry->spoolTemporary = spoolingTemporaryOpt.value();
    } else {
      entry->spoolTemporary = (spoolPath.length == 0);
    }
    if (auto spoolingThresholdBytesOpt = options.spoolingThresholdBytes()) {
      entry->spoolThresholdBytes = static_cast<int64_t>(spoolingThresholdBytesOpt.value());
    }
    auto emitSegmentAppendedOpt = options.emitSegmentAppendedEvents();
    entry->emitSegmentAppended = emitSegmentAppendedOpt.has_value() && emitSegmentAppendedOpt.value();
    if (auto segmentEventMinIntervalMsOpt = options.segmentEventMinIntervalMs()) {
      entry->segmentEventMinIntervalMs = static_cast<int64_t>(segmentEventMinIntervalMsOpt.value());
    }
    __weak SherpaOnnx *weakModule = self;
    entry->segmentAppendedEmitter = [weakModule](
      const std::string &segmentBufferId,
      const SegRecord &rec,
      int segIdx,
      int totalSegments
    ) {
      SherpaOnnx *m = weakModule;
      if (!m) {
        return;
      }
      NSMutableDictionary *body = [NSMutableDictionary dictionary];
      body[@"segmentBufferId"] = [NSString stringWithUTF8String:segmentBufferId.c_str()];
      body[@"segmentId"] = [NSString stringWithUTF8String:rec.id.c_str()];
      body[@"segmentIndex"] = @(segIdx);
      body[@"totalSegments"] = @(totalSegments);
      body[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:rec.sourceAudioBufferId.c_str()];
      body[@"startSample"] = @(rec.startSample);
      body[@"endSample"] = @(rec.endSample);
      body[@"sampleRate"] = @(rec.sampleRate);
      body[@"durationMs"] = @(rec.durationMs);
      std::string annReason;
      std::string annSource;
      int64_t annCreatedAtMs = 0;
      int annSegmentIndex = 0;
      if (seg_engine_peek_annotation(rec.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
        body[@"reason"] = [NSString stringWithUTF8String:annReason.c_str()] ?: @"manual_commit";
        body[@"source"] = [NSString stringWithUTF8String:annSource.c_str()] ?: @"manual";
        body[@"createdAtMs"] = @(annCreatedAtMs);
      } else {
        body[@"reason"] = @"manual_commit";
        body[@"source"] = @"manual";
        body[@"createdAtMs"] = @((int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0));
      }
      if (rec.hasConfidence) {
        body[@"confidence"] = @(rec.confidence);
      }
      if (!rec.payloadJson.empty()) {
        NSData *payloadData = [[NSString stringWithUTF8String:rec.payloadJson.c_str()]
          dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *payloadObj =
          payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
        if (payloadObj) {
          body[@"payload"] = payloadObj;
        }
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [m sendEventWithName:@"pipelineLiveSegmentAppended" body:body];
      });
    };
    if (entry->spoolingMode == SegLiveEntry::SPOOL_ON) {
      entry->activateSpoolIfNeeded();
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

- (void)createEmptyOfflineSegmentBuffer:(JS::NativeSherpaOnnx::SpecCreateEmptyOfflineSegmentBufferOptions &)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  auto entry = std::make_shared<SegOfflineEntry>();
  entry->bufferId = seg_new_id("seg_off");
  if (NSString *sourceAudioBufferId = options.sourceAudioBufferId()) {
    entry->sourceAudioBufferId = [sourceAudioBufferId UTF8String];
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
    SegRecord seg;
    seg.id = "seg_" + seg_uuid();
    seg.kind = kind.length > 0 ? kind.UTF8String : "speech";
    if (!seg_is_valid_kind(seg.kind)) {
      reject(@"SEGMENT_INVALID_ARGUMENT", @"kind must be one of speech, alignment, or diarization", nil);
      return;
    }
    if (seg.kind == "speech") {
      NSString *validationError = nil;
      if (!seg_validate_strict_speech_payload(payload, &validationError)) {
        reject(@"SEGMENT_INVALID_ARGUMENT", validationError ?: @"Invalid speech payload", nil);
        return;
      }
    }
    if ((int)sampleRate <= 0) {
      reject(@"SEGMENT_INVALID_ARGUMENT", @"sampleRate must be > 0", nil);
      return;
    }
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
    std::string checkpointSnapshot;
    int segmentIndex = 0;
    {
      std::lock_guard<std::mutex> lock(entry->lock);
      if (entry->state == SegLiveEntry::FINISHED) {
        throw std::runtime_error("SEGMENT_ALREADY_FINALIZED: Live segment buffer is finalized");
      }
      segmentIndex = (int)(entry->evictedCount + (int64_t)entry->segments.size());
      entry->segments.push_back(seg);
      if ((int)entry->segments.size() > entry->maxSegments) {
        entry->segments.erase(entry->segments.begin());
        entry->evictedCount++;
      }
      entry->totalSegmentsWritten++;
      checkpointSnapshot = entry->snapshotForSpoolLocked();
    }
    entry->maybeAppendSegmentToSpool(seg, true, checkpointSnapshot);

    if ([payload isKindOfClass:[NSDictionary class]]) {
      NSString *annReason = [payload[@"__annotationReason"] isKindOfClass:[NSString class]] ? payload[@"__annotationReason"] : nil;
      NSString *annSource = [payload[@"__annotationSource"] isKindOfClass:[NSString class]] ? payload[@"__annotationSource"] : nil;
      if (annReason.length > 0 && annSource.length > 0) {
        int64_t annCreatedAtMs = [payload[@"__annotationCreatedAtMs"] isKindOfClass:[NSNumber class]]
          ? ((NSNumber *)payload[@"__annotationCreatedAtMs"]).longLongValue
          : (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
        std::lock_guard<std::mutex> annLock(g_seg_engine_mutex);
        g_seg_engine_annotation_by_segment[seg.id] = SegEngineAnnotation{
          annReason.UTF8String,
          annSource.UTF8String,
          annCreatedAtMs,
          segmentIndex,
        };
      }
    }

    seg_notify_segment_appended(entry, seg, segmentIndex);
    entry->notifyCommitListeners(seg.id, segmentIndex, seg);
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

    std::shared_ptr<SegOfflineEntry> off;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      off = std::make_shared<SegOfflineEntry>();
      off->bufferId = seg_new_id("seg_off");
      off->segments = records;
      off->sourceAudioBufferId = live->sourceAudioBufferId;
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

- (void)populateOfflineSegmentBufferIfEmpty:(NSString *)targetBufferId
                                liveBufferId:(NSString *)liveBufferId
                                        mode:(NSString *)mode
                                     resolve:(RCTPromiseResolveBlock)resolve
                                      reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> live;
  std::shared_ptr<SegOfflineEntry> off;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto liveIt = g_seg_live.find(liveBufferId.UTF8String);
    if (liveIt == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    live = liveIt->second;
    auto offIt = g_seg_offline.find(targetBufferId.UTF8String);
    if (offIt == g_seg_offline.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Offline segment buffer not found: %@", targetBufferId], nil);
      return;
    }
    off = offIt->second;
    if (!off->segments.empty()) {
      reject(@"SEGMENT_INVALID_STATE", [NSString stringWithFormat:@"Offline segment buffer already populated: %@", targetBufferId], nil);
      return;
    }
  }

  try {
    std::vector<SegRecord> records;
    if ([mode isEqualToString:@"windowSnapshot"]) {
      records = live->snapshotWindow();
    } else if (mode == nil || [mode isEqualToString:@"fullIfSpooled"]) {
      records = live->snapshotFullIfSpooled();
    } else {
      reject(@"SEGMENT_INVALID_ARGUMENT", [NSString stringWithFormat:@"Unknown mode: %@", mode], nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      if (!off->segments.empty()) {
        reject(@"SEGMENT_INVALID_STATE", [NSString stringWithFormat:@"Offline segment buffer already populated: %@", targetBufferId], nil);
        return;
      }
      off->segments = records;
    }
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
                                  start:(NSNumber *)start
                               maxCount:(NSNumber *)maxCount
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  // Codegen passes optional slice args as NSNumber* (see SherpaOnnxSpec.h). Using
  // double here misaligns NSInvocation and corrupts resolve/reject (SIGSEGV).
  const double startVal = start != nil ? start.doubleValue : 0.0;
  const double maxCountVal = maxCount != nil ? maxCount.doubleValue : 4096.0;
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"getOfflineSegmentBufferSegments enter bufferId=%@ start=%.3f maxCount=%.3f thread=%@",
    bufferId ?: @"<nil>",
    startVal,
    maxCountVal,
    [NSThread isMainThread] ? @"main" : @"background"]);
#endif
  @try {
    if (!std::isfinite(startVal) || !std::isfinite(maxCountVal)) {
      seg_debug_log(@"getOfflineSegmentBufferSegments reject invalid finite slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    const int64_t s64 = static_cast<int64_t>(startVal);
    const int64_t c64 = static_cast<int64_t>(maxCountVal);
    if (s64 < 0 || c64 < 0) {
      seg_debug_log(@"getOfflineSegmentBufferSegments reject negative slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }

    std::vector<SegRecord> snap;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      const char *bufferKey = bufferId.UTF8String;
      if (bufferKey == nullptr) {
        reject(@"SEGMENT_BUFFER_NOT_FOUND", @"Offline segment buffer not found", nil);
        return;
      }
      auto it = g_seg_offline.find(bufferKey);
      if (it == g_seg_offline.end()) {
        seg_debug_log([NSString stringWithFormat:
          @"getOfflineSegmentBufferSegments reject not found bufferId=%@",
          bufferId ?: @"<nil>"]);
        reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Offline segment buffer not found: %@", bufferId], nil);
        return;
      }
      auto &segments = it->second->segments;
      const int64_t total = static_cast<int64_t>(segments.size());
      const int64_t end64 = std::min<int64_t>(total, s64 + c64);
#if DEBUG
      seg_debug_log([NSString stringWithFormat:
        @"getOfflineSegmentBufferSegments slice total=%lld s=%lld c=%lld end=%lld",
        (long long)total,
        (long long)s64,
        (long long)c64,
        (long long)end64]);
#endif
      if (s64 < total && end64 > s64) {
        const size_t from = static_cast<size_t>(s64);
        const size_t to = static_cast<size_t>(end64);
        snap.assign(segments.begin() + from, segments.begin() + to);
      }
    }

    NSArray *segmentsOut = nil;
    if (snap.empty()) {
      segmentsOut = @[];
    } else {
      NSMutableArray *arr = [NSMutableArray arrayWithCapacity:snap.size()];
      seg_debug_log([NSString stringWithFormat:
        @"getOfflineSegmentBufferSegments serializing snapCount=%lu",
        (unsigned long)snap.size()]);
      for (const auto &r : snap) {
        [arr addObject:segRecordToDict(r)];
      }
      segmentsOut = [arr copy];
    }
    seg_debug_log([NSString stringWithFormat:
      @"getOfflineSegmentBufferSegments resolve segments=%lu",
      (unsigned long)segmentsOut.count]);
    resolve(@{@"segments": segmentsOut});
  } @catch (NSException *exception) {
    seg_debug_log([NSString stringWithFormat:
      @"getOfflineSegmentBufferSegments exception name=%@ reason=%@",
      exception.name ?: @"<nil>",
      exception.reason ?: @"<nil>"]);
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason ?: @"Failed to read offline segments", nil);
  }
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
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"getLiveSegmentBufferSegments enter bufferId=%@ start=%.3f maxCount=%.3f thread=%@",
    liveBufferId ?: @"<nil>",
    startIndex,
    maxCount,
    [NSThread isMainThread] ? @"main" : @"background"]);
#endif
  @try {
    std::shared_ptr<SegLiveEntry> entry;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      const char *bufferKey = liveBufferId.UTF8String;
      if (bufferKey == nullptr) {
        reject(@"SEGMENT_BUFFER_NOT_FOUND", @"Live segment buffer not found", nil);
        return;
      }
      auto it = g_seg_live.find(bufferKey);
      if (it == g_seg_live.end()) {
        reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
        return;
      }
      entry = it->second;
    }
    if (!std::isfinite(startIndex) || !std::isfinite(maxCount)) {
      seg_debug_log(@"getLiveSegmentBufferSegments reject invalid finite slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    const int64_t s64 = static_cast<int64_t>(startIndex);
    const int64_t c64 = static_cast<int64_t>(maxCount);
    if (s64 < 0 || c64 < 0) {
      seg_debug_log(@"getLiveSegmentBufferSegments reject negative slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    std::vector<SegRecord> snap;
    {
      std::lock_guard<std::mutex> guard(entry->lock);
      const int64_t total = static_cast<int64_t>(entry->segments.size());
      const int64_t end64 = std::min<int64_t>(total, s64 + c64);
      if (s64 < total && end64 > s64) {
        const size_t from = static_cast<size_t>(s64);
        const size_t to = static_cast<size_t>(end64);
        snap.assign(entry->segments.begin() + from, entry->segments.begin() + to);
      }
    }
    NSArray *segmentsOut = nil;
    if (snap.empty()) {
      segmentsOut = @[];
    } else {
      NSMutableArray *arr = [NSMutableArray arrayWithCapacity:snap.size()];
      seg_debug_log([NSString stringWithFormat:
        @"getLiveSegmentBufferSegments serializing snapCount=%lu",
        (unsigned long)snap.size()]);
      for (const auto &r : snap) {
        [arr addObject:segRecordToDict(r)];
      }
      segmentsOut = [arr copy];
    }
    seg_debug_log([NSString stringWithFormat:
      @"getLiveSegmentBufferSegments resolve segments=%lu",
      (unsigned long)segmentsOut.count]);
    resolve(@{@"segments": segmentsOut});
  } @catch (NSException *exception) {
    seg_debug_log([NSString stringWithFormat:
      @"getLiveSegmentBufferSegments exception name=%@ reason=%@",
      exception.name ?: @"<nil>",
      exception.reason ?: @"<nil>"]);
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason ?: @"Failed to read live segments", nil);
  }
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
