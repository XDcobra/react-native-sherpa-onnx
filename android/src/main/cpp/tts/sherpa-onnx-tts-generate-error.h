/**
 * sherpa-onnx-tts-generate-error.h
 *
 * Why a TTS generate call gave no audio, as a stable code plus a readable
 * message. Shared by the Android JNI and iOS bridges so both reject with the
 * same code.
 */

#ifndef SHERPA_ONNX_TTS_GENERATE_ERROR_H
#define SHERPA_ONNX_TTS_GENERATE_ERROR_H

#include "sherpa-onnx-model-detect.h"

#include <algorithm>
#include <cctype>
#include <exception>
#include <new>
#include <string>

namespace sherpaonnx {

/** Generation ran out of memory (std::bad_alloc or an ONNX Runtime allocation failure). */
inline constexpr const char* kTtsErrorOom = "OFFLINE_OOM";
/** Generation threw, or the engine was not ready. */
inline constexpr const char* kTtsErrorGenerate = "TTS_GENERATE_ERROR";
/** The model ran without an error but returned no audio for non-empty input. */
inline constexpr const char* kTtsErrorEmptyOutput = "TTS_EMPTY_OUTPUT";

struct TtsGenerateError {
    std::string code;
    std::string message;
};

/** True when an exception text describes a failed memory allocation. */
inline bool IsOutOfMemoryText(const std::string& what) {
    std::string lower(what);
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return lower.find("bad_alloc") != std::string::npos ||
        lower.find("bad allocation") != std::string::npos ||
        lower.find("failed to allocate") != std::string::npos ||
        lower.find("out of memory") != std::string::npos;
}

inline TtsGenerateError TtsErrorFromException(const std::exception& e) {
    const std::string what = e.what() != nullptr ? e.what() : "";
    if (dynamic_cast<const std::bad_alloc*>(&e) != nullptr || IsOutOfMemoryText(what)) {
        return {kTtsErrorOom, "Not enough memory for text-to-speech: " + what};
    }
    return {kTtsErrorGenerate, "TTS generation failed: " + what};
}

inline TtsGenerateError TtsErrorFromUnknownException() {
    return {kTtsErrorGenerate, "TTS generation failed with an unknown native error"};
}

inline TtsGenerateError TtsErrorNotInitialized() {
    return {kTtsErrorGenerate, "TTS not initialized. Call initialize() first."};
}

inline TtsGenerateError TtsErrorEmptyText() {
    return {kTtsErrorGenerate, "TTS input text is empty"};
}

/**
 * The model returned no audio although the input was not empty. Upstream drops
 * such text without an error, so the cause cannot be told for sure; the message
 * names the usual ones per model.
 */
inline TtsGenerateError TtsErrorForEmptyOutput(TtsModelKind kind) {
    switch (kind) {
        case TtsModelKind::kZipvoice:
            return {kTtsErrorEmptyOutput,
                    "ZipVoice produced no audio for this text. The text may be too short for "
                    "the reference audio and speed (ZipVoice skips such text without an error), "
                    "or have no words in the model's lexicon. Try a longer text, a shorter "
                    "reference clip or a lower speed."};
        case TtsModelKind::kPocket:
            return {kTtsErrorEmptyOutput,
                    "Pocket TTS produced no audio for this text. Check that the text has words "
                    "the model can read and that the reference audio holds speech."};
        default:
            return {kTtsErrorEmptyOutput,
                    "The TTS model produced no audio for this text. Check that the text has "
                    "words the model can read."};
    }
}

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_TTS_GENERATE_ERROR_H
