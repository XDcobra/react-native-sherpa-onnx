#pragma once

#include "ReaderRegistry.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/**
 * Platform-neutral entry points for the TurboModule bridges (iOS category,
 * Android JNI). Results are JSON strings parsed by src/reader.
 */
bool BridgeCreateDocument(const std::string& textBufferId, const std::string& imageBufferId,
                          const std::string& documentKey, std::string* json, ReaderError* err);

/** App section from parallel arrays (types: paragraph | heading | separator). */
bool BridgeInsertSection(const std::string& documentId, const std::string& after,
                         const std::string& sectionId, const std::string& title,
                         const std::vector<std::string>& keys,
                         const std::vector<std::string>& types,
                         const std::vector<std::string>& texts, const std::vector<int>& levels,
                         std::string* json, ReaderError* err);

bool BridgeRemoveSection(const std::string& documentId, const std::string& sectionId,
                         std::string* json, ReaderError* err);

bool BridgeGetBlocks(const std::string& documentId, int start, int max, bool includeText,
                     std::string* json, ReaderError* err);

/**
 * Nearest block with `textHash` to `hintBlockId` (or the start), as
 * {"blockId","sectionId"} JSON, or "null" when there is no such block.
 */
bool BridgeFindBlockByHash(const std::string& documentId, const std::string& textHash,
                           const std::string& hintBlockId, std::string* json, ReaderError* err);

bool BridgeReleaseDocument(const std::string& documentId);

}  // namespace reader
}  // namespace sherpa_onnx
