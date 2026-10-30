#include "OcrRecognizeSpec.h"

#include <cctype>
#include <sstream>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace {

struct Fail {
  std::string code;
  std::string message;
};

OcrRecognizeSpecParse MakeFail(const std::string& code, const std::string& msg) {
  OcrRecognizeSpecParse out;
  out.ok = false;
  out.error_code = code;
  out.error_message = msg;
  return out;
}

std::vector<std::string> Split(const std::string& s, char delim) {
  std::vector<std::string> parts;
  std::string cur;
  for (char c : s) {
    if (c == delim) {
      parts.push_back(cur);
      cur.clear();
    } else {
      cur.push_back(c);
    }
  }
  parts.push_back(cur);
  return parts;
}

bool ParseIntStrict(const std::string& s, int& value) {
  if (s.empty()) return false;
  size_t i = 0;
  if (s[0] == '+' || s[0] == '-') {
    if (s.size() == 1) return false;
    i = 1;
  }
  for (; i < s.size(); ++i) {
    if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
  }
  try {
    value = std::stoi(s);
  } catch (...) {
    return false;
  }
  return true;
}

bool ParsePic(const std::string& s, bool& value) {
  if (s == "1") {
    value = true;
    return true;
  }
  if (s == "0") {
    value = false;
    return true;
  }
  return false;
}

const char* TaskNameDocVlm(DocVlmTask t) {
  switch (t) {
    case DocVlmTask::kPage:
      return "page";
    case DocVlmTask::kElement:
      return "element";
    case DocVlmTask::kRegionText:
      return "regionText";
    case DocVlmTask::kIdentifyElement:
      return "identifyElement";
  }
  return "";
}

const char* ElementName(DocVlmElement e) {
  switch (e) {
    case DocVlmElement::kTable:
      return "table";
    case DocVlmElement::kChart:
      return "chart";
    case DocVlmElement::kFormula:
      return "formula";
    case DocVlmElement::kCode:
      return "code";
  }
  return "";
}

const char* TaskNamePaddle(PaddleocrVlTask t) {
  switch (t) {
    case PaddleocrVlTask::kOcr:
      return "ocr";
    case PaddleocrVlTask::kTable:
      return "table";
    case PaddleocrVlTask::kFormula:
      return "formula";
    case PaddleocrVlTask::kChart:
      return "chart";
    case PaddleocrVlTask::kSeal:
      return "seal";
    case PaddleocrVlTask::kSpotting:
      return "spotting";
  }
  return "";
}

const char* TextName(NemotronParseText t) {
  switch (t) {
    case NemotronParseText::kMarkdown:
      return "markdown";
    case NemotronParseText::kPlain:
      return "plain";
    case NemotronParseText::kNone:
      return "none";
  }
  return "";
}

const char* LayoutName(NemotronParseLayout t) {
  switch (t) {
    case NemotronParseLayout::kNone:
      return "none";
    case NemotronParseLayout::kBoxes:
      return "boxes";
    case NemotronParseLayout::kBoxesAndClasses:
      return "boxesAndClasses";
  }
  return "";
}

bool ParseDocVlmTask(const std::string& s, DocVlmTask& t) {
  if (s == "page") {
    t = DocVlmTask::kPage;
    return true;
  }
  if (s == "element") {
    t = DocVlmTask::kElement;
    return true;
  }
  if (s == "regionText") {
    t = DocVlmTask::kRegionText;
    return true;
  }
  if (s == "identifyElement") {
    t = DocVlmTask::kIdentifyElement;
    return true;
  }
  return false;
}

bool ParseElement(const std::string& s, DocVlmElement& e) {
  if (s == "table") {
    e = DocVlmElement::kTable;
    return true;
  }
  if (s == "chart") {
    e = DocVlmElement::kChart;
    return true;
  }
  if (s == "formula") {
    e = DocVlmElement::kFormula;
    return true;
  }
  if (s == "code") {
    e = DocVlmElement::kCode;
    return true;
  }
  return false;
}

