#pragma once
/**
 * Shared live SegmentBuffer entry (SEG2 spool). Lifted from iOS SegmentBuffer.mm.
 */
#include "SegTypes.h"
#include "SegJson.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <sys/stat.h>
#include <zlib.h>

inline bool seg_file_exists(const std::string &path) {
  struct stat st;
  return ::stat(path.c_str(), &st) == 0;
}

inline void seg_ensure_parent_dirs(const std::string &filePath) {
  auto pos = filePath.find_last_of('/');
  if (pos == std::string::npos || pos == 0) return;
  std::string dir = filePath.substr(0, pos);
  std::string cur;
  for (size_t i = 0; i < dir.size(); ++i) {
    cur.push_back(dir[i]);
    if (dir[i] == '/' || i + 1 == dir.size()) {
      if (cur.size() <= 1) continue;
      ::mkdir(cur.c_str(), 0755);
    }
  }
}

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
    seg_ensure_parent_dirs(spoolPath);
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
    bool hasCheckpoint = seg_file_exists(cpPath);
    bool hasJournal = seg_file_exists(jPath);
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
