#include "demux/BitstreamUtil.h"

#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace {

bool ReadU16(const uint8_t* p, size_t n, size_t off, uint16_t* out) {
  if (off + 2 > n) {
    return false;
  }
  *out = static_cast<uint16_t>((p[off] << 8) | p[off + 1]);
  return true;
}

Status LengthPrefixedToAnnexB(const uint8_t* data, size_t size, int nalLenSize,
                              std::vector<uint8_t>* out) {
  if (out == nullptr || nalLenSize < 1 || nalLenSize > 4) {
    return Status::Fail(kErrInvalidArgument, "nal length size");
  }
  out->clear();
  size_t i = 0;
  while (i + static_cast<size_t>(nalLenSize) <= size) {
    uint32_t nalSize = 0;
    for (int b = 0; b < nalLenSize; ++b) {
      nalSize = (nalSize << 8) | data[i + static_cast<size_t>(b)];
    }
    i += static_cast<size_t>(nalLenSize);
    if (i + nalSize > size) {
      return Status::Fail(kErrFileCorrupt, "truncated AVCC NAL");
    }
    out->insert(out->end(), {0, 0, 0, 1});
    out->insert(out->end(), data + i, data + i + nalSize);
    i += nalSize;
  }
  return Status::Ok();
}

const uint8_t* FindStart(const uint8_t* data, size_t size, size_t from,
                         size_t* scSize) {
  for (size_t i = from; i + 3 < size; ++i) {
    if (data[i] == 0 && data[i + 1] == 0) {
      if (data[i + 2] == 1) {
        *scSize = 3;
        return data + i;
      }
      if (i + 3 < size && data[i + 2] == 0 && data[i + 3] == 1) {
        *scSize = 4;
        return data + i;
      }
    }
  }
  return nullptr;
}

}  // namespace

bool BitstreamUtil::LooksAnnexB(const uint8_t* data, size_t size) {
  if (size < 4) {
    return false;
  }
  return (data[0] == 0 && data[1] == 0 && data[2] == 1) ||
         (data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1);
}

bool BitstreamUtil::LooksAvcc(const uint8_t* data, size_t size) {
  if (size < 5 || LooksAnnexB(data, size)) {
    return false;
  }
  uint32_t n = (static_cast<uint32_t>(data[0]) << 24) |
               (static_cast<uint32_t>(data[1]) << 16) |
               (static_cast<uint32_t>(data[2]) << 8) | data[3];
  return n > 0 && n + 4 <= size;
}

Status BitstreamUtil::AvccToAnnexB(const uint8_t* data, size_t size,
                                   std::vector<uint8_t>* out) {
  return LengthPrefixedToAnnexB(data, size, 4, out);
}

Status BitstreamUtil::AnnexBToAvcc(const uint8_t* data, size_t size,
                                   std::vector<uint8_t>* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "AnnexBToAvcc");
  }
  out->clear();
  size_t sc = 0;
  const uint8_t* start = FindStart(data, size, 0, &sc);
  if (start == nullptr) {
    return Status::Fail(kErrFileCorrupt, "no Annex-B start code");
  }
  while (start != nullptr) {
    const size_t nalOff = static_cast<size_t>(start - data) + sc;
    size_t nextSc = 0;
    const uint8_t* next = FindStart(data, size, nalOff, &nextSc);
    const size_t nalEnd = next ? static_cast<size_t>(next - data) : size;
    const uint32_t nalSize = static_cast<uint32_t>(nalEnd - nalOff);
    out->push_back(static_cast<uint8_t>(nalSize >> 24));
    out->push_back(static_cast<uint8_t>(nalSize >> 16));
    out->push_back(static_cast<uint8_t>(nalSize >> 8));
    out->push_back(static_cast<uint8_t>(nalSize));
    out->insert(out->end(), data + nalOff, data + nalEnd);
    start = next;
    sc = nextSc;
  }
  return Status::Ok();
}

