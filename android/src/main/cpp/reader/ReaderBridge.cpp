#include "ReaderBridge.h"

#include "ReaderJson.h"

#include <algorithm>
#include "../image/ImageRegistry.h"
#include "../textbuffer/TextRegistry.h"

namespace sherpa_onnx {
namespace reader {

namespace {

bool SnapshotOrError(const std::string& id, std::shared_ptr<const ReaderSnapshot>* out,
                     ReaderError* err) {
  *out = ReaderRegistry::Instance().Snapshot(id);
  if (!*out && err) {
    err->code = kErrReaderNotFound;
    err->message = "Reader document not found: " + id;
  }
  return *out != nullptr;
}

}  // namespace

bool BridgeCreateDocument(const std::string& textBufferId, const std::string& imageBufferId,
                          const std::string& documentKey, std::string* json, ReaderError* err) {
  std::vector<std::string> hrefs;
  if (!imageBufferId.empty()) {
    auto& images = image::ImageRegistry::Instance();
    image::ImageBufferInfo info;
    if (!images.GetInfo(imageBufferId, info)) {
      err->code = kErrReaderInvalidArgument;
      err->message = "Image buffer not found: " + imageBufferId;
      return false;
    }
    hrefs.reserve(info.frameCount);
    for (int i = 0; i < info.frameCount; ++i) {
      image::ImageFrameInfo fi;
      hrefs.push_back(images.GetFrameInfo(imageBufferId, i, fi) ? fi.href : std::string());
    }
  }
  const std::string id = ReaderRegistry::Instance().Create(
      txt_get_offline_entry(textBufferId), imageBufferId, hrefs, documentKey, err);
  if (id.empty()) return false;
  *json = SnapshotSummaryJson(*ReaderRegistry::Instance().Snapshot(id));
  return true;
}

bool BridgeInsertSection(const std::string& documentId, const std::string& after,
                         const std::string& sectionId, const std::string& title,
                         const std::vector<std::string>& keys,
                         const std::vector<std::string>& types,
                         const std::vector<std::string>& texts, const std::vector<int>& levels,
                         std::string* json, ReaderError* err) {
  if (keys.size() != types.size() || keys.size() != texts.size() || keys.size() != levels.size()) {
    err->code = kErrReaderInvalidArgument;
    err->message = "Block arrays differ in length";
    return false;
  }
  ReaderAppSectionInput in;
  in.after = after;
  in.id = sectionId;
  in.title = title;
  for (size_t i = 0; i < keys.size(); ++i) {
    ReaderAppBlockInput b;
    b.key = keys[i];
    if (types[i] == "heading") {
      b.type = ReaderBlockType::Heading;
    } else if (types[i] == "separator") {
      b.type = ReaderBlockType::Separator;
    } else if (types[i] == "paragraph") {
      b.type = ReaderBlockType::Paragraph;
    } else {
      err->code = kErrReaderInvalidArgument;
      err->message = "Unsupported app block type: " + types[i];
      return false;
    }
    b.text = texts[i];
    b.level = levels[i];
    in.blocks.push_back(std::move(b));
  }
  if (!ReaderRegistry::Instance().InsertSection(documentId, in, err)) return false;
  *json = SnapshotSummaryJson(*ReaderRegistry::Instance().Snapshot(documentId));
  return true;
}

bool BridgeRemoveSection(const std::string& documentId, const std::string& sectionId,
                         std::string* json, ReaderError* err) {
  if (!ReaderRegistry::Instance().RemoveSection(documentId, sectionId, err)) return false;
  *json = SnapshotSummaryJson(*ReaderRegistry::Instance().Snapshot(documentId));
  return true;
}

bool BridgeGetBlocks(const std::string& documentId, int start, int max, bool includeText,
                     std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  *json = BlocksJson(*snap, start, max, includeText);
  return true;
}

bool BridgeFindBlockByHash(const std::string& documentId, const std::string& textHash,
                           const std::string& hintBlockId, std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  const int hint = std::max(0, snap->BlockIndex(hintBlockId));
  const int i = RemapBlockByHash(*snap, textHash, hint);
  if (i < 0) {
    *json = "null";
    return true;
  }
  *json = "{\"blockId\":" + JsonEscape(snap->blocks[i].id) +
          ",\"sectionId\":" + JsonEscape(snap->sections[snap->blocks[i].section].id) + "}";
  return true;
}

bool BridgeReleaseDocument(const std::string& documentId) {
  return ReaderRegistry::Instance().Release(documentId);
}

}  // namespace reader
}  // namespace sherpa_onnx
