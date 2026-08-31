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

void FillSeparationModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    SeparationModelPaths& out
) {
    SetPathFromMap(paths, "vocals", out.vocals);
    SetPathFromMap(paths, "accompaniment", out.accompaniment);
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

void FillOnlineSttModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    OnlineSttModelPaths& out
) {
    SetPathFromMap(paths, "encoder", out.encoder);
    SetPathFromMap(paths, "decoder", out.decoder);
    SetPathFromMap(paths, "joiner", out.joiner);
    SetPathFromMap(paths, "tokens", out.tokens);
    SetPathFromMap(paths, "model", out.model);
}

void PutPathIfNonEmpty(
    std::map<std::string, std::string>& out,
    const char* key,
    const std::string& path
) {
    if (!path.empty()) {
        out.emplace(key, path);
    }
}

std::map<std::string, std::string> SttModelPathsToStringMap(const SttModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "encoder", paths.encoder);
    PutPathIfNonEmpty(out, "decoder", paths.decoder);
    PutPathIfNonEmpty(out, "joiner", paths.joiner);
    PutPathIfNonEmpty(out, "tokens", paths.tokens);
    PutPathIfNonEmpty(out, "bpeVocab", paths.bpeVocab);
    PutPathIfNonEmpty(out, "paraformerModel", paths.paraformerModel);
    PutPathIfNonEmpty(out, "ctcModel", paths.ctcModel);
    PutPathIfNonEmpty(out, "whisperEncoder", paths.whisperEncoder);
    PutPathIfNonEmpty(out, "whisperDecoder", paths.whisperDecoder);
    PutPathIfNonEmpty(out, "funasrEncoderAdaptor", paths.funasrEncoderAdaptor);
    PutPathIfNonEmpty(out, "funasrLLM", paths.funasrLLM);
    PutPathIfNonEmpty(out, "funasrEmbedding", paths.funasrEmbedding);
    PutPathIfNonEmpty(out, "funasrTokenizer", paths.funasrTokenizer);
    PutPathIfNonEmpty(out, "qwen3ConvFrontend", paths.qwen3ConvFrontend);
    PutPathIfNonEmpty(out, "qwen3Encoder", paths.qwen3Encoder);
    PutPathIfNonEmpty(out, "qwen3Decoder", paths.qwen3Decoder);
    PutPathIfNonEmpty(out, "qwen3Tokenizer", paths.qwen3Tokenizer);
    PutPathIfNonEmpty(out, "cohereEncoder", paths.cohereEncoder);
    PutPathIfNonEmpty(out, "cohereDecoder", paths.cohereDecoder);
    PutPathIfNonEmpty(out, "moonshinePreprocessor", paths.moonshinePreprocessor);
    PutPathIfNonEmpty(out, "moonshineEncoder", paths.moonshineEncoder);
    PutPathIfNonEmpty(out, "moonshineUncachedDecoder", paths.moonshineUncachedDecoder);
    PutPathIfNonEmpty(out, "moonshineCachedDecoder", paths.moonshineCachedDecoder);
    PutPathIfNonEmpty(out, "moonshineMergedDecoder", paths.moonshineMergedDecoder);
    PutPathIfNonEmpty(out, "fireRedEncoder", paths.fireRedEncoder);
    PutPathIfNonEmpty(out, "fireRedDecoder", paths.fireRedDecoder);
    PutPathIfNonEmpty(out, "canaryEncoder", paths.canaryEncoder);
    PutPathIfNonEmpty(out, "canaryDecoder", paths.canaryDecoder);
    PutPathIfNonEmpty(out, "dolphinModel", paths.dolphinModel);
    PutPathIfNonEmpty(out, "omnilingualModel", paths.omnilingualModel);
    PutPathIfNonEmpty(out, "medasrModel", paths.medasrModel);
    PutPathIfNonEmpty(out, "telespeechCtcModel", paths.telespeechCtcModel);
    return out;
}

std::map<std::string, std::string> TtsModelPathsToStringMap(const TtsModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "ttsModel", paths.ttsModel);
    PutPathIfNonEmpty(out, "tokens", paths.tokens);
    PutPathIfNonEmpty(out, "lexicon", paths.lexicon);
    PutPathIfNonEmpty(out, "dataDir", paths.dataDir);
    PutPathIfNonEmpty(out, "voices", paths.voices);
    PutPathIfNonEmpty(out, "acousticModel", paths.acousticModel);
    PutPathIfNonEmpty(out, "vocoder", paths.vocoder);
    PutPathIfNonEmpty(out, "encoder", paths.encoder);
    PutPathIfNonEmpty(out, "decoder", paths.decoder);
    PutPathIfNonEmpty(out, "lmFlow", paths.lmFlow);
    PutPathIfNonEmpty(out, "lmMain", paths.lmMain);
    PutPathIfNonEmpty(out, "textConditioner", paths.textConditioner);
    PutPathIfNonEmpty(out, "vocabJson", paths.vocabJson);
    PutPathIfNonEmpty(out, "tokenScoresJson", paths.tokenScoresJson);
    PutPathIfNonEmpty(out, "durationPredictor", paths.durationPredictor);
    PutPathIfNonEmpty(out, "textEncoder", paths.textEncoder);
    PutPathIfNonEmpty(out, "vectorEstimator", paths.vectorEstimator);
    PutPathIfNonEmpty(out, "ttsJson", paths.ttsJson);
    PutPathIfNonEmpty(out, "unicodeIndexer", paths.unicodeIndexer);
    PutPathIfNonEmpty(out, "voiceStyle", paths.voiceStyle);
    return out;
}

std::map<std::string, std::string> VadModelPathsToStringMap(const VadModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "model", paths.model);
    return out;
}

std::map<std::string, std::string> EnhancementModelPathsToStringMap(
    const EnhancementModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "model", paths.model);
    return out;
}

std::map<std::string, std::string> SeparationModelPathsToStringMap(
    const SeparationModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "vocals", paths.vocals);
    PutPathIfNonEmpty(out, "accompaniment", paths.accompaniment);
    PutPathIfNonEmpty(out, "model", paths.model);
    return out;
}

std::map<std::string, std::string> PunctuationModelPathsToStringMap(
    const PunctuationModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "ct_transformer", paths.ct_transformer);
    PutPathIfNonEmpty(out, "cnn_bilstm", paths.cnn_bilstm);
    PutPathIfNonEmpty(out, "bpe_vocab", paths.bpe_vocab);
    return out;
}

std::map<std::string, std::string> AlignmentModelPathsToStringMap(
    const AlignmentModelPaths& paths) {
    std::map<std::string, std::string> out;
    PutPathIfNonEmpty(out, "model", paths.model);
    return out;
}

}  // namespace sherpaonnx