NalInfo BitstreamUtil::InspectH264AccessUnit(const uint8_t* data, size_t size,
                                             bool avcc) {
  NalInfo info;
  auto consider = [&](const uint8_t* nal, size_t n) {
    if (n == 0) {
      return;
    }
    const uint8_t hdr = nal[0];
    const uint8_t nalRef = (hdr >> 5) & 0x3;
    const uint8_t type = hdr & 0x1f;
    info.nalType = type;
    if (type == 5) {
      info.isKey = true;
    }
    if (nalRef == 0 && type != 6 && type != 9) {
      info.isNonRef = true;
    }
  };
  if (avcc) {
    size_t i = 0;
    while (i + 4 <= size) {
      uint32_t n = (static_cast<uint32_t>(data[i]) << 24) |
                   (static_cast<uint32_t>(data[i + 1]) << 16) |
                   (static_cast<uint32_t>(data[i + 2]) << 8) | data[i + 3];
      i += 4;
      if (i + n > size) {
        break;
      }
      consider(data + i, n);
      i += n;
    }
  } else {
    size_t sc = 0;
    const uint8_t* start = FindStart(data, size, 0, &sc);
    while (start) {
      const size_t nalOff = static_cast<size_t>(start - data) + sc;
      size_t nsc = 0;
      const uint8_t* next = FindStart(data, size, nalOff, &nsc);
      const size_t nalEnd = next ? static_cast<size_t>(next - data) : size;
      consider(data + nalOff, nalEnd - nalOff);
      start = next;
      sc = nsc;
    }
  }
  return info;
}

NalInfo BitstreamUtil::InspectHevcAccessUnit(const uint8_t* data, size_t size,
                                             bool avcc) {
  NalInfo info;
  auto consider = [&](const uint8_t* nal, size_t n) {
    if (n < 2) {
      return;
    }
    const uint8_t type = (nal[0] >> 1) & 0x3f;
    info.nalType = type;
    // IRAP: 16–21 (BLA/IDR/CRA)
    if (type >= 16 && type <= 21) {
      info.isKey = true;
    }
    // TRAIL_N / TSA_N / STSA_N / RADL_N / RASL_N even types 0,2,4,6,8
    if (type <= 9 && (type % 2) == 0) {
      info.isNonRef = true;
    }
  };
  if (avcc) {
    size_t i = 0;
    while (i + 4 <= size) {
      uint32_t n = (static_cast<uint32_t>(data[i]) << 24) |
                   (static_cast<uint32_t>(data[i + 1]) << 16) |
                   (static_cast<uint32_t>(data[i + 2]) << 8) | data[i + 3];
      i += 4;
      if (i + n > size) {
        break;
      }
      consider(data + i, n);
      i += n;
    }
  } else {
    size_t sc = 0;
    const uint8_t* start = FindStart(data, size, 0, &sc);
    while (start) {
      const size_t nalOff = static_cast<size_t>(start - data) + sc;
      size_t nsc = 0;
      const uint8_t* next = FindStart(data, size, nalOff, &nsc);
      const size_t nalEnd = next ? static_cast<size_t>(next - data) : size;
      consider(data + nalOff, nalEnd - nalOff);
      start = next;
      sc = nsc;
    }
  }
  return info;
}

Status BitstreamUtil::ExtractH264ParameterSets(
    const std::vector<uint8_t>& avcc, std::vector<std::vector<uint8_t>>* sps,
    std::vector<std::vector<uint8_t>>* pps) {
  if (sps == nullptr || pps == nullptr) {
    return Status::Fail(kErrInvalidArgument, "ExtractH264ParameterSets");
  }
  sps->clear();
  pps->clear();
  if (avcc.size() < 7 || avcc[0] != 1) {
    return Status::Fail(kErrFileCorrupt, "avcC");
  }
  size_t i = 5;
  const int naluLen = (avcc[4] & 3) + 1;
  (void)naluLen;
  const int numSps = avcc[i++] & 0x1f;
  for (int s = 0; s < numSps; ++s) {
    uint16_t len = 0;
    if (!ReadU16(avcc.data(), avcc.size(), i, &len)) {
      return Status::Fail(kErrFileCorrupt, "avcC sps len");
    }
    i += 2;
    if (i + len > avcc.size()) {
      return Status::Fail(kErrFileCorrupt, "avcC sps");
    }
    sps->emplace_back(avcc.begin() + static_cast<std::ptrdiff_t>(i),
                      avcc.begin() + static_cast<std::ptrdiff_t>(i + len));
    i += len;
  }
  if (i >= avcc.size()) {
    return Status::Ok();
  }
  const int numPps = avcc[i++];
  for (int p = 0; p < numPps; ++p) {
    uint16_t len = 0;
    if (!ReadU16(avcc.data(), avcc.size(), i, &len)) {
      return Status::Fail(kErrFileCorrupt, "avcC pps len");
    }
    i += 2;
    if (i + len > avcc.size()) {
      return Status::Fail(kErrFileCorrupt, "avcC pps");
    }
    pps->emplace_back(avcc.begin() + static_cast<std::ptrdiff_t>(i),
                      avcc.begin() + static_cast<std::ptrdiff_t>(i + len));
    i += len;
  }
  return Status::Ok();
}

