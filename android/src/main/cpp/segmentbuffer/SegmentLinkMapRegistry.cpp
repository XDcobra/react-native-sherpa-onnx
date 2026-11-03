#include "SegmentLinkMapRegistry.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <mutex>
#include <random>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

struct PaSegmentLinkMapStore {
  std::string linkMapId;
  std::optional<std::string> textBufferId;
  std::optional<std::string> audioBufferId;
  std::unordered_map<std::string, PaSegmentLink> links;
  std::unordered_multimap<std::string, std::string> textIndex;
  std::unordered_multimap<std::string, std::string> speechIndex;
  std::unordered_set<std::string> pairTypeIndex;
  std::vector<std::string> insertionOrder;
};

std::unordered_map<std::string, PaSegmentLinkMapStore> g_segment_link_maps;
std::mutex g_segment_link_maps_mutex;

std::string makeId(const char *prefix) {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  char buf[48];
  std::snprintf(buf, sizeof(buf), "%s_%016llx%016llx", prefix, (unsigned long long)dist(rng),
                (unsigned long long)dist(rng));
  return std::string(buf);
}

std::string pairTypeKey(const std::string &textSegmentId, const std::string &speechSegmentId,
                        PaSegmentLinkType linkType) {
  return textSegmentId + "::" + speechSegmentId + "::" + slm_link_type_raw(linkType);
}

void removeIndexEntries(std::unordered_multimap<std::string, std::string> &index,
                        const std::string &key, const std::string &linkId) {
  auto range = index.equal_range(key);
  for (auto it = range.first; it != range.second;) {
    if (it->second == linkId) {
      it = index.erase(it);
    } else {
      ++it;
    }
  }
}

}  // namespace

const char *slm_link_type_raw(PaSegmentLinkType type) {
  switch (type) {
    case PaSegmentLinkType::Alignment:
      return "alignment";
    case PaSegmentLinkType::Proportional:
      return "proportional";
    case PaSegmentLinkType::VadAssisted:
      return "vad_assisted";
    case PaSegmentLinkType::Sequential:
      return "sequential";
    case PaSegmentLinkType::TtsProduced:
      return "tts_produced";
    case PaSegmentLinkType::SttProduced:
      return "stt_produced";
    case PaSegmentLinkType::UserDefined:
      return "user_defined";
  }
  return "user_defined";
}

bool slm_parse_link_type(const std::string &raw, PaSegmentLinkType *out) {
  std::string n;
  n.reserve(raw.size());
  for (char c : raw) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
    n.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  }
  if (n == "alignment") {
    *out = PaSegmentLinkType::Alignment;
    return true;
  }
  if (n == "proportional") {
    *out = PaSegmentLinkType::Proportional;
    return true;
  }
  if (n == "vad_assisted") {
    *out = PaSegmentLinkType::VadAssisted;
    return true;
  }
  if (n == "sequential") {
    *out = PaSegmentLinkType::Sequential;
    return true;
  }
  if (n == "tts_produced") {
    *out = PaSegmentLinkType::TtsProduced;
    return true;
  }
  if (n == "stt_produced") {
    *out = PaSegmentLinkType::SttProduced;
    return true;
  }
  if (n == "user_defined") {
    *out = PaSegmentLinkType::UserDefined;
    return true;
  }
  return false;
}

bool slm_create(const std::string &textBufferIdOrEmpty, const std::string &audioBufferIdOrEmpty,
                std::string *linkMapIdOut, std::string *error) {
  PaSegmentLinkMapStore store;
  store.linkMapId = makeId("lnkmap");
  if (!textBufferIdOrEmpty.empty()) store.textBufferId = textBufferIdOrEmpty;
  if (!audioBufferIdOrEmpty.empty()) store.audioBufferId = audioBufferIdOrEmpty;
  const std::string id = store.linkMapId;
  {
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    g_segment_link_maps[id] = std::move(store);
  }
  if (linkMapIdOut) *linkMapIdOut = id;
  (void)error;
  return true;
}

