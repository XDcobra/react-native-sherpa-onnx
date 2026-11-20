/**
 * sherpa-onnx-tts-lexicon.h
 *
 * Which detected lexicon file(s) a TTS engine loads at init.
 */

#ifndef SHERPA_ONNX_TTS_LEXICON_H
#define SHERPA_ONNX_TTS_LEXICON_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

namespace sherpaonnx {

/**
 * Lexicon path for the engine config.
 *
 * Most models load one lexicon, so several files are a choice: \p languageId picks
 * one, otherwise the first sorted candidate wins (ResolveLexiconPath).
 *
 * ZipVoice is bilingual (zh + en) and has no other text frontend: a word missing
 * from every loaded lexicon is skipped without an error. Without \p languageId it
 * therefore loads all candidates, joined with ',' as upstream expects (e.g.
 * "lexicon.txt,lexicon-en-us.txt").
 */
inline std::string ResolveTtsLexiconPaths(
    TtsModelKind kind,
    const std::vector<model_detect::LexiconCandidate>& candidates,
    const std::string& languageId = ""
) {
    if (kind != TtsModelKind::kZipvoice || !languageId.empty() || candidates.size() < 2) {
        return model_detect::ResolveLexiconPath(candidates, languageId);
    }
    std::string joined;
    for (const auto& c : candidates) {
        if (c.path.empty()) continue;
        if (!joined.empty()) joined += ',';
        joined += c.path;
    }
    return joined;
}

/** Init error code: the model needs a lexicon file its directory lacks. */
inline constexpr const char* kTtsErrorLexiconMissing = "TTS_LEXICON_MISSING";

/** Upstream's English lexicon, published next to the packs that need it. */
inline constexpr const char* kTtsEnglishLexiconFile = "lexicon-en-us.txt";

/**
 * True for a lexicon language id (from lexicon-<id>.txt) that names English:
 * "en", "en-us", "en_gb", "us-en", "gb-en".
 */
inline bool IsEnglishLexiconLanguageId(const std::string& languageId) {
    std::string id(languageId);
    std::transform(id.begin(), id.end(), id.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (id == "en") return true;
    if (id.size() > 3 && id.compare(0, 2, "en") == 0 && (id[2] == '-' || id[2] == '_')) {
        return true;
    }
    const size_t n = id.size();
    return n > 3 && id.compare(n - 2, 2, "en") == 0 && (id[n - 3] == '-' || id[n - 3] == '_');
}

/**
 * Lexicon file auto init must refuse to start without, or "" when nothing is missing.
 *
 * ZipVoice reads Chinese and English text only through its lexicons and skips every
 * word that is in none of them without an error. Without an English lexicon every
 * English word is lost, so the voice reads garbage instead of failing. An explicit
 * \p languageId is the caller's own pick and is not second-guessed.
 */
inline std::string MissingTtsLexiconFile(
    TtsModelKind kind,
    const std::vector<model_detect::LexiconCandidate>& candidates,
    const std::string& languageId = ""
) {
    if (kind != TtsModelKind::kZipvoice || !languageId.empty()) return "";
    for (const auto& c : candidates) {
        if (IsEnglishLexiconLanguageId(c.languageId)) return "";
    }
    return kTtsEnglishLexiconFile;
}

/** Message for kTtsErrorLexiconMissing; starts with the code. */
inline std::string TtsLexiconMissingMessage(const std::string& fileName) {
    return std::string(kTtsErrorLexiconMissing) + ": ZipVoice needs an English lexicon (" +
        fileName + ") in the model directory; without it every English word is skipped. " +
        "ensureModel() downloads it for catalog models, or add the upstream file next to " +
        "lexicon.txt. Set lexiconLanguageId to load only the lexicon you pick.";
}

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_TTS_LEXICON_H
