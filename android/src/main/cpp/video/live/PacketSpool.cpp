#include "live/PacketSpool.h"

#include "VideoLog.h"
#include "live/Crc32.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <filesystem>

namespace sherpa_onnx {
namespace video {
namespace {

constexpr uint32_t kFileMagic = 0x56425350;  // VBSP
constexpr uint32_t kRecMagic = 0x56425243;   // VBRC
constexpr uint32_t kVersion = 1;
constexpr size_t kMaxQueue = 64;

bool WriteU32(FileIo& io, int fd, int64_t* off, uint32_t v) {
  uint8_t b[4] = {static_cast<uint8_t>(v), static_cast<uint8_t>(v >> 8),
                  static_cast<uint8_t>(v >> 16), static_cast<uint8_t>(v >> 24)};
  const int64_t n = io.Pwrite(fd, b, 4, *off);
  if (n != 4) {
    return false;
  }
  *off += 4;
  return true;
}

bool WriteI64(FileIo& io, int fd, int64_t* off, int64_t v) {
  uint8_t b[8];
  for (int i = 0; i < 8; ++i) {
    b[i] = static_cast<uint8_t>(static_cast<uint64_t>(v) >> (8 * i));
  }
  const int64_t n = io.Pwrite(fd, b, 8, *off);
  if (n != 8) {
    return false;
  }
  *off += 8;
  return true;
}

bool ReadU32(FileIo& io, int fd, int64_t* off, uint32_t* v) {
  uint8_t b[4];
  const int64_t n = io.Pread(fd, b, 4, *off);
  if (n != 4) {
    return false;
  }
  *v = static_cast<uint32_t>(b[0]) | (static_cast<uint32_t>(b[1]) << 8) |
       (static_cast<uint32_t>(b[2]) << 16) | (static_cast<uint32_t>(b[3]) << 24);
  *off += 4;
  return true;
}

bool ReadI64(FileIo& io, int fd, int64_t* off, int64_t* v) {
  uint8_t b[8];
  const int64_t n = io.Pread(fd, b, 8, *off);
  if (n != 8) {
    return false;
  }
  uint64_t u = 0;
  for (int i = 0; i < 8; ++i) {
    u |= static_cast<uint64_t>(b[i]) << (8 * i);
  }
  *v = static_cast<int64_t>(u);
  *off += 8;
  return true;
}

}  // namespace

PacketSpool::~PacketSpool() { CloseAndDelete(); }

bool PacketSpool::active() const {
  std::lock_guard<std::mutex> lock(mu_);
  return active_;
}

TimeRange PacketSpool::rangeUs() const {
  std::lock_guard<std::mutex> lock(mu_);
  return range_;
}

int64_t PacketSpool::presentationCount() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int64_t>(offsets_.size());
}

std::vector<SpoolEvent> PacketSpool::TakeEvents() {
  std::lock_guard<std::mutex> lock(mu_);
  auto e = std::move(events_);
  events_.clear();
  return e;
}

Status PacketSpool::WriteHeader(int fd, const VideoTrackInfo& track) {
  auto& io = DefaultFileIo();
  int64_t off = 0;
  if (!WriteU32(io, fd, &off, kFileMagic) || !WriteU32(io, fd, &off, kVersion)) {
    return Status::Fail(kErrSpoolIo, "header magic");
  }
  if (!WriteU32(io, fd, &off, track.codec == VideoCodec::Hevc ? 1 : 0)) {
    return Status::Fail(kErrSpoolIo, "header codec");
  }
  if (!WriteU32(io, fd, &off, static_cast<uint32_t>(track.codedWidth)) ||
      !WriteU32(io, fd, &off, static_cast<uint32_t>(track.codedHeight))) {
    return Status::Fail(kErrSpoolIo, "header size");
  }
  const uint32_t clen = static_cast<uint32_t>(track.codecConfig.size());
  if (!WriteU32(io, fd, &off, clen)) {
    return Status::Fail(kErrSpoolIo, "header clen");
  }
  if (clen > 0) {
    if (io.Pwrite(fd, track.codecConfig.data(), clen, off) !=
        static_cast<int64_t>(clen)) {
      return Status::Fail(kErrSpoolIo, "header config");
    }
  }
  return Status::Ok();
}

Status PacketSpool::Open(const std::string& cacheDir, const std::string& uuid,
                         const VideoTrackInfo& track, const SpoolOptions& opts) {
  std::lock_guard<std::mutex> lock(mu_);
  opts_ = opts;
  track_ = track;
  uuid_ = uuid;
  if (opts.mode == SpoolRetentionMode::None) {
    active_ = false;
    return Status::Ok();
  }
  dir_ = opts.mode == SpoolRetentionMode::Path && !opts.directory.empty()
             ? opts.directory
             : cacheDir;
  if (dir_.empty()) {
    return Status::Fail(kErrSpoolIo, "spool dir");
  }
  std::error_code ec;
  std::filesystem::create_directories(dir_, ec);
  FsSpace space;
  auto st = DefaultFileIo().StatVfs(dir_.c_str(), &space);
  if (st.ok && space.availableBytes > 0 && space.availableBytes < 64 * 1024) {
    events_.push_back({"spoolError", "ENOSPC"});
    active_ = false;
    return Status::Ok();
  }
  Segment seg;
  char name[128];
  std::snprintf(name, sizeof(name), "vid_live_%s_s%04d.vbsp", uuid.c_str(), 0);
  seg.path = dir_ + "/" + name;
  seg.fd = DefaultFileIo().Open(seg.path.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0600);
  if (seg.fd < 0) {
    return Status::Fail(kErrSpoolIo, "open segment");
  }
  auto hs = WriteHeader(seg.fd, track);
  if (!hs.ok) {
    DefaultFileIo().Close(seg.fd);
    return hs;
  }
  struct stat sb {};
  if (::fstat(seg.fd, &sb) == 0) {
    seg.bytes = sb.st_size;
  }
  segments_.push_back(std::move(seg));
  active_ = true;
  return Status::Ok();
}

Status PacketSpool::WriteRecord(int fd, const EncodedPacket& pkt, int64_t* offset) {
  auto& io = DefaultFileIo();
  int64_t off = *offset;
  const uint32_t crc = Crc32(pkt.payload.data(), pkt.payload.size());
  if (!WriteU32(io, fd, &off, kRecMagic) ||
      !WriteU32(io, fd, &off, static_cast<uint32_t>(pkt.payload.size())) ||
      !WriteI64(io, fd, &off, pkt.ptsUs) || !WriteI64(io, fd, &off, pkt.dtsUs) ||
      !WriteU32(io, fd, &off, pkt.flags) || !WriteU32(io, fd, &off, crc)) {
    return Status::Fail(kErrSpoolIo, "record header");
  }
  if (!pkt.payload.empty()) {
    const int64_t n =
        io.Pwrite(fd, pkt.payload.data(), pkt.payload.size(), off);
    if (n != static_cast<int64_t>(pkt.payload.size())) {
      errno = ENOSPC;
      return Status::Fail(kErrSpoolIo, "ENOSPC");
    }
    off += n;
  }
  *offset = off;
  return Status::Ok();
}

Status PacketSpool::Enqueue(const EncodedPacket& pkt) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!active_) {
    return Status::Ok();
  }
  if (overflow_) {
    if ((pkt.flags & kSampleKey) == 0) {
      return Status::Ok();
    }
    overflow_ = false;
    EncodedPacket d = pkt;
    d.flags |= kSampleDiscontinuity;
    // fall through and write
    EncodedPacket toWrite = d;
    if (segments_.empty()) {
      return Status::Fail(kErrSpoolIo, "no segment");
    }
    auto& seg = segments_.back();
    int64_t off = seg.bytes;
    auto st = WriteRecord(seg.fd, toWrite, &off);
    if (!st.ok) {
      events_.push_back({"spoolError", st.errorMessage});
      active_ = false;
      return Status::Ok();
    }
    offsets_.push_back(seg.bytes);
    segmentOf_.push_back(static_cast<int>(segments_.size() - 1));
    seg.bytes = off;
    ++nextPres_;
    if (range_.endUs == 0 && range_.startUs == 0) {
      range_.startUs = toWrite.ptsUs;
    }
    range_.endUs = toWrite.ptsUs;
    return Status::Ok();
  }
  if (queue_.size() >= kMaxQueue) {
    overflow_ = true;
    events_.push_back({"spoolOverflow", "queue"});
    VIDEO_LOGW("video.spool overflow");
    return Status::Ok();
  }
  if (segments_.empty()) {
    return Status::Fail(kErrSpoolIo, "no segment");
  }
  auto& seg = segments_.back();
  const bool key = (pkt.flags & kSampleKey) != 0;
  if (key && seg.count > 0 &&
      (seg.bytes >= opts_.segmentMaxBytes ||
       (opts_.segmentSeconds > 0 && range_.endUs - range_.startUs >=
                                        opts_.segmentSeconds * 1000000))) {
    Segment nseg;
    char name[128];
    std::snprintf(name, sizeof(name), "vid_live_%s_s%04d.vbsp", uuid_.c_str(),
                  static_cast<int>(segments_.size()));
    nseg.path = dir_ + "/" + name;
    nseg.fd = DefaultFileIo().Open(nseg.path.c_str(), O_RDWR | O_CREAT | O_TRUNC,
                                   0600);
    if (nseg.fd < 0) {
      events_.push_back({"spoolError", "rotate"});
      active_ = false;
      return Status::Ok();
    }
    auto hs = WriteHeader(nseg.fd, track_);
    if (!hs.ok) {
      active_ = false;
      return Status::Ok();
    }
    struct stat sb {};
    if (::fstat(nseg.fd, &sb) == 0) {
      nseg.bytes = sb.st_size;
    }
    nseg.startPres = nextPres_;
    segments_.push_back(std::move(nseg));
  }
  auto& cur = segments_.back();
  int64_t off = cur.bytes;
  auto st = WriteRecord(cur.fd, pkt, &off);
  if (!st.ok) {
    events_.push_back({"spoolError", st.errorMessage});
    active_ = false;
    VIDEO_LOGE("video.spool write failed; ring-only");
    return Status::Ok();
  }
  offsets_.push_back(cur.bytes);
  segmentOf_.push_back(static_cast<int>(segments_.size() - 1));
  cur.bytes = off;
  cur.count++;
  if (nextPres_ == 0) {
    range_.startUs = pkt.ptsUs;
  }
  range_.endUs = pkt.ptsUs;
  ++nextPres_;
  return Status::Ok();
}