Status BitstreamUtil::ExtractHevcParameterSets(
    const std::vector<uint8_t>& hvcc, std::vector<std::vector<uint8_t>>* vps,
    std::vector<std::vector<uint8_t>>* sps,
    std::vector<std::vector<uint8_t>>* pps) {
  if (vps == nullptr || sps == nullptr || pps == nullptr) {
    return Status::Fail(kErrInvalidArgument, "ExtractHevcParameterSets");
  }
  vps->clear();
  sps->clear();
  pps->clear();
  if (hvcc.size() < 23 || hvcc[0] != 1) {
    return Status::Fail(kErrFileCorrupt, "hvcC");
  }
  size_t i = 22;
  const int numArrays = hvcc[i++];
  for (int a = 0; a < numArrays; ++a) {
    if (i >= hvcc.size()) {
      return Status::Fail(kErrFileCorrupt, "hvcC array");
    }
    const uint8_t nalType = hvcc[i++] & 0x3f;
    uint16_t numNals = 0;
    if (!ReadU16(hvcc.data(), hvcc.size(), i, &numNals)) {
      return Status::Fail(kErrFileCorrupt, "hvcC numNals");
    }
    i += 2;
    for (uint16_t n = 0; n < numNals; ++n) {
      uint16_t len = 0;
      if (!ReadU16(hvcc.data(), hvcc.size(), i, &len)) {
        return Status::Fail(kErrFileCorrupt, "hvcC nal len");
      }
      i += 2;
      if (i + len > hvcc.size()) {
        return Status::Fail(kErrFileCorrupt, "hvcC nal");
      }
      std::vector<uint8_t> nal(hvcc.begin() + static_cast<std::ptrdiff_t>(i),
                               hvcc.begin() + static_cast<std::ptrdiff_t>(i + len));
      i += len;
      if (nalType == 32) {
        vps->push_back(std::move(nal));
      } else if (nalType == 33) {
        sps->push_back(std::move(nal));
      } else if (nalType == 34) {
        pps->push_back(std::move(nal));
      }
    }
  }
  return Status::Ok();
}

namespace {

void AppendStartCoded(const std::vector<uint8_t>& nal, std::vector<uint8_t>* out) {
  static const uint8_t kSc[] = {0, 0, 0, 1};
  out->insert(out->end(), kSc, kSc + 4);
  out->insert(out->end(), nal.begin(), nal.end());
}

}  // namespace

Status BitstreamUtil::MakeAnnexBCsd(VideoCodec codec,
                                    const std::vector<uint8_t>& config,
                                    AnnexBCsd* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "MakeAnnexBCsd");
  }
  out->csd0.clear();
  out->csd1.clear();
  if (config.empty()) {
    return Status::Fail(kErrInvalidArgument, "empty codec config");
  }
  if (codec == VideoCodec::Hevc) {
    std::vector<std::vector<uint8_t>> vps, sps, pps;
    auto st = ExtractHevcParameterSets(config, &vps, &sps, &pps);
    if (!st.ok || (vps.empty() && sps.empty())) {
      out->csd0 = config;
      return Status::Ok();
    }
    for (const auto& n : vps) AppendStartCoded(n, &out->csd0);
    for (const auto& n : sps) AppendStartCoded(n, &out->csd0);
    for (const auto& n : pps) AppendStartCoded(n, &out->csd0);
    return Status::Ok();
  }
  std::vector<std::vector<uint8_t>> sps, pps;
  auto st = ExtractH264ParameterSets(config, &sps, &pps);
  if (!st.ok || sps.empty()) {
    out->csd0 = config;
    return Status::Ok();
  }
  AppendStartCoded(sps[0], &out->csd0);
  if (!pps.empty()) {
    AppendStartCoded(pps[0], &out->csd1);
  }
  return Status::Ok();
}

}  // namespace video
}  // namespace sherpa_onnx
