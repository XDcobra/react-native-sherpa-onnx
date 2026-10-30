#pragma once

#include <string>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {

/** Load character_dict list from PP-OCR rec_inference.yml. */
std::vector<std::string> LoadCharacterDictFromYml(const std::string& yml_path);

/**
 * CTC greedy decode. logits: [T, C] row-major. dict[0] unused (blank=0).
 * Returns utf8 text + mean confidence of kept steps.
 */
std::pair<std::string, float> CtcGreedyDecode(
    const float* logits,
    int time_steps,
    int num_classes,
    const std::vector<std::string>& dict);

/** UTF-8 → UTF-16 code unit count (approx for BMP+surrogates). */
int Utf8ToUtf16Length(const std::string& utf8);

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
