#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

namespace sherpaonnx {
namespace {

SttModelKind ParseSttModelType(const std::string& modelType) {
    if (modelType == "transducer") return SttModelKind::kTransducer;
    if (modelType == "paraformer") return SttModelKind::kParaformer;
    if (modelType == "nemo_ctc") return SttModelKind::kNemoCtc;
    if (modelType == "wenet_ctc") return SttModelKind::kWenetCtc;
    if (modelType == "sense_voice") return SttModelKind::kSenseVoice;
    if (modelType == "zipformer_ctc" || modelType == "ctc") return SttModelKind::kZipformerCtc;
    if (modelType == "whisper") return SttModelKind::kWhisper;
    if (modelType == "funasr_nano") return SttModelKind::kFunAsrNano;
    return SttModelKind::kUnknown;
}

} // namespace

SttDetectResult DetectSttModel(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType
) {
    using namespace model_detect;

    SttDetectResult result;

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const auto files = ListFiles(modelDir);

    std::string encoderPath = FindOnnxByAnyToken(files, {"encoder"}, preferInt8);
    std::string decoderPath = FindOnnxByAnyToken(files, {"decoder"}, preferInt8);
    std::string joinerPath = FindOnnxByAnyToken(files, {"joiner"}, preferInt8);

    std::string funasrEncoderAdaptor = FindOnnxByAnyToken(files, {"encoder_adaptor", "encoder-adaptor"}, preferInt8);
    std::string funasrLLM = FindOnnxByAnyToken(files, {"llm"}, preferInt8);
    std::string funasrEmbedding = FindOnnxByAnyToken(files, {"embedding"}, preferInt8);

    std::string funasrTokenizerDir = ResolveTokenizerDir(modelDir);

    std::vector<std::string> modelExcludes = {
        "encoder",
        "decoder",
        "joiner",
        "vocoder",
        "acoustic",
        "embedding",
        "llm",
        "encoder_adaptor",
        "encoder-adaptor"
    };

    std::string paraformerModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (paraformerModelPath.empty()) {
        paraformerModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    std::string ctcModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (ctcModelPath.empty()) {
        ctcModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    std::string tokensPath = modelDir + "/tokens.txt";

    bool hasTransducer = !encoderPath.empty() && !decoderPath.empty() && !joinerPath.empty();

    bool hasWhisperEncoder = !encoderPath.empty();
    bool hasWhisperDecoder = !decoderPath.empty();
    bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty();

    bool hasFunAsrEncoderAdaptor = !funasrEncoderAdaptor.empty();
    bool hasFunAsrLLM = !funasrLLM.empty();
    bool hasFunAsrEmbedding = !funasrEmbedding.empty();
    bool hasFunAsrTokenizer = !funasrTokenizerDir.empty() && FileExists(funasrTokenizerDir + "/vocab.json");
    bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;

    bool isLikelyNemoCtc = modelDir.find("nemo") != std::string::npos ||
                           modelDir.find("parakeet") != std::string::npos;
    bool isLikelyWenetCtc = modelDir.find("wenet") != std::string::npos;
    bool isLikelySenseVoice = modelDir.find("sense") != std::string::npos ||
                              modelDir.find("sensevoice") != std::string::npos;
    bool isLikelyFunAsrNano = modelDir.find("funasr") != std::string::npos ||
                              modelDir.find("funasr-nano") != std::string::npos;

    if (hasTransducer) {
        result.detectedModels.push_back({"transducer", modelDir});
    }

    if (!ctcModelPath.empty() && (isLikelyNemoCtc || isLikelyWenetCtc || isLikelySenseVoice)) {
        if (isLikelyNemoCtc) {
            result.detectedModels.push_back({"nemo_ctc", modelDir});
        } else if (isLikelyWenetCtc) {
            result.detectedModels.push_back({"wenet_ctc", modelDir});
        } else if (isLikelySenseVoice) {
            result.detectedModels.push_back({"sense_voice", modelDir});
        } else {
            result.detectedModels.push_back({"ctc", modelDir});
        }
    } else if (!paraformerModelPath.empty()) {
        result.detectedModels.push_back({"paraformer", modelDir});
    }

    if (hasWhisper) {
        result.detectedModels.push_back({"whisper", modelDir});
    }

    if (hasFunAsrNano) {
        result.detectedModels.push_back({"funasr_nano", modelDir});
    }

    SttModelKind selected = SttModelKind::kUnknown;

    if (modelType.has_value() && modelType.value() != "auto") {
        selected = ParseSttModelType(modelType.value());
        if (selected == SttModelKind::kUnknown) {
            result.error = "Unknown model type: " + modelType.value();
            return result;
        }

        if (selected == SttModelKind::kTransducer && !hasTransducer) {
            result.error = "Transducer model requested but files not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kParaformer && paraformerModelPath.empty()) {
            result.error = "Paraformer model requested but model file not found in " + modelDir;
            return result;
        }
        if ((selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
             selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc) &&
            ctcModelPath.empty()) {
            result.error = "CTC model requested but model file not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kWhisper && !hasWhisper) {
            result.error = "Whisper model requested but encoder/decoder not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kFunAsrNano && !hasFunAsrNano) {
            result.error = "FunASR Nano model requested but required files not found in " + modelDir;
            return result;
        }
    } else {
        if (hasTransducer) {
            selected = SttModelKind::kTransducer;
        } else if (!ctcModelPath.empty() && (isLikelyNemoCtc || isLikelyWenetCtc || isLikelySenseVoice)) {
            if (isLikelyNemoCtc) {
                selected = SttModelKind::kNemoCtc;
            } else if (isLikelyWenetCtc) {
                selected = SttModelKind::kWenetCtc;
            } else {
                selected = SttModelKind::kSenseVoice;
            }
        } else if (hasFunAsrNano && isLikelyFunAsrNano) {
            selected = SttModelKind::kFunAsrNano;
        } else if (!paraformerModelPath.empty()) {
            selected = SttModelKind::kParaformer;
        } else if (hasWhisper) {
            selected = SttModelKind::kWhisper;
        } else if (hasFunAsrNano) {
            selected = SttModelKind::kFunAsrNano;
        } else if (!ctcModelPath.empty()) {
            selected = SttModelKind::kZipformerCtc;
        }
    }

    if (selected == SttModelKind::kUnknown) {
        result.error = "No compatible model type detected in " + modelDir;
        return result;
    }

    result.selectedKind = selected;
    result.tokensRequired = !(selected == SttModelKind::kWhisper || selected == SttModelKind::kFunAsrNano);

    if (selected == SttModelKind::kTransducer) {
        result.paths.encoder = encoderPath;
        result.paths.decoder = decoderPath;
        result.paths.joiner = joinerPath;
    } else if (selected == SttModelKind::kParaformer) {
        result.paths.paraformerModel = paraformerModelPath;
    } else if (selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
               selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc) {
        result.paths.ctcModel = ctcModelPath;
    } else if (selected == SttModelKind::kWhisper) {
        result.paths.whisperEncoder = encoderPath;
        result.paths.whisperDecoder = decoderPath;
    } else if (selected == SttModelKind::kFunAsrNano) {
        result.paths.funasrEncoderAdaptor = funasrEncoderAdaptor;
        result.paths.funasrLLM = funasrLLM;
        result.paths.funasrEmbedding = funasrEmbedding;
        result.paths.funasrTokenizer = funasrTokenizerDir + "/vocab.json";
    }

    if (FileExists(tokensPath)) {
        result.paths.tokens = tokensPath;
    } else if (result.tokensRequired) {
        result.error = "Tokens file not found at " + tokensPath;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace sherpaonnx
