#include "sherpa-onnx-model-path-fill.h"

namespace sherpaonnx {
namespace {

void SetPathFromMap(
    const std::map<std::string, std::string>& m,
    const char* key,
    std::string& out
) {
    const auto it = m.find(key);
    if (it != m.end() && !it->second.empty()) {
        out = it->second;
    }
}

}  // namespace

void FillSttModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    SttModelPaths& out
) {
    SetPathFromMap(paths, "encoder", out.encoder);
    SetPathFromMap(paths, "decoder", out.decoder);
    SetPathFromMap(paths, "joiner", out.joiner);
    SetPathFromMap(paths, "tokens", out.tokens);
    SetPathFromMap(paths, "bpeVocab", out.bpeVocab);
    SetPathFromMap(paths, "paraformerModel", out.paraformerModel);
    SetPathFromMap(paths, "ctcModel", out.ctcModel);
    SetPathFromMap(paths, "whisperEncoder", out.whisperEncoder);
    SetPathFromMap(paths, "whisperDecoder", out.whisperDecoder);
    SetPathFromMap(paths, "funasrEncoderAdaptor", out.funasrEncoderAdaptor);
    SetPathFromMap(paths, "funasrLLM", out.funasrLLM);
    SetPathFromMap(paths, "funasrEmbedding", out.funasrEmbedding);
    SetPathFromMap(paths, "funasrTokenizer", out.funasrTokenizer);
    SetPathFromMap(paths, "qwen3ConvFrontend", out.qwen3ConvFrontend);
    SetPathFromMap(paths, "qwen3Encoder", out.qwen3Encoder);
    SetPathFromMap(paths, "qwen3Decoder", out.qwen3Decoder);
    SetPathFromMap(paths, "qwen3Tokenizer", out.qwen3Tokenizer);
    SetPathFromMap(paths, "cohereEncoder", out.cohereEncoder);
    SetPathFromMap(paths, "cohereDecoder", out.cohereDecoder);
    SetPathFromMap(paths, "moonshinePreprocessor", out.moonshinePreprocessor);
    SetPathFromMap(paths, "moonshineEncoder", out.moonshineEncoder);
    SetPathFromMap(paths, "moonshineUncachedDecoder", out.moonshineUncachedDecoder);
    SetPathFromMap(paths, "moonshineCachedDecoder", out.moonshineCachedDecoder);
    SetPathFromMap(paths, "moonshineMergedDecoder", out.moonshineMergedDecoder);
    SetPathFromMap(paths, "fireRedEncoder", out.fireRedEncoder);
    SetPathFromMap(paths, "fireRedDecoder", out.fireRedDecoder);
    SetPathFromMap(paths, "canaryEncoder", out.canaryEncoder);
    SetPathFromMap(paths, "canaryDecoder", out.canaryDecoder);
    SetPathFromMap(paths, "dolphinModel", out.dolphinModel);
    SetPathFromMap(paths, "omnilingualModel", out.omnilingualModel);
    SetPathFromMap(paths, "medasrModel", out.medasrModel);
    SetPathFromMap(paths, "telespeechCtcModel", out.telespeechCtcModel);
}

void FillTtsModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    TtsModelPaths& out
) {
    SetPathFromMap(paths, "ttsModel", out.ttsModel);
    SetPathFromMap(paths, "tokens", out.tokens);
    SetPathFromMap(paths, "lexicon", out.lexicon);
    SetPathFromMap(paths, "dataDir", out.dataDir);
    SetPathFromMap(paths, "voices", out.voices);
    SetPathFromMap(paths, "acousticModel", out.acousticModel);
    SetPathFromMap(paths, "vocoder", out.vocoder);
    SetPathFromMap(paths, "encoder", out.encoder);
    SetPathFromMap(paths, "decoder", out.decoder);
    SetPathFromMap(paths, "lmFlow", out.lmFlow);
    SetPathFromMap(paths, "lmMain", out.lmMain);
    SetPathFromMap(paths, "textConditioner", out.textConditioner);
    SetPathFromMap(paths, "vocabJson", out.vocabJson);
    SetPathFromMap(paths, "tokenScoresJson", out.tokenScoresJson);
    SetPathFromMap(paths, "durationPredictor", out.durationPredictor);
    SetPathFromMap(paths, "textEncoder", out.textEncoder);
    SetPathFromMap(paths, "vectorEstimator", out.vectorEstimator);
    SetPathFromMap(paths, "ttsJson", out.ttsJson);
    SetPathFromMap(paths, "unicodeIndexer", out.unicodeIndexer);
    SetPathFromMap(paths, "voiceStyle", out.voiceStyle);
}

void FillVadModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    VadModelPaths& out
) {
    SetPathFromMap(paths, "model", out.model);
}

void FillEnhancementModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    EnhancementModelPaths& out
) {
    SetPathFromMap(paths, "model", out.model);
}

void FillPunctuationModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    PunctuationModelPaths& out
) {
    SetPathFromMap(paths, "ct_transformer", out.ct_transformer);
    SetPathFromMap(paths, "cnn_bilstm", out.cnn_bilstm);
    SetPathFromMap(paths, "bpe_vocab", out.bpe_vocab);
}

void FillAlignmentModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    AlignmentModelPaths& out
) {
    SetPathFromMap(paths, "model", out.model);
}

}  // namespace sherpaonnx