bool slm_add_link(const std::string &linkMapId, const std::string &textSegmentId,
                  const std::string &speechSegmentId, const std::string &linkTypeRaw,
                  bool hasConfidence, float confidence, const std::string &metaJsonOrEmpty,
                  PaSegmentLink *out, std::string *error) {
  if (textSegmentId.empty() || speechSegmentId.empty()) {
    if (error) *error = "SEGMENT_LINK_INVALID: textSegmentId/speechSegmentId must be non-empty";
    return false;
  }
  PaSegmentLinkType type;
  if (!slm_parse_link_type(linkTypeRaw, &type)) {
    if (error) *error = "SEGMENT_LINK_INVALID: invalid linkType '" + linkTypeRaw + "'";
    return false;
  }
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return false;
  }
  auto &store = it->second;
  const std::string dup = pairTypeKey(textSegmentId, speechSegmentId, type);
  if (store.pairTypeIndex.count(dup)) {
    if (error)
      *error =
          "SEGMENT_LINK_INVALID: duplicate (textSegmentId, speechSegmentId, linkType) is not "
          "allowed";
    return false;
  }
  PaSegmentLink link;
  link.linkId = makeId("lnk");
  link.textSegmentId = textSegmentId;
  link.speechSegmentId = speechSegmentId;
  link.linkType = type;
  if (hasConfidence) link.confidence = confidence;
  if (!metaJsonOrEmpty.empty()) link.metaJson = metaJsonOrEmpty;
  store.links[link.linkId] = link;
  store.pairTypeIndex.insert(dup);
  store.textIndex.emplace(textSegmentId, link.linkId);
  store.speechIndex.emplace(speechSegmentId, link.linkId);
  store.insertionOrder.push_back(link.linkId);
  if (out) *out = link;
  return true;
}

bool slm_remove_link(const std::string &linkMapId, const std::string &linkId, std::string *error) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return false;
  }
  auto &store = it->second;
  auto lit = store.links.find(linkId);
  if (lit == store.links.end()) return true;
  const auto removed = lit->second;
  store.links.erase(lit);
  store.pairTypeIndex.erase(
      pairTypeKey(removed.textSegmentId, removed.speechSegmentId, removed.linkType));
  removeIndexEntries(store.textIndex, removed.textSegmentId, linkId);
  removeIndexEntries(store.speechIndex, removed.speechSegmentId, linkId);
  store.insertionOrder.erase(
      std::remove(store.insertionOrder.begin(), store.insertionOrder.end(), linkId),
      store.insertionOrder.end());
  return true;
}

std::vector<PaSegmentLink> slm_get_speech_for_text(const std::string &linkMapId,
                                                   const std::string &textSegmentId,
                                                   std::string *error) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return {};
  }
  std::vector<PaSegmentLink> out;
  auto range = it->second.textIndex.equal_range(textSegmentId);
  for (auto i = range.first; i != range.second; ++i) {
    auto lit = it->second.links.find(i->second);
    if (lit != it->second.links.end()) out.push_back(lit->second);
  }
  return out;
}

std::vector<PaSegmentLink> slm_get_text_for_speech(const std::string &linkMapId,
                                                   const std::string &speechSegmentId,
                                                   std::string *error) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return {};
  }
  std::vector<PaSegmentLink> out;
  auto range = it->second.speechIndex.equal_range(speechSegmentId);
  for (auto i = range.first; i != range.second; ++i) {
    auto lit = it->second.links.find(i->second);
    if (lit != it->second.links.end()) out.push_back(lit->second);
  }
  return out;
}

std::vector<PaSegmentLink> slm_get_all(const std::string &linkMapId, int startIndex, int maxCount,
                                       std::string *error) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return {};
  }
  if (maxCount <= 0 || startIndex < 0) return {};
  const auto &order = it->second.insertionOrder;
  if (startIndex >= static_cast<int>(order.size())) return {};
  int end = std::min(startIndex + maxCount, static_cast<int>(order.size()));
  std::vector<PaSegmentLink> out;
  for (int i = startIndex; i < end; ++i) {
    auto lit = it->second.links.find(order[i]);
    if (lit != it->second.links.end()) out.push_back(lit->second);
  }
  return out;
}

bool slm_get_info(const std::string &linkMapId, PaSegmentLinkMapInfo *out, std::string *error) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  auto it = g_segment_link_maps.find(linkMapId);
  if (it == g_segment_link_maps.end()) {
    if (error) *error = "SEGMENT_LINK_MAP_NOT_FOUND: link map not found: " + linkMapId;
    return false;
  }
  if (out) {
    out->linkMapId = linkMapId;
    out->linkCount = static_cast<int32_t>(it->second.links.size());
    out->textBufferId = it->second.textBufferId;
    out->audioBufferId = it->second.audioBufferId;
  }
  return true;
}

bool slm_release(const std::string &linkMapId) {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  return g_segment_link_maps.erase(linkMapId) > 0;
}

void slm_release_all_link_maps() {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  g_segment_link_maps.clear();
}