Status PacketSpool::Read(int64_t presentationIndex, EncodedPacket* out) {
  std::lock_guard<std::mutex> lock(mu_);
  if (out == nullptr || presentationIndex < 0 ||
      static_cast<size_t>(presentationIndex) >= offsets_.size()) {
    return Status::Fail(kErrFrameEvicted, "spool index");
  }
  const int si = segmentOf_[static_cast<size_t>(presentationIndex)];
  const int64_t off0 = offsets_[static_cast<size_t>(presentationIndex)];
  auto& io = DefaultFileIo();
  int fd = segments_[static_cast<size_t>(si)].fd;
  int64_t off = off0;
  uint32_t magic = 0, len = 0, flags = 0, crc = 0;
  int64_t pts = 0, dts = 0;
  if (!ReadU32(io, fd, &off, &magic) || magic != kRecMagic ||
      !ReadU32(io, fd, &off, &len) || !ReadI64(io, fd, &off, &pts) ||
      !ReadI64(io, fd, &off, &dts) || !ReadU32(io, fd, &off, &flags) ||
      !ReadU32(io, fd, &off, &crc)) {
    return Status::Fail(kErrFileCorrupt, "spool record");
  }
  EncodedPacket pkt;
  pkt.ptsUs = pts;
  pkt.dtsUs = dts;
  pkt.flags = flags;
  pkt.payload.resize(len);
  if (len > 0) {
    if (io.Pread(fd, pkt.payload.data(), len, off) != static_cast<int64_t>(len)) {
      return Status::Fail(kErrFileCorrupt, "spool payload");
    }
    if (Crc32(pkt.payload.data(), pkt.payload.size()) != crc) {
      return Status::Fail(kErrFileCorrupt, "spool crc");
    }
  }
  *out = std::move(pkt);
  return Status::Ok();
}

