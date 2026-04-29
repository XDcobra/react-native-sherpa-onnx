#import "../../SherpaOnnx.h"
#include "../core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../vad/core/VadRuntime.h"

#ifdef __cplusplus
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <random>
#include <sstream>
#include <unordered_set>
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

bool seg_is_valid_kind(const std::string &kind) {
  return kind == "speech" || kind == "alignment";
}

bool seg_validate_strict_speech_payload(NSDictionary *payload, NSString **errorMessage) {
  if (![payload isKindOfClass:[NSDictionary class]]) {
    if (errorMessage) *errorMessage = @"speech payload is required and must include source";
    return false;
  }
  NSString *source = [payload[@"source"] isKindOfClass:[NSString class]] ? payload[@"source"] : nil;
  if (source.length == 0) {
    if (errorMessage) *errorMessage = @"speech payload.source must be one of vad, stt, tts";
    return false;
  }
  NSSet<NSString *> *allowed = nil;
  if ([source isEqualToString:@"vad"]) {
    allowed = [NSSet setWithArray:@[@"source", @"engine", @"decision", @"score"]];
  } else if ([source isEqualToString:@"stt"]) {
    allowed = [NSSet setWithArray:@[@"source", @"transcript", @"tokenCount", @"isFinal"]];
  } else if ([source isEqualToString:@"tts"]) {
    allowed = [NSSet setWithArray:@[@"source", @"text", @"chunkIndex", @"isFinalChunk"]];
  } else {
    if (errorMessage) *errorMessage = @"speech payload.source must be one of vad, stt, tts";
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
    int segmentIndex)>
    segmentAppendedEmitter;

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

  void maybeWriteSnapshotToSpool(const std::string &snapshot, bool mayActivateAuto) {
    if (!spoolEnabled()) return;
    std::lock_guard<std::mutex> lockGuard(spoolLock);
    if (!spoolFailureCode.empty()) throw std::runtime_error(spoolFailureCode + ": " + spoolFailureMessage);
    if (!journalFile) {
      switch (spoolingMode) {
        case SPOOL_OFF: return;
        case SPOOL_ON:
          ensureSpoolWriterActivatedLocked(snapshot);
          return;
        case SPOOL_AUTO: {
          if (!mayActivateAuto) return;
          spoolEstimatedBytes += (int64_t)(kHeaderBytes + snapshot.size());
          if (spoolEstimatedBytes < std::max<int64_t>(0, spoolThresholdBytes)) {
            spoolReady = false;
            return;
          }
          ensureSpoolWriterActivatedLocked(snapshot);
          return;
        }
      }
    }
    appendJournalRecordLocked(kRecordSegmentAppend, snapshot);
    journalEventCount += 1;
    journalBytesSinceCheckpoint += (kHeaderBytes + snapshot.size());
    if (journalEventCount >= kCheckpointEveryEvents || journalBytesSinceCheckpoint >= kCheckpointEveryBytes) {
      writeCheckpointSnapshotLocked(snapshotForSpoolLocked());
      fclose(journalFile);
      journalFile = fopen(journalPath().c_str(), "wb");
      if (!journalFile) throwSpoolError("SEGMENT_SPOOL_WRITE_FAILED", "Failed to rotate segment journal for " + bufferId);
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
          if (!parsed.empty()) result.push_back(parsed[0]);
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
  }
};

namespace {

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
  std::string annReason;
  std::string annSource;
  int64_t annCreatedAtMs = 0;
  int annSegmentIndex = 0;
  if (seg_engine_peek_annotation(r.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
    dict[@"reason"] = [NSString stringWithUTF8String:annReason.c_str()] ?: @"manual_commit";
    dict[@"source"] = [NSString stringWithUTF8String:annSource.c_str()] ?: @"manual";
    dict[@"createdAtMs"] = @(annCreatedAtMs);
  }
  if (r.hasConfidence) dict[@"confidence"] = @(r.confidence);
  if (!r.payloadJson.empty()) {
    NSData *payloadData = [[NSString stringWithUTF8String:r.payloadJson.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *payloadObj = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if (payloadObj) dict[@"payload"] = payloadObj;
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
  entry->segmentAppendedEmitter(entry->bufferId, seg, segmentIndex);
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
    std::lock_guard<std::mutex> lock(entry->lock);
    if (entry->state == SegLiveEntry::FINISHED) {
      if (error) *error = "SEGMENT_ALREADY_FINALIZED: Live segment buffer is finalized";
      return false;
    }
    SegRecord seg;
    seg.id = "seg_" + seg_uuid();
    seg.kind = kind.empty() ? "speech" : kind;
    if (!seg_is_valid_kind(seg.kind)) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: kind must be one of speech or alignment";
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
    seg.sourceAudioBufferId = sourceAudioBufferId.empty() ? entry->sourceAudioBufferId : sourceAudioBufferId;
    seg.startSample = startSample;
    seg.endSample = endSample;
    seg.sampleRate = sampleRate;
    seg.durationMs = durationMs > 0 ? durationMs : static_cast<int>(((seg.endSample - seg.startSample) * 1000.0) / std::max(1, seg.sampleRate));
    seg.hasConfidence = hasConfidence;
    if (hasConfidence) seg.confidence = confidence;
    seg.payloadJson = payloadJson;

    const int idx = static_cast<int>(entry->evictedCount + static_cast<int64_t>(entry->segments.size()));
    entry->segments.push_back(seg);
    std::string snapshot = entry->snapshotForSpoolLocked();
    if (static_cast<int>(entry->segments.size()) > entry->maxSegments) {
      entry->segments.erase(entry->segments.begin());
      entry->evictedCount++;
    }
    entry->totalSegmentsWritten++;
    entry->maybeWriteSnapshotToSpool(snapshot, true);

    seg_notify_segment_appended(entry, seg, idx);

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
  int maxLengthChars = 500;
  bool sentenceBoundary = true;
  int silenceThresholdMs = 500;
  double energyThresholdDb = -40.0;
  int minSegmentMs = 1000;
  int maxSegmentMs = 30000;
  int hangoverMs = 300;
  int checkpointIntervalMs = 0;
  std::string punctuationInstanceId;
  std::string vadModelId;
  double vadThreshold = 0.5;
  int vadMinSpeechMs = 250;
  int vadMinSilenceMs = 250;
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

static bool seg_directory_exists(const std::string &path) {
  if (path.empty()) return false;
  BOOL isDir = NO;
  BOOL exists = [[NSFileManager defaultManager]
    fileExistsAtPath:[NSString stringWithUTF8String:path.c_str()]
    isDirectory:&isDir];
  return exists && isDir;
}

static std::string seg_join_path(const std::string &dir, const std::string &name) {
  if (dir.empty()) return name;
  if (dir.back() == '/') return dir + name;
  return dir + "/" + name;
}

static std::string seg_resolve_vad_model_path(const std::string &modelId) {
  const std::string trimmed = modelId;
  if (trimmed.empty()) {
    return "";
  }

  if (seg_file_exists(trimmed)) {
    return trimmed;
  }

  if (seg_directory_exists(trimmed)) {
    static const std::vector<std::string> kCandidates = {
      "silero_vad.onnx",
      "silero.onnx",
      "model.onnx",
      "ten_vad.onnx",
      "ten-vad.onnx",
    };
    for (const auto &name : kCandidates) {
      const std::string candidate = seg_join_path(trimmed, name);
      if (seg_file_exists(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

static std::string seg_vad_model_type_from_path(const std::string &modelPath) {
  std::string lower = modelPath;
  std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
  return lower.find("ten") != std::string::npos ? "ten_vad" : "silero_vad";
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

  const std::string modelPath = seg_resolve_vad_model_path(engine->policy.vadModelId);
  if (modelPath.empty()) {
    if (errorOut) {
      *errorOut = "speech_vad_model model not found for vadModelId: " + engine->policy.vadModelId;
    }
    return false;
  }

  VadRuntimeConfig cfg;
  cfg.modelType = seg_vad_model_type_from_path(modelPath);
  cfg.modelPath = modelPath;
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

  seg_record_annotation_for_engine(engine, segmentId, reason, segmentIndex);
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

  seg_record_annotation_for_engine(engine, segmentId, reason, segmentIndex);
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

static void seg_engine_evaluate_text(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::ACTIVE) return;
  auto entry = txt_get_live_entry(engine->attachedBufferId);
  if (!entry) return;

  while (true) {
    std::string partial = entry->snapshotText();
    if (partial.empty()) break;

    int commitLength = 0;
    std::string reason = "policy_checkpoint";
    std::string decisionText = partial;

    if (engine->policy.evaluator == "text_punctuation_assisted") {
      if (engine->policy.punctuationInstanceId.empty()) {
        throw std::runtime_error(
          "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND: text_punctuation_assisted requires punctuationInstanceId"
        );
      }
      decisionText = seg_add_punctuation_or_throw(
        engine->policy.punctuationInstanceId,
        partial
      );
    }

    if (engine->policy.sentenceBoundary) {
      size_t boundary = decisionText.find_last_of(".!?;:\n");
      if (boundary != std::string::npos) {
        commitLength = std::min((int)partial.size(), (int)boundary + 1);
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
    const char *reason =
      engine->policy.evaluator == "continuous_frames" ? "policy_checkpoint" : "finalize";
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
  if ([p[@"silenceThresholdMs"] respondsToSelector:@selector(intValue)]) out.silenceThresholdMs = std::max(50, [p[@"silenceThresholdMs"] intValue]);
  if ([p[@"energyThresholdDb"] respondsToSelector:@selector(doubleValue)]) out.energyThresholdDb = [p[@"energyThresholdDb"] doubleValue];
  if ([p[@"minSegmentMs"] respondsToSelector:@selector(intValue)]) out.minSegmentMs = std::max(100, [p[@"minSegmentMs"] intValue]);
  if ([p[@"maxSegmentMs"] respondsToSelector:@selector(intValue)]) out.maxSegmentMs = std::max(out.minSegmentMs, [p[@"maxSegmentMs"] intValue]);
  if ([p[@"hangoverMs"] respondsToSelector:@selector(intValue)]) out.hangoverMs = std::max(0, [p[@"hangoverMs"] intValue]);
  if ([p[@"checkpointIntervalMs"] respondsToSelector:@selector(intValue)]) out.checkpointIntervalMs = std::max(0, [p[@"checkpointIntervalMs"] intValue]);
  if ([p[@"punctuationInstanceId"] isKindOfClass:[NSString class]]) out.punctuationInstanceId = [p[@"punctuationInstanceId"] UTF8String] ?: "";
  if ([p[@"vadModelId"] isKindOfClass:[NSString class]]) out.vadModelId = [p[@"vadModelId"] UTF8String] ?: "";
  if ([p[@"vadThreshold"] respondsToSelector:@selector(doubleValue)]) out.vadThreshold = [p[@"vadThreshold"] doubleValue];
  if ([p[@"vadMinSpeechMs"] respondsToSelector:@selector(intValue)]) out.vadMinSpeechMs = std::max(1, [p[@"vadMinSpeechMs"] intValue]);
  if ([p[@"vadMinSilenceMs"] respondsToSelector:@selector(intValue)]) out.vadMinSilenceMs = std::max(1, [p[@"vadMinSilenceMs"] intValue]);
  return out;
}

static NSDictionary *seg_engine_policy_to_dict(const SegEnginePolicy &p) {
  return @{
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
    @"vadModelId": [NSString stringWithUTF8String:p.vadModelId.c_str()] ?: @"",
    @"vadThreshold": @(p.vadThreshold),
    @"vadMinSpeechMs": @(p.vadMinSpeechMs),
    @"vadMinSilenceMs": @(p.vadMinSilenceMs),
  };
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
            engine->policy.evaluator == "continuous_frames")) {
        reject(@"POLICY_INVALID",
               [NSString stringWithFormat:@"Policy evaluator '%@' is invalid for speech domain",
                                          policy[@"evaluator"] ?: @""],
               nil);
        return;
      }
    }

    if (d == SegEngineDomain::SPEECH) {
      auto entry = std::make_shared<SegLiveEntry>();
      entry->bufferId = seg_new_id("seg_live");
      entry->sourceAudioBufferId = bid;
      entry->maxSegments = 1000;
      entry->spoolingMode = SegLiveEntry::SPOOL_ON;
      NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"seg_spool_%@.json", [NSUUID UUID].UUIDString]];
      entry->spoolPath = tmp.UTF8String ?: "";
      entry->spoolTemporary = true;
      entry->emitSegmentAppended = true;
      entry->segmentEventMinIntervalMs = 0;

      __weak SherpaOnnx *weakModule = self;
      entry->segmentAppendedEmitter = [weakModule](
        const std::string &liveId,
        const SegRecord &rec,
        int segIdx
      ) {
        SherpaOnnx *module = weakModule;
        if (!module) return;
        NSMutableDictionary *body = [NSMutableDictionary dictionary];
        body[@"liveBufferId"] = [NSString stringWithUTF8String:liveId.c_str()] ?: @"";
        body[@"segmentId"] = [NSString stringWithUTF8String:rec.id.c_str()] ?: @"";
        body[@"segmentIndex"] = @(segIdx);
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
      NSMutableArray *segments = [NSMutableArray array];
      int index = 0;
      while (index < (int)text.size()) {
        int split = -1;
        bool foundBoundary = false;
        std::string remaining = text.substr((size_t)index);
        if (p.sentenceBoundary) {
          size_t b = remaining.find_first_of(".!?\n");
          if (b != std::string::npos) {
            split = (int)b + 1;
            foundBoundary = true;
          }
        }
        if (split <= 0) split = std::min(std::max(1, p.maxLengthChars), (int)remaining.size());
        std::string chunk = remaining.substr(0, (size_t)split);
        int end = index + split;
        BOOL isFinalChunk = split >= (int)remaining.size();
        NSString *reason = isFinalChunk ? @"finalize" : (foundBoundary ? @"punctuation" : @"length_limit");
        [segments addObject:@{
          @"segmentId": [NSString stringWithFormat:@"txtseg_%@_%ld", bufferId ?: @"", (long)segments.count],
          @"startOffset": @(index),
          @"endOffset": @(end),
          @"reason": reason,
          @"source": @"segmentation_engine",
          @"text": [NSString stringWithUTF8String:chunk.c_str()] ?: @"",
        }];
        index += split;
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
    entry->emitSegmentAppended =
      [opts[@"emitSegmentAppendedEvents"] respondsToSelector:@selector(boolValue)] &&
      [opts[@"emitSegmentAppendedEvents"] boolValue];
    if ([opts[@"segmentEventMinIntervalMs"] respondsToSelector:@selector(longLongValue)]) {
      entry->segmentEventMinIntervalMs = [opts[@"segmentEventMinIntervalMs"] longLongValue];
    }
    __weak SherpaOnnx *weakModule = self;
    entry->segmentAppendedEmitter = [weakModule](
      const std::string &bufId,
      const SegRecord &rec,
      int segIdx
    ) {
      SherpaOnnx *m = weakModule;
      if (!m) {
        return;
      }
      NSMutableDictionary *body = [NSMutableDictionary dictionary];
      body[@"liveBufferId"] = [NSString stringWithUTF8String:bufId.c_str()];
      body[@"segmentId"] = [NSString stringWithUTF8String:rec.id.c_str()];
      body[@"segmentIndex"] = @(segIdx);
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
    if (!seg_is_valid_kind(seg.kind)) {
      reject(@"SEGMENT_INVALID_ARGUMENT", @"kind must be one of speech or alignment", nil);
      return;
    }
    if (seg.kind == "speech") {
      NSString *validationError = nil;
      if (!seg_validate_strict_speech_payload(payload, &validationError)) {
        reject(@"SEGMENT_INVALID_ARGUMENT", validationError ?: @"Invalid speech payload", nil);
        return;
      }
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
    const int segmentIndex = (int)(entry->evictedCount + (int64_t)entry->segments.size());
    entry->segments.push_back(seg);
    std::string snapshot = entry->snapshotForSpoolLocked();
    if ((int)entry->segments.size() > entry->maxSegments) {
      entry->segments.erase(entry->segments.begin());
      entry->evictedCount++;
    }
    entry->totalSegmentsWritten++;
    entry->maybeWriteSnapshotToSpool(snapshot, true);
    seg_notify_segment_appended(entry, seg, segmentIndex);
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
