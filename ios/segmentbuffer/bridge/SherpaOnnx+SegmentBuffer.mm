#import "../../SherpaOnnx.h"
#include "../core/SherpaOnnx+SegmentBufferGlobals.h"

#ifdef __cplusplus
#include <algorithm>
#include <cstdio>
#include <functional>
#include <random>
#include <sstream>
#include <unistd.h>
#include <zlib.h>

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