bool ParsePaddleTask(const std::string& s, PaddleocrVlTask& t) {
  if (s == "ocr") {
    t = PaddleocrVlTask::kOcr;
    return true;
  }
  if (s == "table") {
    t = PaddleocrVlTask::kTable;
    return true;
  }
  if (s == "formula") {
    t = PaddleocrVlTask::kFormula;
    return true;
  }
  if (s == "chart") {
    t = PaddleocrVlTask::kChart;
    return true;
  }
  if (s == "seal") {
    t = PaddleocrVlTask::kSeal;
    return true;
  }
  if (s == "spotting") {
    t = PaddleocrVlTask::kSpotting;
    return true;
  }
  return false;
}

bool ParseText(const std::string& s, NemotronParseText& t) {
  if (s == "markdown") {
    t = NemotronParseText::kMarkdown;
    return true;
  }
  if (s == "plain") {
    t = NemotronParseText::kPlain;
    return true;
  }
  if (s == "none") {
    t = NemotronParseText::kNone;
    return true;
  }
  return false;
}

bool ParseLayout(const std::string& s, NemotronParseLayout& t) {
  if (s == "none") {
    t = NemotronParseLayout::kNone;
    return true;
  }
  if (s == "boxes") {
    t = NemotronParseLayout::kBoxes;
    return true;
  }
  if (s == "boxesAndClasses") {
    t = NemotronParseLayout::kBoxesAndClasses;
    return true;
  }
  return false;
}

void AppendKv(std::string& out, const char* key, const std::string& value) {
  out += ';';
  out += key;
  out += '=';
  out += value;
}

}  // namespace

