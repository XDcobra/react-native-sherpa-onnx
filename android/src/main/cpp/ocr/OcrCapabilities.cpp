#include "OcrCapabilities.h"

#include <algorithm>

namespace sherpa_onnx {
namespace ocr {
namespace {

bool TaskAllowed(const OcrFamilyCapabilities& caps, const std::string& task) {
  return std::find(caps.tasks.begin(), caps.tasks.end(), task) != caps.tasks.end();
}

bool GranularityAllowed(const OcrFamilyCapabilities& caps, OcrGranularity g) {
  return std::find(caps.granularities.begin(), caps.granularities.end(), g) !=
         caps.granularities.end();
}

std::string DocVlmTaskId(const DocVlmInstruction& inst) {
  switch (inst.task) {
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

std::string PaddleTaskId(PaddleocrVlTask t) {
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

bool CropInsideFrame(const OcrPixelRect& crop, int frame_w, int frame_h) {
  if (!OcrPixelRectValid(crop)) return false;
  if (frame_w <= 0 || frame_h <= 0) return false;
  const long right = static_cast<long>(crop.x) + crop.width;
  const long bottom = static_cast<long>(crop.y) + crop.height;
  return right <= frame_w && bottom <= frame_h;
}

OcrValidateResult Fail(const char* code, const std::string& msg) {
  OcrValidateResult out;
  out.error_code = code;
  out.error_message = msg;
  return out;
}

}  // namespace

const char* GranularityName(OcrGranularity granularity) {
  switch (granularity) {
    case OcrGranularity::kWord:
      return "word";
    case OcrGranularity::kBlock:
      return "block";
    case OcrGranularity::kLine:
    default:
      return "line";
  }
}

OcrFamilyCapabilities CapabilitiesForFamily(const std::string& family) {
  OcrFamilyCapabilities caps;
  caps.family = family;
  caps.supports_crop = true;
  caps.granularities = {OcrGranularity::kLine};
  if (family == "ppocr" || family == "doctr") {
    caps.produces_elements = false;
    return caps;
  }
  if (family == "doc_vlm") {
    caps.tasks = {"page", "element", "regionText", "identifyElement"};
    caps.granularities = {OcrGranularity::kLine, OcrGranularity::kBlock};
    caps.produces_elements = true;
    return caps;
  }
  if (family == "nemotron_parse") {
    caps.tasks = {"page"};
    caps.produces_elements = true;
    return caps;
  }
  if (family == "paddleocr_vl") {
    caps.tasks = {"ocr", "table", "formula", "chart", "seal", "spotting"};
    caps.produces_elements = false;
    return caps;
  }
  return caps;
}

OcrValidateResult ValidateRequest(const std::string& family,
                                  const OcrRecognizeRequest& request,
                                  OcrGranularity granularity, int frame_w,
                                  int frame_h) {
  const OcrFamilyCapabilities caps = CapabilitiesForFamily(family);

  if (family != caps.family && !family.empty()) {
    return Fail(kOcrErrInstructionFamilyMismatch, "unknown OCR family");
  }

  if (!GranularityAllowed(caps, granularity)) {
    return Fail(kOcrErrUnsupportedGranularity,
                "granularity is not produced by this family");
  }

  if (request.crop) {
    if (frame_w > 0 && frame_h > 0 &&
        !CropInsideFrame(*request.crop, frame_w, frame_h)) {
      return Fail(kOcrErrInvalidRegion, "crop lies outside the frame");
    }
  }

  if (family == "ppocr" || family == "doctr") {
    if (!std::holds_alternative<std::monostate>(request.instruction)) {
      return Fail(kOcrErrInstructionUnsupported,
                  "instruction is not valid for " + family);
    }
    OcrValidateResult ok;
    ok.ok = true;
    return ok;
  }

  if (family == "doc_vlm") {
    const auto* inst = std::get_if<DocVlmInstruction>(&request.instruction);
    if (!inst) {
      return Fail(kOcrErrInstructionFamilyMismatch,
                  "instruction family does not match loaded backend");
    }
    const std::string task = DocVlmTaskId(*inst);
    if (!TaskAllowed(caps, task)) {
      return Fail(kOcrErrInstructionUnsupported,
                  "doc_vlm task not enabled: " + task);
    }
    if (InstructionNeedsRegion(*inst)) {
      if (!OcrPixelRectValid(inst->region)) {
        return Fail(kOcrErrInvalidRegion, "region must have x,y>=0 and width,height>0");
      }
      if (frame_w > 0 && frame_h > 0 &&
          !CropInsideFrame(inst->region, frame_w, frame_h)) {
        return Fail(kOcrErrInvalidRegion, "region lies outside the frame");
      }
    }
    if (InstructionNeedsRegion(*inst) && request.crop) {
      return Fail(kOcrErrInstructionUnsupported,
                  "crop cannot combine with regionText/identifyElement");
    }
    if (inst->task == DocVlmTask::kElement &&
        inst->element == DocVlmElement::kChart) {
      return Fail(kOcrErrInstructionUnsupported,
                  "doc_vlm element=chart did not pass the Phase 0 grammar gate");
    }
    OcrValidateResult ok;
    ok.ok = true;
    return ok;
  }

  if (family == "nemotron_parse") {
    const auto* inst = std::get_if<NemotronParseInstruction>(&request.instruction);
    if (!inst) {
      return Fail(kOcrErrInstructionFamilyMismatch,
                  "instruction family does not match loaded backend");
    }
    if (!TaskAllowed(caps, "page")) {
      return Fail(kOcrErrInstructionUnsupported, "nemotron_parse task not enabled");
    }
    // Phase 0: only markdown_none_pic is token-identical to the int8 pack.
    const auto& o = inst->output;
    if (o.text != NemotronParseText::kMarkdown ||
        o.layout != NemotronParseLayout::kNone || !o.text_in_pictures) {
      return Fail(kOcrErrInstructionUnsupported,
                  "nemotron_parse profile did not pass the Phase 0 identity gate");
    }
    OcrValidateResult ok;
    ok.ok = true;
    return ok;
  }

  if (family == "paddleocr_vl") {
    const auto* inst = std::get_if<PaddleocrVlInstruction>(&request.instruction);
    if (!inst) {
      return Fail(kOcrErrInstructionFamilyMismatch,
                  "instruction family does not match loaded backend");
    }
    const std::string task = PaddleTaskId(inst->task);
    if (!TaskAllowed(caps, task)) {
      return Fail(kOcrErrInstructionUnsupported,
                  "paddleocr_vl task not enabled: " + task);
    }
    OcrValidateResult ok;
    ok.ok = true;
    return ok;
  }

  return Fail(kOcrErrInstructionFamilyMismatch, "unknown OCR family: " + family);
}

}  // namespace ocr
}  // namespace sherpa_onnx
