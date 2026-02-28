/**
 * sherpa-onnx-model-detect-stt.mm
 *
 * Purpose: Detects STT (speech-to-text) model type and fills SttModelPaths from a model directory.
 * Supports transducer, paraformer, whisper, and other STT variants. Used by the STT wrapper on iOS.
 */

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"

#include <string>

namespace sherpaonnx {
namespace {

using namespace model_detect;

SttModelKind ParseSttModelType(const std::string& modelType) {
    if (modelType == "transducer" || modelType == "zipformer") return SttModelKind::kTransducer;
    if (modelType == "nemo_transducer") return SttModelKind::kNemoTransducer;
    if (modelType == "paraformer") return SttModelKind::kParaformer;
    if (modelType == "nemo_ctc") return SttModelKind::kNemoCtc;
    if (modelType == "wenet_ctc") return SttModelKind::kWenetCtc;
    if (modelType == "sense_voice") return SttModelKind::kSenseVoice;
    if (modelType == "zipformer_ctc" || modelType == "ctc") return SttModelKind::kZipformerCtc;
    if (modelType == "whisper") return SttModelKind::kWhisper;
    if (modelType == "funasr_nano") return SttModelKind::kFunAsrNano;
    if (modelType == "fire_red_asr") return SttModelKind::kFireRedAsr;
    if (modelType == "moonshine") return SttModelKind::kMoonshine;
    if (modelType == "dolphin") return SttModelKind::kDolphin;
    if (modelType == "canary") return SttModelKind::kCanary;
    if (modelType == "omnilingual") return SttModelKind::kOmnilingual;
    if (modelType == "medasr") return SttModelKind::kMedAsr;
    if (modelType == "telespeech_ctc") return SttModelKind::kTeleSpeechCtc;
    if (modelType == "tone_ctc") return SttModelKind::kToneCtc;
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

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    const int kMaxSearchDepth = 4;
    const std::vector<FileEntry> files = ListFilesRecursive(modelDir, kMaxSearchDepth);

    std::string encoderPath = FindOnnxByAnyToken(files, {"encoder"}, preferInt8);
    std::string decoderPath = FindOnnxByAnyToken(files, {"decoder"}, preferInt8);
    std::string joinerPath = FindOnnxByAnyToken(files, {"joiner"}, preferInt8);
    std::string tokensPath = FindFileEndingWith(files, "tokens.txt");

    std::vector<std::string> modelExcludes = {
        "encoder", "decoder", "joiner", "vocoder", "acoustic", "embedding", "llm",
        "encoder_adaptor", "encoder-adaptor"
    };
    std::string paraformerModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (paraformerModelPath.empty()) {
        paraformerModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }
    std::string ctcModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (ctcModelPath.empty()) {
        ctcModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    std::string funasrEncoderAdaptor = FindOnnxByAnyToken(files, {"encoder_adaptor", "encoder-adaptor"}, preferInt8);
    std::string funasrLLM = FindOnnxByAnyToken(files, {"llm"}, preferInt8);
    std::string funasrEmbedding = FindOnnxByAnyToken(files, {"embedding"}, preferInt8);
    std::string funasrTokenizerDir = ResolveTokenizerDir(modelDir);

    std::string moonshinePreprocess = FindOnnxByAnyToken(files, {"preprocess", "preprocessor"}, preferInt8);
    std::string moonshineEncode = FindOnnxByAnyToken(files, {"encode"}, preferInt8);
    std::string moonshineUncachedDecode = FindOnnxByAnyToken(files, {"uncached_decode", "uncached"}, preferInt8);
    std::string moonshineCachedDecode = FindOnnxByAnyToken(files, {"cached_decode", "cached"}, preferInt8);

    bool hasTransducer = !encoderPath.empty() && !decoderPath.empty() && !joinerPath.empty();

    bool hasWhisperEncoder = !encoderPath.empty();
    bool hasWhisperDecoder = !decoderPath.empty();
    bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty();

    bool hasFunAsrEncoderAdaptor = !funasrEncoderAdaptor.empty();
    bool hasFunAsrLLM = !funasrLLM.empty();
    bool hasFunAsrEmbedding = !funasrEmbedding.empty();
    bool hasFunAsrTokenizer = !funasrTokenizerDir.empty() && FileExists(funasrTokenizerDir + "/vocab.json");
    bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;

    std::string modelDirLower = ToLower(modelDir);
    bool isLikelyNemo = modelDirLower.find("nemo") != std::string::npos ||
                        modelDirLower.find("parakeet") != std::string::npos;
    bool isLikelyTdt = modelDirLower.find("tdt") != std::string::npos;
    bool isLikelyWenetCtc = modelDirLower.find("wenet") != std::string::npos;
    bool isLikelySenseVoice = modelDirLower.find("sense") != std::string::npos ||
                              modelDirLower.find("sensevoice") != std::string::npos;
    bool isLikelyFunAsrNano = modelDirLower.find("funasr") != std::string::npos ||
                              modelDirLower.find("funasr-nano") != std::string::npos;
    bool isLikelyZipformer = modelDirLower.find("zipformer") != std::string::npos;
    bool isLikelyMoonshine = modelDirLower.find("moonshine") != std::string::npos;
    bool isLikelyDolphin = modelDirLower.find("dolphin") != std::string::npos;
    bool isLikelyFireRedAsr = modelDirLower.find("fire_red") != std::string::npos ||
                              modelDirLower.find("fire-red") != std::string::npos;
    bool isLikelyCanary = modelDirLower.find("canary") != std::string::npos;
    bool isLikelyOmnilingual = modelDirLower.find("omnilingual") != std::string::npos;
    bool isLikelyMedAsr = modelDirLower.find("medasr") != std::string::npos;
    bool isLikelyTeleSpeech = modelDirLower.find("telespeech") != std::string::npos;
    // Tone CTC: match "tone" only as standalone word (not e.g. "cantonese"); also accept "t-one" / "t_one"
    bool isLikelyToneCtc = modelDirLower.find("t-one") != std::string::npos ||
                           modelDirLower.find("t_one") != std::string::npos ||
                           ContainsWord(modelDirLower, "tone");

    bool hasMoonshine = !moonshinePreprocess.empty() && !moonshineUncachedDecode.empty() &&
                        !moonshineCachedDecode.empty() && !moonshineEncode.empty();
    bool hasDolphin = isLikelyDolphin && !ctcModelPath.empty();
    bool hasFireRedAsr = hasTransducer && isLikelyFireRedAsr;
    bool hasCanary = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty() && isLikelyCanary;
    bool hasOmnilingual = !ctcModelPath.empty() && isLikelyOmnilingual;
    bool hasMedAsr = !ctcModelPath.empty() && isLikelyMedAsr;
    bool hasTeleSpeechCtc = (!ctcModelPath.empty() || !paraformerModelPath.empty()) && isLikelyTeleSpeech;
    bool hasToneCtc = !ctcModelPath.empty() && isLikelyToneCtc;

    if (hasTransducer) {
        if (isLikelyNemo || isLikelyTdt) {
            result.detectedModels.push_back({"nemo_transducer", modelDir});
        } else {
            result.detectedModels.push_back({isLikelyZipformer ? "zipformer" : "transducer", modelDir});
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
    if (hasMoonshine) {
        result.detectedModels.push_back({"moonshine", modelDir});
    }
    if (hasDolphin) {
        result.detectedModels.push_back({"dolphin", modelDir});
    }
    if (hasFireRedAsr) {
        result.detectedModels.push_back({"fire_red_asr", modelDir});
    }
    if (hasCanary) {
        result.detectedModels.push_back({"canary", modelDir});
    }
    if (hasOmnilingual) {
        result.detectedModels.push_back({"omnilingual", modelDir});
    }
    if (hasMedAsr) {
        result.detectedModels.push_back({"medasr", modelDir});
    }
    if (hasTeleSpeechCtc) {
        result.detectedModels.push_back({"telespeech_ctc", modelDir});
    }
    if (hasToneCtc) {
        result.detectedModels.push_back({"tone_ctc", modelDir});
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
            result.error = "Paraformer model requested but model.onnx not found in " + modelDir;
            return result;
        }
        if ((selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
             selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc ||
             selected == SttModelKind::kToneCtc) &&
            ctcModelPath.empty()) {
            result.error = "CTC model requested but model.onnx not found in " + modelDir;
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
        if (selected == SttModelKind::kMoonshine && !hasMoonshine) {
            result.error = "Moonshine model requested but preprocess/encode/uncached_decode/cached_decode not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kDolphin && !hasDolphin) {
            result.error = "Dolphin model requested but model not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kFireRedAsr && !hasFireRedAsr) {
            result.error = "FireRed ASR model requested but encoder/decoder not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kCanary && !hasCanary) {
            result.error = "Canary model requested but encoder/decoder not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kOmnilingual && !hasOmnilingual) {
            result.error = "Omnilingual model requested but model not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kMedAsr && !hasMedAsr) {
            result.error = "MedASR model requested but model not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kTeleSpeechCtc && !hasTeleSpeechCtc) {
            result.error = "TeleSpeech CTC model requested but model not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kToneCtc && !hasToneCtc) {
            result.error = "Tone CTC model requested but path does not contain 'tone' (as a word), 't-one', or 't_one' (e.g. sherpa-onnx-streaming-t-one-*) in " + modelDir;
            return result;
        }
    } else {
        if (hasTransducer) {
            selected = (isLikelyNemo || isLikelyTdt) ? SttModelKind::kNemoTransducer : SttModelKind::kTransducer;
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
        } else if (hasCanary) {
            selected = SttModelKind::kCanary;
        } else if (hasFireRedAsr) {
            selected = SttModelKind::kFireRedAsr;
        } else if (hasWhisper) {
            selected = SttModelKind::kWhisper;
        } else if (hasFunAsrNano) {
            selected = SttModelKind::kFunAsrNano;
        } else if (hasMoonshine && isLikelyMoonshine) {
            selected = SttModelKind::kMoonshine;
        } else if (hasDolphin) {
            selected = SttModelKind::kDolphin;
        } else if (hasFireRedAsr) {
            selected = SttModelKind::kFireRedAsr;
        } else if (hasCanary) {
            selected = SttModelKind::kCanary;
        } else if (hasOmnilingual) {
            selected = SttModelKind::kOmnilingual;
        } else if (hasMedAsr) {
            selected = SttModelKind::kMedAsr;
        } else if (hasTeleSpeechCtc) {
            selected = SttModelKind::kTeleSpeechCtc;
        } else if (hasToneCtc) {
            selected = SttModelKind::kToneCtc;
        } else if (!ctcModelPath.empty()) {
            selected = SttModelKind::kZipformerCtc;
        }
    }

    if (selected == SttModelKind::kUnknown) {
        result.error = "No compatible model type detected in " + modelDir;
        return result;
    }

    result.selectedKind = selected;
    result.tokensRequired = (selected != SttModelKind::kFunAsrNano);

    if (selected == SttModelKind::kTransducer || selected == SttModelKind::kNemoTransducer) {
        result.paths.encoder = encoderPath;
        result.paths.decoder = decoderPath;
        result.paths.joiner = joinerPath;
    } else if (selected == SttModelKind::kParaformer) {
        result.paths.paraformerModel = paraformerModelPath;
    } else if (selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
               selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc ||
               selected == SttModelKind::kToneCtc) {
        result.paths.ctcModel = ctcModelPath;
    } else if (selected == SttModelKind::kWhisper) {
        result.paths.whisperEncoder = encoderPath;
        result.paths.whisperDecoder = decoderPath;
    } else if (selected == SttModelKind::kFunAsrNano) {
        result.paths.funasrEncoderAdaptor = funasrEncoderAdaptor;
        result.paths.funasrLLM = funasrLLM;
        result.paths.funasrEmbedding = funasrEmbedding;
        result.paths.funasrTokenizer = funasrTokenizerDir;
    } else if (selected == SttModelKind::kMoonshine) {
        result.paths.moonshinePreprocessor = moonshinePreprocess;
        result.paths.moonshineEncoder = moonshineEncode;
        result.paths.moonshineUncachedDecoder = moonshineUncachedDecode;
        result.paths.moonshineCachedDecoder = moonshineCachedDecode;
    } else if (selected == SttModelKind::kDolphin) {
        result.paths.dolphinModel = ctcModelPath.empty() ? paraformerModelPath : ctcModelPath;
    } else if (selected == SttModelKind::kFireRedAsr) {
        result.paths.fireRedEncoder = encoderPath;
        result.paths.fireRedDecoder = decoderPath;
    } else if (selected == SttModelKind::kCanary) {
        result.paths.canaryEncoder = encoderPath;
        result.paths.canaryDecoder = decoderPath;
    } else if (selected == SttModelKind::kOmnilingual) {
        result.paths.omnilingualModel = ctcModelPath;
    } else if (selected == SttModelKind::kMedAsr) {
        result.paths.medasrModel = ctcModelPath;
    } else if (selected == SttModelKind::kTeleSpeechCtc) {
        result.paths.telespeechCtcModel = ctcModelPath.empty() ? paraformerModelPath : ctcModelPath;
    }

    if (!tokensPath.empty() && FileExists(tokensPath)) {
        result.paths.tokens = tokensPath;
    } else if (result.tokensRequired) {
        result.error = "Tokens file not found in " + modelDir;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace sherpaonnx