OcrRecognizeSpecParse ParseOcrRecognizeSpec(const std::string& spec) {
  if (spec.empty()) {
    return MakeFail(kOcrErrInvalidRecognizeSpec, "recognizeSpec is empty");
  }
  const auto parts = Split(spec, ';');
  if (parts.empty() || parts[0] != "v1") {
    return MakeFail(kOcrErrInvalidRecognizeSpec, "recognizeSpec must start with v1");
  }

  std::unordered_map<std::string, std::string> kv;
  std::unordered_set<std::string> seen;
  for (size_t i = 1; i < parts.size(); ++i) {
    if (parts[i].empty()) {
      return MakeFail(kOcrErrInvalidRecognizeSpec, "empty recognizeSpec field");
    }
    const auto eq = parts[i].find('=');
    if (eq == std::string::npos || eq == 0) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "recognizeSpec field missing key=value: " + parts[i]);
    }
    const std::string key = parts[i].substr(0, eq);
    const std::string value = parts[i].substr(eq + 1);
    if (!seen.insert(key).second) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "duplicate recognizeSpec key: " + key);
    }
    kv[key] = value;
  }

  static const std::unordered_set<std::string> kKnown = {
      "family", "task", "element", "rx", "ry", "rw", "rh",
      "text",   "layout", "pic",  "cx", "cy", "cw", "ch", "raw"};
  for (const auto& [key, _] : kv) {
    if (kKnown.count(key) == 0) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "unknown recognizeSpec key: " + key);
    }
  }

  if (kv.count("family") == 0 || kv["family"].empty()) {
    return MakeFail(kOcrErrInvalidRecognizeSpec, "recognizeSpec missing family");
  }
  const std::string family = kv["family"];
  OcrRecognizeSpecParse out;
  out.family = family;
  out.request.instruction = DefaultInstructionForFamily(family);

  auto need_int = [&](const char* key, int& dest) -> bool {
    if (kv.count(key) == 0) return false;
    if (!ParseIntStrict(kv[key], dest)) {
      out = MakeFail(kOcrErrInvalidRecognizeSpec,
                     std::string("recognizeSpec ") + key + " is not an integer");
      return false;
    }
    return true;
  };

  if (kv.count("cx") || kv.count("cy") || kv.count("cw") || kv.count("ch")) {
    if (!kv.count("cx") || !kv.count("cy") || !kv.count("cw") || !kv.count("ch")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec, "crop requires cx,cy,cw,ch");
    }
    OcrPixelRect crop;
    if (!need_int("cx", crop.x) || !need_int("cy", crop.y) ||
        !need_int("cw", crop.width) || !need_int("ch", crop.height)) {
      return out.ok ? MakeFail(kOcrErrInvalidRecognizeSpec, "invalid crop") : out;
    }
    if (!OcrPixelRectValid(crop)) {
      return MakeFail(kOcrErrInvalidRegion, "crop must have x,y>=0 and width,height>0");
    }
    out.request.crop = crop;
  }

  if (kv.count("raw")) {
    if (kv["raw"] == "full") {
      out.request.raw_mode = OcrVlmRawMode::kFull;
    } else if (kv["raw"] == "accepted") {
      out.request.raw_mode = OcrVlmRawMode::kAccepted;
    } else {
      return MakeFail(kOcrErrInvalidRecognizeSpec, "raw must be accepted or full");
    }
  }

  if (family == "ppocr" || family == "doctr") {
    if (kv.count("task") || kv.count("element") || kv.count("text") ||
        kv.count("layout") || kv.count("pic") || kv.count("rx") ||
        kv.count("raw")) {
      return MakeFail(kOcrErrInstructionUnsupported,
                      "instruction is not valid for " + family);
    }
    out.ok = true;
    return out;
  }

  if (family == "doc_vlm") {
    DocVlmInstruction inst = DefaultDocVlmInstruction();
    if (kv.count("task")) {
      if (!ParseDocVlmTask(kv["task"], inst.task)) {
        return MakeFail(kOcrErrInstructionUnsupported,
                        "unknown doc_vlm task: " + kv["task"]);
      }
    }
    if (InstructionNeedsElement(inst)) {
      if (kv.count("element") == 0) {
        return MakeFail(kOcrErrInvalidRecognizeSpec,
                        "doc_vlm element task requires element=");
      }
      if (!ParseElement(kv["element"], inst.element)) {
        return MakeFail(kOcrErrInstructionUnsupported,
                        "unknown doc_vlm element: " + kv["element"]);
      }
      if (inst.element == DocVlmElement::kChart) {
        return MakeFail(
            kOcrErrInstructionUnsupported,
            "doc_vlm element=chart did not pass the Phase 0 grammar gate");
      }
    } else if (kv.count("element")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "element= is only valid for doc_vlm task=element");
    }
    if (InstructionNeedsRegion(inst)) {
      if (!kv.count("rx") || !kv.count("ry") || !kv.count("rw") || !kv.count("rh")) {
        return MakeFail(kOcrErrInvalidRecognizeSpec,
                        "region task requires rx,ry,rw,rh");
      }
      if (!need_int("rx", inst.region.x) || !need_int("ry", inst.region.y) ||
          !need_int("rw", inst.region.width) || !need_int("rh", inst.region.height)) {
        return out;
      }
      if (!OcrPixelRectValid(inst.region)) {
        return MakeFail(kOcrErrInvalidRegion,
                        "region must have x,y>=0 and width,height>0");
      }
    } else if (kv.count("rx") || kv.count("ry") || kv.count("rw") || kv.count("rh")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "rx,ry,rw,rh only valid for regionText/identifyElement");
    }
    if (kv.count("text") || kv.count("layout") || kv.count("pic")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "nemotron keys are not valid on doc_vlm");
    }
    out.request.instruction = inst;
    out.ok = true;
    return out;
  }

  if (family == "nemotron_parse") {
    if (kv.count("task") && kv["task"] != "page") {
      return MakeFail(kOcrErrInstructionUnsupported,
                      "nemotron_parse task must be page");
    }
    NemotronParseInstruction inst = DefaultNemotronParseInstruction();
    if (kv.count("text")) {
      if (!ParseText(kv["text"], inst.output.text)) {
        return MakeFail(kOcrErrInstructionUnsupported,
                        "unknown nemotron text: " + kv["text"]);
      }
    }
    if (kv.count("layout")) {
      if (!ParseLayout(kv["layout"], inst.output.layout)) {
        return MakeFail(kOcrErrInstructionUnsupported,
                        "unknown nemotron layout: " + kv["layout"]);
      }
    }
    if (kv.count("pic")) {
      if (!ParsePic(kv["pic"], inst.output.text_in_pictures)) {
        return MakeFail(kOcrErrInvalidRecognizeSpec, "pic must be 0 or 1");
      }
    }
    if (inst.output.text != NemotronParseText::kMarkdown ||
        inst.output.layout != NemotronParseLayout::kNone ||
        !inst.output.text_in_pictures) {
      return MakeFail(kOcrErrInstructionUnsupported,
                      "nemotron_parse profile did not pass the Phase 0 identity gate");
    }
    if (kv.count("element") || kv.count("rx")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "doc_vlm keys are not valid on nemotron_parse");
    }
    out.request.instruction = inst;
    out.ok = true;
    return out;
  }

  if (family == "paddleocr_vl") {
    PaddleocrVlInstruction inst = DefaultPaddleocrVlInstruction();
    if (kv.count("task")) {
      if (!ParsePaddleTask(kv["task"], inst.task)) {
        return MakeFail(kOcrErrInstructionUnsupported,
                        "unknown paddleocr_vl task: " + kv["task"]);
      }
    }
    if (kv.count("element") || kv.count("text") || kv.count("layout") ||
        kv.count("pic") || kv.count("rx")) {
      return MakeFail(kOcrErrInvalidRecognizeSpec,
                      "non-paddle keys are not valid on paddleocr_vl");
    }
    out.request.instruction = inst;
    out.ok = true;
    return out;
  }

  return MakeFail(kOcrErrInvalidRecognizeSpec, "unknown family: " + family);
}