Status PacketSpool::Finish() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& s : segments_) {
    if (s.fd >= 0) {
      DefaultFileIo().Fsync(s.fd);
    }
  }
  return Status::Ok();
}

void PacketSpool::CloseAndDelete() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& s : segments_) {
    if (s.fd >= 0) {
      DefaultFileIo().Close(s.fd);
      s.fd = -1;
    }
    if (opts_.mode == SpoolRetentionMode::Session ||
        opts_.mode == SpoolRetentionMode::None) {
      DefaultFileIo().Unlink(s.path.c_str());
    }
  }
  segments_.clear();
  offsets_.clear();
  segmentOf_.clear();
  active_ = false;
}

bool PacketSpool::Recover() {
  std::lock_guard<std::mutex> lock(mu_);
  if (segments_.empty()) {
    return false;
  }
  auto& io = DefaultFileIo();
  auto& seg = segments_.back();
  int64_t off = 0;
  uint32_t magic = 0, ver = 0;
  if (!ReadU32(io, seg.fd, &off, &magic) || magic != kFileMagic ||
      !ReadU32(io, seg.fd, &off, &ver)) {
    return false;
  }
  uint32_t codec = 0, w = 0, h = 0, clen = 0;
  ReadU32(io, seg.fd, &off, &codec);
  ReadU32(io, seg.fd, &off, &w);
  ReadU32(io, seg.fd, &off, &h);
  ReadU32(io, seg.fd, &off, &clen);
  off += clen;
  int64_t lastGood = off;
  int64_t lastGop = off;
  while (true) {
    int64_t rec = off;
    uint32_t rm = 0, len = 0, flags = 0, crc = 0;
    int64_t pts = 0, dts = 0;
    if (!ReadU32(io, seg.fd, &off, &rm) || rm != kRecMagic ||
        !ReadU32(io, seg.fd, &off, &len) || !ReadI64(io, seg.fd, &off, &pts) ||
        !ReadI64(io, seg.fd, &off, &dts) || !ReadU32(io, seg.fd, &off, &flags) ||
        !ReadU32(io, seg.fd, &off, &crc)) {
      break;
    }
    std::vector<uint8_t> payload(len);
    if (len > 0) {
      if (io.Pread(seg.fd, payload.data(), len, off) != static_cast<int64_t>(len)) {
        break;
      }
      if (Crc32(payload.data(), payload.size()) != crc) {
        break;
      }
      off += len;
    }
    lastGood = off;
    if (flags & kSampleKey) {
      lastGop = rec;
    }
    (void)lastGop;
  }
  DefaultFileIo().Ftruncate(seg.fd, lastGood);
  seg.bytes = lastGood;
  VIDEO_LOGI("video.spool recover truncated to %lld",
             static_cast<long long>(lastGood));
  return true;
}

}  // namespace video
}  // namespace sherpa_onnx
