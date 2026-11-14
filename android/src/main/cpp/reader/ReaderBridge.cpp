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

bool BridgeCreatePagesDocument(const std::string& imageBufferId, const std::string& documentKey,
                               std::string* json, ReaderError* err) {
  auto& images = image::ImageRegistry::Instance();
  image::ImageBufferInfo info;
  if (imageBufferId.empty() || !images.GetInfo(imageBufferId, info) || info.frameCount <= 0) {
    err->code = kErrReaderInvalidArgument;
    err->message = "Image buffer not found or empty: " + imageBufferId;
    return false;
  }
  std::vector<ReaderRegistry::PageInput> pages(static_cast<size_t>(info.frameCount));
  for (int i = 0; i < info.frameCount; ++i) {
    image::ImageFrameInfo fi;
    if (images.GetFrameInfo(imageBufferId, i, fi)) {
      pages[static_cast<size_t>(i)].href = fi.href;
      pages[static_cast<size_t>(i)].pageNumber = fi.pageNumber;
    }
  }
  const std::string id =
      ReaderRegistry::Instance().CreatePages(imageBufferId, pages, documentKey, err);
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

bool BridgeMapTextRanges(const std::string& documentId, const std::vector<int>& starts,
                         const std::vector<int>& ends, const std::string& sliceBufferId,
                         std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  if (starts.size() != ends.size()) {
    if (err) {
      err->code = kErrReaderInvalidArgument;
      err->message = "starts and ends differ in length";
    }
    return false;
  }
  if (!sliceBufferId.empty()) {
    auto slice = ReaderRegistry::Instance().Slice(sliceBufferId);
    if (!slice || slice->documentId != documentId) {
      if (err) {
        err->code = kErrReaderInvalidArgument;
        err->message = "Not a text slice of this document: " + sliceBufferId;
      }
      return false;
    }
    *json = SliceRangesJson(*snap, *slice, starts, ends);
    return true;
  }
  *json = TextRangesJson(*snap, starts, ends);
  return true;
}

bool BridgeAttachPageText(const std::string& documentId, const std::string& textBufferId,
                          std::string* json, ReaderError* err) {
  if (!ReaderRegistry::Instance().AttachPageText(documentId, txt_get_offline_entry(textBufferId),
                                                 nullptr, err)) {
    return false;
  }
  *json = SnapshotSummaryJson(*ReaderRegistry::Instance().Snapshot(documentId));
  return true;
}

bool BridgeGetPages(const std::string& documentId, std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  *json = PagesJson(*snap);
  return true;
}

bool BridgeCreateTextSlice(const std::string& documentId, const std::string& fromBlockId,
                           int fromOffset, const std::string& toBlockId, int maxLength,
                           std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  const int from = snap->BlockIndex(fromBlockId);
  const int to = toBlockId.empty() ? -1 : snap->BlockIndex(toBlockId);
  if (from < 0 || (!toBlockId.empty() && to < 0)) {
    err->code = kErrReaderInvalidArgument;
    err->message = "Unknown block: " + (from < 0 ? fromBlockId : toBlockId);
    return false;
  }
  auto slice = std::make_shared<ReaderTextSlice>();
  if (!BuildTextSlice(*snap, from, std::max(0, fromOffset), to, maxLength, slice.get())) {
    err->code = kErrReaderInvalidArgument;
    err->message = "No text from " + fromBlockId;
    return false;
  }
  std::string bufferId;
  std::string error;
  if (!txt_create_offline_from_text(slice->text, snap->language, "", "", &bufferId, &error)) {
    err->code = kErrReaderInvalidArgument;
    err->message = error.empty() ? "Failed to create the slice's text buffer" : error;
    return false;
  }
  *json = SliceJson(*snap, *slice, bufferId);
  ReaderRegistry::Instance().AddSlice(bufferId, std::move(slice));
  return true;
}

bool BridgeEncodeRecognition(const std::string& documentId, const std::string& modelId,
                             std::vector<uint8_t>* bytes, int* pages, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  const SidecarContent content = CollectRecognition(*snap, modelId);
  if (pages) *pages = static_cast<int>(content.pages.size());
  *bytes = EncodeSidecar(content);
  return true;
}

bool BridgeLoadRecognition(const std::string& documentId, const uint8_t* data, size_t size,
                           const std::string& modelId, std::string* json, ReaderError* err) {
  SidecarContent content;
  std::string error;
  if (!DecodeSidecar(data, size, &content, &error)) {
    err->code = kErrReaderSidecarInvalid;
    err->message = error;
    return false;
  }
  if (!ReaderRegistry::Instance().AttachRecognition(documentId, std::move(content), modelId,
                                                    nullptr, err)) {
    return false;
  }
  *json = SnapshotSummaryJson(*ReaderRegistry::Instance().Snapshot(documentId));
  return true;
}

bool BridgeGetToc(const std::string& documentId, std::string* json, ReaderError* err) {
  std::shared_ptr<const ReaderSnapshot> snap;
  if (!SnapshotOrError(documentId, &snap, err)) return false;
  *json = TocJson(*snap);
  return true;
}

bool BridgeReleaseDocument(const std::string& documentId) {
  return ReaderRegistry::Instance().Release(documentId);
}

}  // namespace reader
}  // namespace sherpa_onnx
