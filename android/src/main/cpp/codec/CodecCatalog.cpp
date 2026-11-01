#include "codec/CodecCatalog.h"

#include <algorithm>
#include <cctype>

#include "codec/CodecLog.h"

namespace sherpa_onnx {
namespace codec {
namespace {

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

bool CodecMatch(const std::string& have, const std::string& want) {
  if (have == "*" || want.empty() || want == "*") return true;
  return Lower(have) == Lower(want);
}

}  // namespace

CodecCatalog& CodecCatalog::Instance() {
  static CodecCatalog inst;
  return inst;
}

void CodecCatalog::Clear() {
  std::lock_guard<std::mutex> lock(mu_);
  providers_.clear();
}

void CodecCatalog::Register(Provider p) {
  std::lock_guard<std::mutex> lock(mu_);
  CODEC_LOGI(
      "codec.catalog media=%s dir=%s codec=%s provider=%s tier=%s origin=%s "
      "max=%dx%d inst=%d fps1080=%.0f avail=%d",
      MediaName(p.media), DirectionName(p.dir), p.codec.c_str(), p.name.c_str(),
      TierName(p.tier), OriginName(p.origin), p.caps.maxW, p.caps.maxH,
      p.caps.maxInstancesHint, p.caps.measuredFps1080Low,
      p.available ? 1 : 0);
  for (auto& existing : providers_) {
    if (existing.name == p.name && existing.media == p.media &&
        existing.dir == p.dir && CodecMatch(existing.codec, p.codec) &&
        existing.codec == p.codec) {
      existing = std::move(p);
      return;
    }
  }
  providers_.push_back(std::move(p));
}

void CodecCatalog::SetRank(const std::string& name, int rank) {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& p : providers_) {
    if (p.name == name) {
      p.rank = rank;
      CODEC_LOGI("codec.rank provider=%s rank=%d", name.c_str(), rank);
    }
  }
}

std::vector<const Provider*> CodecCatalog::Find(Media media, Direction dir,
                                               const std::string& codec) const {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<const Provider*> out;
  for (const auto& p : providers_) {
    if (p.media == media && p.dir == dir && CodecMatch(p.codec, codec)) {
      out.push_back(&p);
    }
  }
  return out;
}

std::vector<Provider> CodecCatalog::All() const {
  std::lock_guard<std::mutex> lock(mu_);
  return providers_;
}

void CodecCatalog::ReplaceAll(std::vector<Provider> providers) {
  std::lock_guard<std::mutex> lock(mu_);
  providers_ = std::move(providers);
}

}  // namespace codec
}  // namespace sherpa_onnx
