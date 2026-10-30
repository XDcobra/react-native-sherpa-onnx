#include "OcrElementKind.h"

namespace sherpa_onnx {
namespace ocr {
namespace {

OcrElementKindParse Ok(OcrElementKind kind, std::optional<int> level = {},
                       std::optional<bool> checked = {}) {
  OcrElementKindParse out;
  out.ok = true;
  out.kind = kind;
  out.level = level;
  out.checked = checked;
  return out;
}

OcrElementKindParse Unknown(const std::string& msg) {
  OcrElementKindParse out;
  out.error_code = kOcrErrParseUnknownKind;
  out.error_message = msg;
  return out;
}

}  // namespace

OcrElementKindParse FromDocTagsTag(std::string_view tag) {
  if (tag == "text" || tag == "paragraph") return Ok(OcrElementKind::kText);
  if (tag == "title") return Ok(OcrElementKind::kTitle);
  if (tag == "list_item") return Ok(OcrElementKind::kListItem);
  if (tag == "caption") return Ok(OcrElementKind::kCaption);
  if (tag == "footnote") return Ok(OcrElementKind::kFootnote);
  if (tag == "page_header") return Ok(OcrElementKind::kPageHeader);
  if (tag == "page_footer") return Ok(OcrElementKind::kPageFooter);
  if (tag == "picture") return Ok(OcrElementKind::kPicture);
  if (tag == "formula") return Ok(OcrElementKind::kFormula);
  if (tag == "code") return Ok(OcrElementKind::kCode);
  if (tag == "otsl" || tag == "table") return Ok(OcrElementKind::kTable);
  if (tag == "chart") return Ok(OcrElementKind::kChart);
  if (tag == "form") return Ok(OcrElementKind::kForm);
  if (tag == "key_value_region") return Ok(OcrElementKind::kKeyValue);
  if (tag == "references") return Ok(OcrElementKind::kBibliography);
  if (tag == "checkbox_selected" || tag == "checkbox_unselected") {
    return Ok(OcrElementKind::kCheckbox, {}, tag == "checkbox_selected");
  }
  constexpr char kPrefix[] = "section_header_level_";
  constexpr size_t kPrefixLen = sizeof(kPrefix) - 1;
  if (tag.size() == kPrefixLen + 1 && tag.substr(0, kPrefixLen) == kPrefix) {
    const char d = tag.back();
    if (d >= '1' && d <= '6') {
      return Ok(OcrElementKind::kSectionHeader, d - '0');
    }
  }
  return Unknown("unknown DocTags tag: " + std::string(tag));
}

OcrElementKindParse FromNemotronClass(std::string_view class_token) {
  std::string_view name = class_token;
  if (name.size() >= 7 && name.substr(0, 7) == "<class_") {
    name.remove_prefix(7);
    if (!name.empty() && name.back() == '>') name.remove_suffix(1);
  }
  if (name == "Text") return Ok(OcrElementKind::kText);
  if (name == "Title") return Ok(OcrElementKind::kTitle);
  if (name == "Section-header") return Ok(OcrElementKind::kSectionHeader);
  if (name == "List-item") return Ok(OcrElementKind::kListItem);
  if (name == "Caption") return Ok(OcrElementKind::kCaption);
  if (name == "Footnote") return Ok(OcrElementKind::kFootnote);
  if (name == "Page-header") return Ok(OcrElementKind::kPageHeader);
  if (name == "Page-footer") return Ok(OcrElementKind::kPageFooter);
  if (name == "Picture") return Ok(OcrElementKind::kPicture);
  if (name == "Formula") return Ok(OcrElementKind::kFormula);
  if (name == "Code") return Ok(OcrElementKind::kCode);
  if (name == "Table") return Ok(OcrElementKind::kTable);
  if (name == "Chart") return Ok(OcrElementKind::kChart);
  if (name == "TOC") return Ok(OcrElementKind::kToc);
  if (name == "Bibliography") return Ok(OcrElementKind::kBibliography);
  return Unknown("unknown Nemotron class: " + std::string(class_token));
}

const char* OcrElementKindName(OcrElementKind kind) {
  switch (kind) {
    case OcrElementKind::kText:
      return "text";
    case OcrElementKind::kTitle:
      return "title";
    case OcrElementKind::kSectionHeader:
      return "sectionHeader";
    case OcrElementKind::kListItem:
      return "listItem";
    case OcrElementKind::kCaption:
      return "caption";
    case OcrElementKind::kFootnote:
      return "footnote";
    case OcrElementKind::kPageHeader:
      return "pageHeader";
    case OcrElementKind::kPageFooter:
      return "pageFooter";
    case OcrElementKind::kPicture:
      return "picture";
    case OcrElementKind::kFormula:
      return "formula";
    case OcrElementKind::kCode:
      return "code";
    case OcrElementKind::kTable:
      return "table";
    case OcrElementKind::kChart:
      return "chart";
    case OcrElementKind::kToc:
      return "tableOfContents";
    case OcrElementKind::kBibliography:
      return "bibliography";
    case OcrElementKind::kCheckbox:
      return "checkbox";
    case OcrElementKind::kForm:
      return "form";
    case OcrElementKind::kKeyValue:
      return "keyValueRegion";
  }
  return "";
}

}  // namespace ocr
}  // namespace sherpa_onnx
