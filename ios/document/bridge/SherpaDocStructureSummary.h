#pragma once

#import <Foundation/Foundation.h>

#include "TxtStructure.h"

#include <string>

/**
 * Reading structure summary for JS (format, version, blockCount, sections,
 * metadata); blocks stay native. Shared by the document and PDF bridges;
 * mirrors the Android NewStructureSummary.
 */
static inline NSDictionary *SherpaDocStructureSummary(const TxtStructure &st) {
  auto ns = [](const std::string &s) -> NSString * {
    return [NSString stringWithUTF8String:s.c_str()] ?: @"";
  };
  NSMutableArray *sections = [NSMutableArray arrayWithCapacity:st.sections.size()];
  for (const auto &sec : st.sections) {
    NSMutableDictionary *m = [@{
      @"sectionIndex" : @(sec.sectionIndex),
      @"href" : ns(sec.href),
      @"kind" : ns(sec.kind),
      @"titleSource" : ns(sec.titleSource),
      @"utf16Start" : @(sec.utf16Start),
      @"utf16End" : @(sec.utf16End),
      @"firstBlock" : @(sec.firstBlock),
      @"blockCount" : @(sec.blockCount),
    } mutableCopy];
    if (!sec.title.empty()) m[@"title"] = ns(sec.title);
    if (!sec.label.empty()) m[@"label"] = ns(sec.label);
    [sections addObject:m];
  }
  NSMutableDictionary *metadata = [NSMutableDictionary dictionary];
  if (!st.title.empty()) metadata[@"title"] = ns(st.title);
  if (!st.creator.empty()) metadata[@"creator"] = ns(st.creator);
  if (!st.language.empty()) metadata[@"language"] = ns(st.language);
  return @{
    @"format" : ns(st.format),
    @"version" : @(st.version),
    @"blockCount" : @((NSInteger)st.blocks.size()),
    @"sections" : sections,
    @"metadata" : metadata,
  };
}