std::string SerializeOcrRecognizeSpec(const std::string& family,
                                      const OcrRecognizeRequest& request) {
  std::string out = "v1";
  AppendKv(out, "family", family);

  if (const auto* doc = std::get_if<DocVlmInstruction>(&request.instruction)) {
    AppendKv(out, "task", TaskNameDocVlm(doc->task));
    if (InstructionNeedsElement(*doc)) {
      AppendKv(out, "element", ElementName(doc->element));
    }
    if (InstructionNeedsRegion(*doc)) {
      AppendKv(out, "rx", std::to_string(doc->region.x));
      AppendKv(out, "ry", std::to_string(doc->region.y));
      AppendKv(out, "rw", std::to_string(doc->region.width));
      AppendKv(out, "rh", std::to_string(doc->region.height));
    }
  } else if (const auto* nemo =
                 std::get_if<NemotronParseInstruction>(&request.instruction)) {
    AppendKv(out, "task", "page");
    AppendKv(out, "text", TextName(nemo->output.text));
    AppendKv(out, "layout", LayoutName(nemo->output.layout));
    AppendKv(out, "pic", nemo->output.text_in_pictures ? "1" : "0");
  } else if (const auto* paddle =
                 std::get_if<PaddleocrVlInstruction>(&request.instruction)) {
    AppendKv(out, "task", TaskNamePaddle(paddle->task));
  }

  if (request.crop) {
    AppendKv(out, "cx", std::to_string(request.crop->x));
    AppendKv(out, "cy", std::to_string(request.crop->y));
    AppendKv(out, "cw", std::to_string(request.crop->width));
    AppendKv(out, "ch", std::to_string(request.crop->height));
  }
  if (request.raw_mode == OcrVlmRawMode::kFull) {
    AppendKv(out, "raw", "full");
  }
  return out;
}

}  // namespace ocr
}  // namespace sherpa_onnx
