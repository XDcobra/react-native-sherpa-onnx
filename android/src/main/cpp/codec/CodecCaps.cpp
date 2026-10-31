#include "codec/CodecCaps.h"

#include <algorithm>
#include <thread>

#include "codec/CodecLog.h"

namespace sherpa_onnx {
namespace codec {
namespace {

int HardwareConcurrency() {
  unsigned n = std::thread::hardware_concurrency();
  if (n == 0) n = 4;
  return static_cast<int>(n);
}

}  // namespace

RamClass ClassifyRam(int64_t totalBytes) {
  const int64_t gb = 1024LL * 1024LL * 1024LL;
  if (totalBytes <= 3 * gb) return RamClass::Low;
  if (totalBytes <= 6 * gb) return RamClass::Mid;
  if (totalBytes <= 12 * gb) return RamClass::High;
  return RamClass::VeryHigh;
}

int TableLimit(RamClass ram, ResourceClass cls) {
  // RAM × resource table from the plan §1.4
  switch (cls) {
    case ResourceClass::HwVideoDecodeCpu:
      return ram == RamClass::High || ram == RamClass::VeryHigh ? 2 : 1;
    case ResourceClass::HwVideoDecodeDisplay:
      return 1;
    case ResourceClass::HwVideoEncode:
      return ram == RamClass::VeryHigh ? 2 : 1;
    case ResourceClass::SwVideoDecode:
      return ram == RamClass::High || ram == RamClass::VeryHigh ? 2 : 1;
    case ResourceClass::SwVideoEncode:
      return 1;
    case ResourceClass::PlatformImageDecode:
      return ram == RamClass::Low ? 1 : 2;
  }
  return 1;
}

int ClampBudget(int n) {
  if (n < 1) return 1;
  if (n > 4) return 4;
  return n;
}

int SwDecodeThreadCap() { return std::max(1, HardwareConcurrency() / 4); }

int FfmpegThreadCount() {
  return std::max(1, std::min(4, HardwareConcurrency() / 2));
}

bool StreamFits(const ProviderCaps& caps, const StreamCaps& stream,
                std::string* why) {
  auto fail = [&](const char* msg) {
    if (why) *why = msg;
    return false;
  };
  if (caps.maxW > 0 && stream.width > 0 && stream.width > caps.maxW) {
    return fail("max-width");
  }
  if (caps.maxH > 0 && stream.height > 0 && stream.height > caps.maxH) {
    return fail("max-height");
  }
  if (caps.minW > 0 && stream.width > 0 && stream.width < caps.minW) {
    return fail("min-width");
  }
  if (caps.minH > 0 && stream.height > 0 && stream.height < caps.minH) {
    return fail("min-height");
  }
  if (caps.widthAlign > 1 && stream.width > 0 &&
      (stream.width % caps.widthAlign) != 0) {
    return fail("width-align");
  }
  if (caps.heightAlign > 1 && stream.height > 0 &&
      (stream.height % caps.heightAlign) != 0) {
    return fail("height-align");
  }
  if (caps.maxBlocks > 0 && caps.blockW > 0 && caps.blockH > 0 &&
      stream.width > 0 && stream.height > 0) {
    const int64_t bw = (stream.width + static_cast<int>(caps.blockW) - 1) /
                       caps.blockW;
    const int64_t bh = (stream.height + static_cast<int>(caps.blockH) - 1) /
                       caps.blockH;
    if (bw * bh > caps.maxBlocks) {
      return fail("block-count");
    }
  }
  if (!caps.profiles.empty() && stream.profile >= 0) {
    bool ok = false;
    for (int p : caps.profiles) {
      if (p == stream.profile) ok = true;
    }
    if (!ok) return fail("profile");
  }
  if (stream.bitDepth > 0 && stream.bitDepth > caps.maxBitDepth) {
    return fail("bit-depth");
  }
  if (stream.bitrate > 0) {
    CODEC_LOGI("codec.caps bitrate=%lld logged-only",
               static_cast<long long>(stream.bitrate));
  }
  if (why) why->clear();
  return true;
}

CodecCaps& CodecCaps::Instance() {
  static CodecCaps inst;
  return inst;
}

int CodecCaps::Index(ResourceClass cls) {
  return static_cast<int>(cls);
}

void CodecCaps::Init(int64_t totalRamBytes) {
  std::lock_guard<std::mutex> lock(mu_);
  ram_ = ClassifyRam(totalRamBytes);
  for (int i = 0; i < 6; ++i) {
    table_[static_cast<size_t>(i)] =
        TableLimit(ram_, static_cast<ResourceClass>(i));
    hints_[static_cast<size_t>(i)] = 0;
    overridden_[static_cast<size_t>(i)] = false;
  }
  RecomputeLocked();
  inited_ = true;
  CODEC_LOGI(
      "codec.caps init ram=%s swThreads=%d ffmpegThreads=%d "
      "hwCpu=%d hwDisp=%d hwEnc=%d swDec=%d swEnc=%d img=%d",
      RamClassName(ram_), SwDecodeThreadCap(), FfmpegThreadCount(),
      limits_[0], limits_[1], limits_[2], limits_[3], limits_[4], limits_[5]);
}

void CodecCaps::ApplyInstanceHints(const std::vector<Provider>& providers) {
  std::lock_guard<std::mutex> lock(mu_);
  hints_.fill(0);
  for (const auto& p : providers) {
    if (p.caps.maxInstancesHint <= 0 || p.caps.maxInstancesHint > 16) {
      continue;
    }
    if (p.media != Media::Video) continue;
    ResourceClass cls;
    if (p.dir == Direction::Encode) {
      cls = p.tier == Tier::Software ? ResourceClass::SwVideoEncode
                                     : ResourceClass::HwVideoEncode;
    } else {
      cls = p.tier == Tier::Software ? ResourceClass::SwVideoDecode
                                     : ResourceClass::HwVideoDecodeCpu;
    }
    const int i = Index(cls);
    if (hints_[static_cast<size_t>(i)] == 0 ||
        p.caps.maxInstancesHint < hints_[static_cast<size_t>(i)]) {
      hints_[static_cast<size_t>(i)] = p.caps.maxInstancesHint;
    }
  }
  RecomputeLocked();
}

void CodecCaps::RecomputeLocked() {
  for (int i = 0; i < 6; ++i) {
    if (overridden_[static_cast<size_t>(i)]) continue;
    int n = table_[static_cast<size_t>(i)];
    const int hint = hints_[static_cast<size_t>(i)];
    if (hint > 0 && hint <= 16) {
      n = std::min(n, hint);
    }
    if (static_cast<ResourceClass>(i) == ResourceClass::SwVideoDecode) {
      n = std::min(n, SwDecodeThreadCap());
    }
    limits_[static_cast<size_t>(i)] = ClampBudget(n);
  }
}

Status CodecCaps::SetOverride(ResourceClass cls, int n) {
  if (n < 1 || n > 4) {
    return Status::Fail(kErrCodecInvalidArgument, "budget must be 1..4");
  }
  std::lock_guard<std::mutex> lock(mu_);
  const int i = Index(cls);
  limits_[static_cast<size_t>(i)] = n;
  overridden_[static_cast<size_t>(i)] = true;
  return Status::Ok();
}

void CodecCaps::ClearOverrides() {
  std::lock_guard<std::mutex> lock(mu_);
  overridden_.fill(false);
  RecomputeLocked();
}

RamClass CodecCaps::ramClass() const {
  std::lock_guard<std::mutex> lock(mu_);
  return ram_;
}

int CodecCaps::Limit(ResourceClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return limits_[static_cast<size_t>(Index(cls))];
}

const char* CodecCaps::Source(ResourceClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return overridden_[static_cast<size_t>(Index(cls))] ? "override" : "auto";
}

void CodecCaps::Snapshot(std::array<SlotSnap, 6>* out) const {
  if (!out) return;
  std::lock_guard<std::mutex> lock(mu_);
  for (int i = 0; i < 6; ++i) {
    (*out)[static_cast<size_t>(i)].resource = static_cast<ResourceClass>(i);
    (*out)[static_cast<size_t>(i)].max = limits_[static_cast<size_t>(i)];
    (*out)[static_cast<size_t>(i)].source =
        overridden_[static_cast<size_t>(i)] ? "override" : "auto";
  }
}

void CodecCaps::ResetForTest() {
  std::lock_guard<std::mutex> lock(mu_);
  ram_ = RamClass::Mid;
  table_.fill(1);
  hints_.fill(0);
  limits_.fill(1);
  overridden_.fill(false);
  inited_ = false;
}

}  // namespace codec
}  // namespace sherpa_onnx
