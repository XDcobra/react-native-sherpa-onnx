#pragma once

#ifdef __cplusplus
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#endif
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct SegRecord {
  std::string id;
  std::string kind;
  std::string sourceAudioBufferId;
  int startSample = 0;
  int endSample = 0;
  int sampleRate = 0;
  int durationMs = 0;
  bool hasConfidence = false;
  double confidence = 0.0;
  std::string payloadJson;
};

struct SegOfflineEntry {
  std::string bufferId;
  std::vector<SegRecord> segments;
  std::string sourceAudioBufferId;
};

struct SegLiveEntry;

extern std::unordered_map<std::string, std::shared_ptr<SegOfflineEntry>> g_seg_offline;
extern std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> g_seg_live;
extern std::mutex g_seg_mutex;

void seg_release_all_entries();
#endif
