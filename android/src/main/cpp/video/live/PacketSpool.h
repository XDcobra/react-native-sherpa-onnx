#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "VideoTypes.h"
#include "core/FileIo.h"

namespace sherpa_onnx {
namespace video {

enum class SpoolRetentionMode { Session, None, MaxSeconds, Path };

struct SpoolOptions {
  SpoolRetentionMode mode = SpoolRetentionMode::Session;
  int64_t maxSeconds = 0;
  std::string directory;
  int64_t segmentSeconds = 10;
  int64_t segmentMaxBytes = 256LL * 1024 * 1024;
};

struct SpoolEvent {
  std::string type;  // spoolError, spoolOverflow
  std::string message;
};

class PacketSpool {
 public:
  ~PacketSpool();
  Status Open(const std::string& cacheDir, const std::string& uuid,
              const VideoTrackInfo& track, const SpoolOptions& opts);
  /** Non-blocking enqueue. Overflow drops until next key + discontinuity. */
  Status Enqueue(const EncodedPacket& pkt);
  Status Read(int64_t presentationIndex, EncodedPacket* out);
  Status Finish();
  void CloseAndDelete();
  bool active() const;
  TimeRange rangeUs() const;
  bool Recover();
  std::vector<SpoolEvent> TakeEvents();
  int64_t presentationCount() const;

 private:
  struct Segment {
    std::string path;
    int fd = -1;
    int64_t bytes = 0;
    int64_t startPres = 0;
    int64_t count = 0;
  };

  Status WriteRecord(int fd, const EncodedPacket& pkt, int64_t* offset);
  Status RotateIfNeeded(const EncodedPacket& pkt);
  Status WriteHeader(int fd, const VideoTrackInfo& track);

  mutable std::mutex mu_;
  SpoolOptions opts_;
  VideoTrackInfo track_;
  std::string dir_;
  std::string uuid_;
  std::vector<Segment> segments_;
  std::vector<int64_t> offsets_;  // file offset per presentation index
  std::vector<int> segmentOf_;
  std::vector<EncodedPacket> queue_;
  std::vector<SpoolEvent> events_;
  bool active_ = false;
  bool overflow_ = false;
  int64_t nextPres_ = 0;
  TimeRange range_{};
};

}  // namespace video
}  // namespace sherpa_onnx
