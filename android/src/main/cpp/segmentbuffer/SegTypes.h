#pragma once

#include <string>
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
  bool populated = false;
};
