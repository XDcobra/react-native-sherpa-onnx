#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include <android/log.h>
#include <cstdlib>
#include <string>
#include <algorithm>

#define LOG_TAG "SttModelDetect"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace sherpaonnx {
namespace {

SttModelKind ParseSttModelType(const std::string& modelType) {
    if (modelType == "transducer") return SttModelKind::kTransducer;
    if (modelType == "nemo_transducer") return SttModelKind::kNemoTransducer;
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
    const std::optional<std::string>& modelType,
    bool debug /* = false */
) {
    using namespace model_detect;

    SttDetectResult result;

    LOGI("DetectSttModel: modelDir=%s, modelType=%s, preferInt8=%s",
         modelDir.c_str(),
         modelType.has_value() ? modelType->c_str() : "auto",
         preferInt8.has_value() ? (preferInt8.value() ? "true" : "false") : "unset");

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        LOGE("%s", result.error.c_str());
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }

    const auto files = ListFilesRecursive(modelDir, 2);
    bool verbose = debug;
    LOGI("DetectSttModel: Found %zu files in %s (verbose=%d)", files.size(), modelDir.c_str(), (int)verbose);
    if (verbose) {
        for (const auto& f : files) {
            LOGI("  file: %s (size=%llu)", f.path.c_str(), (unsigned long long)f.size);
        }
    } else {
        LOGI("(detailed file listing suppressed; enable by passing debug=true to initialize())");
    }

    std::string encoderPath = FindOnnxByAnyToken(files, {"encoder"}, preferInt8);
    std::string decoderPath = FindOnnxByAnyToken(files, {"decoder"}, preferInt8);
    std::string joinerPath = FindOnnxByAnyToken(files, {"joiner"}, preferInt8);

    LOGI("DetectSttModel: encoder=%s, decoder=%s, joiner=%s",
         encoderPath.c_str(), decoderPath.c_str(), joinerPath.c_str());

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

    // Search for tokens file: first try exact "tokens.txt", then suffix match
    // (e.g. "tiny-tokens.txt" for Whisper models)
    std::string tokensPath = FindFileEndingWith(modelDir, "tokens.txt", 2);
    LOGI("DetectSttModel: tokens=%s", tokensPath.c_str());

    bool hasTransducer = !encoderPath.empty() && !decoderPath.empty() && !joinerPath.empty();

    bool hasWhisperEncoder = !encoderPath.empty();
    bool hasWhisperDecoder = !decoderPath.empty();
    bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty();

    bool hasFunAsrEncoderAdaptor = !funasrEncoderAdaptor.empty();
    bool hasFunAsrLLM = !funasrLLM.empty();
    bool hasFunAsrEmbedding = !funasrEmbedding.empty();
    bool hasFunAsrTokenizer = !funasrTokenizerDir.empty() && FileExists(funasrTokenizerDir + "/vocab.json");
    bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;

    bool isLikelyNemo = modelDir.find("nemo") != std::string::npos ||
                        modelDir.find("parakeet") != std::string::npos;
    bool isLikelyWenetCtc = modelDir.find("wenet") != std::string::npos;
    bool isLikelySenseVoice = modelDir.find("sense") != std::string::npos ||
                              modelDir.find("sensevoice") != std::string::npos;
    bool isLikelyFunAsrNano = modelDir.find("funasr") != std::string::npos ||
                              modelDir.find("funasr-nano") != std::string::npos;

    if (hasTransducer) {
        if (isLikelyNemo) {
            result.detectedModels.push_back({"nemo_transducer", modelDir});
        } else {
            result.detectedModels.push_back({"transducer", modelDir});
        }
    }

    if (!ctcModelPath.empty() && (isLikelyNemo || isLikelyWenetCtc || isLikelySenseVoice)) {
        if (isLikelyNemo) {
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
        if (selected == SttModelKind::kNemoTransducer && !hasTransducer) {
            result.error = "NeMo Transducer model requested but encoder/decoder/joiner not found in " + modelDir;
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
            selected = isLikelyNemo ? SttModelKind::kNemoTransducer : SttModelKind::kTransducer;
        } else if (!ctcModelPath.empty() && (isLikelyNemo || isLikelyWenetCtc || isLikelySenseVoice)) {
            if (isLikelyNemo) {
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
        LOGE("%s", result.error.c_str());
        return result;
    }

    LOGI("DetectSttModel: selected kind=%d", static_cast<int>(selected));
    result.selectedKind = selected;
    // sherpa-onnx's OfflineModelConfig::Validate() requires tokens for ALL models
    // except FunASR-nano (which uses its own tokenizer directory).
    // Whisper models also need tokens.txt despite seeming self-contained.
    result.tokensRequired = (selected != SttModelKind::kFunAsrNano);

    if (selected == SttModelKind::kTransducer || selected == SttModelKind::kNemoTransducer) {
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

    if (!tokensPath.empty() && FileExists(tokensPath)) {
        result.paths.tokens = tokensPath;
    } else if (result.tokensRequired) {
        result.error = "Tokens file not found in " + modelDir;
        LOGE("%s", result.error.c_str());
        return result;
    }

    LOGI("DetectSttModel: detection OK for %s — tokens=%s",
         modelDir.c_str(), result.paths.tokens.c_str());
    result.ok = true;
    return result;
}

} // namespace sherpaonnx
