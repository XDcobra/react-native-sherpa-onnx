/**
 * sherpa-onnx-tts-lexicon.h
 *
 * Which detected lexicon file(s) a TTS engine loads at init.
 */

#ifndef SHERPA_ONNX_TTS_LEXICON_H
#define SHERPA_ONNX_TTS_LEXICON_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

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

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_TTS_LEXICON_H
