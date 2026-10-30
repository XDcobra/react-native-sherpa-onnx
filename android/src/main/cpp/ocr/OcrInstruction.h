/**
 * Family-discriminated recognize instruction. One variant, no `family` field
 * on the instruction itself — the loaded backend is the source of truth.
 */
#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>

namespace sherpa_onnx {
namespace ocr {

/** Axis-aligned rectangle in decoded-frame pixels (same space as span quads). */
struct OcrPixelRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

inline bool OcrPixelRectValid(const OcrPixelRect& r) {
  return r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0;
}

enum class DocVlmTask : uint8_t {
  kPage = 0,
  kElement,
  kRegionText,
  kIdentifyElement,
};

enum class DocVlmElement : uint8_t {
  kTable = 0,
  kChart,
  kFormula,
  kCode,
};

struct DocVlmInstruction {
  DocVlmTask task = DocVlmTask::kPage;
  DocVlmElement element = DocVlmElement::kTable;
  OcrPixelRect region{};
};

enum class NemotronParseText : uint8_t {
  kMarkdown = 0,
  kPlain,
  kNone,
};

enum class NemotronParseLayout : uint8_t {
  kNone = 0,
  kBoxes,
  kBoxesAndClasses,
};

struct NemotronParseOutput {
  NemotronParseText text = NemotronParseText::kMarkdown;
  NemotronParseLayout layout = NemotronParseLayout::kNone;
  bool text_in_pictures = true;
};

struct NemotronParseInstruction {
  NemotronParseOutput output{};
};

enum class PaddleocrVlTask : uint8_t {
  kOcr = 0,
  kTable,
  kFormula,
  kChart,
  kSeal,
  kSpotting,
};

struct PaddleocrVlInstruction {
  PaddleocrVlTask task = PaddleocrVlTask::kOcr;
};

/** `std::monostate` = ppocr / doctr (no model-side instruction). */
using OcrInstruction = std::variant<std::monostate, DocVlmInstruction,
                                    NemotronParseInstruction,
                                    PaddleocrVlInstruction>;

enum class OcrVlmRawMode : uint8_t { kAccepted = 0, kFull = 1 };

struct OcrRecognizeRequest {
  OcrInstruction instruction;
  std::optional<OcrPixelRect> crop;
  /** Granite: stop decode on prefix reject (`kAccepted`) or keep going (`kFull`). */
  OcrVlmRawMode raw_mode = OcrVlmRawMode::kAccepted;
};

inline constexpr const char* kOcrErrInstructionFamilyMismatch =
    "OCR_INSTRUCTION_FAMILY_MISMATCH";
inline constexpr const char* kOcrErrInstructionUnsupported =
    "OCR_INSTRUCTION_UNSUPPORTED";
inline constexpr const char* kOcrErrInvalidRegion = "OCR_INVALID_REGION";
inline constexpr const char* kOcrErrUnsupportedGranularity =
    "OCR_UNSUPPORTED_GRANULARITY";
inline constexpr const char* kOcrErrInvalidRecognizeSpec =
    "OCR_INVALID_RECOGNIZE_SPEC";
inline constexpr const char* kOcrErrParseUnknownKind = "OCR_PARSE_UNKNOWN_KIND";
inline constexpr const char* kOcrErrCapabilitiesMismatch =
    "OCR_CAPABILITIES_MISMATCH";

class OcrCodedError : public std::runtime_error {
 public:
  OcrCodedError(const char* code, const std::string& message)
      : std::runtime_error(message), code_(code ? code : "") {}
  const std::string& code() const { return code_; }

 private:
  std::string code_;
};

inline DocVlmInstruction DefaultDocVlmInstruction() {
  DocVlmInstruction inst;
  inst.task = DocVlmTask::kPage;
  return inst;
}

inline NemotronParseInstruction DefaultNemotronParseInstruction() {
  NemotronParseInstruction inst;
  inst.output.text = NemotronParseText::kMarkdown;
  inst.output.layout = NemotronParseLayout::kNone;
  inst.output.text_in_pictures = true;
  return inst;
}

inline PaddleocrVlInstruction DefaultPaddleocrVlInstruction() {
  PaddleocrVlInstruction inst;
  inst.task = PaddleocrVlTask::kOcr;
  return inst;
}

inline OcrInstruction DefaultInstructionForFamily(const std::string& family) {
  if (family == "doc_vlm") return DefaultDocVlmInstruction();
  if (family == "nemotron_parse") return DefaultNemotronParseInstruction();
  if (family == "paddleocr_vl") return DefaultPaddleocrVlInstruction();
  return std::monostate{};
}

inline bool InstructionNeedsRegion(const DocVlmInstruction& inst) {
  return inst.task == DocVlmTask::kRegionText ||
         inst.task == DocVlmTask::kIdentifyElement;
}

inline bool InstructionNeedsElement(const DocVlmInstruction& inst) {
  return inst.task == DocVlmTask::kElement;
}

}  // namespace ocr
}  // namespace sherpa_onnx
