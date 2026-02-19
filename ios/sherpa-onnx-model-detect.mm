#include "sherpa-onnx-model-detect.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace sherpaonnx {
namespace {

bool FileExists(const std::string& path) {
    return fs::exists(path);
}

bool IsDirectory(const std::string& path) {
    return fs::is_directory(path);
}

std::string ToLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string ResolveTokenizerDir(const std::string& modelDir) {
    std::string vocabInMain = modelDir + "/vocab.json";
    if (FileExists(vocabInMain)) {
        return modelDir;
    }

    try {
        for (const auto& entry : fs::directory_iterator(modelDir)) {
            if (entry.is_directory()) {
                std::string dirName = entry.path().filename().string();
                std::string dirNameLower = ToLower(dirName);
                if (dirNameLower.find("qwen3") != std::string::npos) {
                    std::string vocabPath = entry.path().string() + "/vocab.json";
                    if (FileExists(vocabPath)) {
                        return entry.path().string();
                    }
                }
            }
        }
    } catch (const std::exception&) {
    }

    std::string commonPath = modelDir + "/Qwen3-0.6B";
    if (FileExists(commonPath + "/vocab.json")) {
        return commonPath;
    }

    return "";
}

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
    return SttModelKind::kUnknown;
}

TtsModelKind ParseTtsModelType(const std::string& modelType) {
    if (modelType == "vits") return TtsModelKind::kVits;
    if (modelType == "matcha") return TtsModelKind::kMatcha;
    if (modelType == "kokoro") return TtsModelKind::kKokoro;
    if (modelType == "kitten") return TtsModelKind::kKitten;
    if (modelType == "zipvoice") return TtsModelKind::kZipvoice;
    return TtsModelKind::kUnknown;
}

} // namespace

SttDetectResult DetectSttModel(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType,
    bool debug /* = false */
) {
    SttDetectResult result;

    if (modelDir.empty()) {
        result.error = "Model directory is empty";
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    std::string encoderPath = modelDir + "/encoder.onnx";
    std::string decoderPath = modelDir + "/decoder.onnx";
    std::string joinerPath = modelDir + "/joiner.onnx";
    std::string encoderPathInt8 = modelDir + "/encoder.int8.onnx";
    std::string decoderPathInt8 = modelDir + "/decoder.int8.onnx";
    std::string paraformerPathInt8 = modelDir + "/model.int8.onnx";
    std::string paraformerPath = modelDir + "/model.onnx";
    std::string ctcPathInt8 = modelDir + "/model.int8.onnx";
    std::string ctcPath = modelDir + "/model.onnx";
    std::string tokensPath = modelDir + "/tokens.txt";

    std::string funasrEncoderAdaptor = modelDir + "/encoder_adaptor.onnx";
    std::string funasrEncoderAdaptorInt8 = modelDir + "/encoder_adaptor.int8.onnx";
    std::string funasrLLM = modelDir + "/llm.onnx";
    std::string funasrLLMInt8 = modelDir + "/llm.int8.onnx";
    std::string funasrEmbedding = modelDir + "/embedding.onnx";
    std::string funasrEmbeddingInt8 = modelDir + "/embedding.int8.onnx";

    std::string funasrTokenizerDir = ResolveTokenizerDir(modelDir);

    std::string moonshinePreprocess = modelDir + "/preprocess.onnx";
    std::string moonshineEncode = modelDir + "/encode.onnx";
    std::string moonshineUncachedDecode = modelDir + "/uncached_decode.onnx";
    std::string moonshineCachedDecode = modelDir + "/cached_decode.onnx";

    std::string paraformerModelPath;
    if (preferInt8.has_value()) {
        if (preferInt8.value()) {
            if (FileExists(paraformerPathInt8)) {
                paraformerModelPath = paraformerPathInt8;
            } else if (FileExists(paraformerPath)) {
                paraformerModelPath = paraformerPath;
            }
        } else {
            if (FileExists(paraformerPath)) {
                paraformerModelPath = paraformerPath;
            } else if (FileExists(paraformerPathInt8)) {
                paraformerModelPath = paraformerPathInt8;
            }
        }
    } else {
        if (FileExists(paraformerPathInt8)) {
            paraformerModelPath = paraformerPathInt8;
        } else if (FileExists(paraformerPath)) {
            paraformerModelPath = paraformerPath;
        }
    }

    std::string ctcModelPath;
    if (preferInt8.has_value()) {
        if (preferInt8.value()) {
            if (FileExists(ctcPathInt8)) {
                ctcModelPath = ctcPathInt8;
            } else if (FileExists(ctcPath)) {
                ctcModelPath = ctcPath;
            }
        } else {
            if (FileExists(ctcPath)) {
                ctcModelPath = ctcPath;
            } else if (FileExists(ctcPathInt8)) {
                ctcModelPath = ctcPathInt8;
            }
        }
    } else {
        if (FileExists(ctcPathInt8)) {
            ctcModelPath = ctcPathInt8;
        } else if (FileExists(ctcPath)) {
            ctcModelPath = ctcPath;
        }
    }

    bool hasTransducer = FileExists(encoderPath) &&
                         FileExists(decoderPath) &&
                         FileExists(joinerPath);

    bool hasWhisperEncoder = FileExists(encoderPath) || FileExists(encoderPathInt8);
    bool hasWhisperDecoder = FileExists(decoderPath) || FileExists(decoderPathInt8);
    bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && !FileExists(joinerPath);

    bool hasFunAsrEncoderAdaptor = FileExists(funasrEncoderAdaptor) || FileExists(funasrEncoderAdaptorInt8);
    bool hasFunAsrLLM = FileExists(funasrLLM) || FileExists(funasrLLMInt8);
    bool hasFunAsrEmbedding = FileExists(funasrEmbedding) || FileExists(funasrEmbeddingInt8);
    bool hasFunAsrTokenizer = !funasrTokenizerDir.empty() && FileExists(funasrTokenizerDir + "/vocab.json");
    bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;

    bool isLikelyNemoCtc = modelDir.find("nemo") != std::string::npos ||
                           modelDir.find("parakeet") != std::string::npos;
    bool isLikelyWenetCtc = modelDir.find("wenet") != std::string::npos;
    bool isLikelySenseVoice = modelDir.find("sense") != std::string::npos ||
                              modelDir.find("sensevoice") != std::string::npos;
    bool isLikelyFunAsrNano = modelDir.find("funasr") != std::string::npos ||
                              modelDir.find("funasr-nano") != std::string::npos;
    bool isLikelyZipformer = modelDir.find("zipformer") != std::string::npos;
    bool isLikelyNemoTransducer = modelDir.find("nemo") != std::string::npos && hasTransducer;
    bool isLikelyMoonshine = modelDir.find("moonshine") != std::string::npos;
    bool isLikelyDolphin = modelDir.find("dolphin") != std::string::npos;
    bool isLikelyFireRedAsr = modelDir.find("fire_red") != std::string::npos || modelDir.find("fire-red") != std::string::npos;
    bool isLikelyCanary = modelDir.find("canary") != std::string::npos;
    bool isLikelyOmnilingual = modelDir.find("omnilingual") != std::string::npos;
    bool isLikelyMedAsr = modelDir.find("medasr") != std::string::npos;
    bool isLikelyTeleSpeech = modelDir.find("telespeech") != std::string::npos;

    bool hasMoonshine = FileExists(moonshinePreprocess) && FileExists(moonshineEncode) &&
                        FileExists(moonshineUncachedDecode) && FileExists(moonshineCachedDecode);
    bool hasDolphin = isLikelyDolphin && !ctcModelPath.empty();
    bool hasFireRedAsr = hasTransducer && isLikelyFireRedAsr;
    bool hasCanary = hasTransducer && isLikelyCanary;
    bool hasOmnilingual = !ctcModelPath.empty() && isLikelyOmnilingual;
    bool hasMedAsr = !ctcModelPath.empty() && isLikelyMedAsr;
    bool hasTeleSpeechCtc = !ctcModelPath.empty() && isLikelyTeleSpeech;

    if (hasTransducer) {
        if (isLikelyNemoTransducer) {
            result.detectedModels.push_back({"nemo_transducer", modelDir});
        } else {
            result.detectedModels.push_back({isLikelyZipformer ? "zipformer" : "transducer", modelDir});
        }
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
             selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc) &&
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
    } else {
        if (hasTransducer) {
            selected = isLikelyNemoTransducer ? SttModelKind::kNemoTransducer : SttModelKind::kTransducer;
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

    if (selected == SttModelKind::kTransducer || selected == SttModelKind::kNemoTransducer) {
        result.paths.encoder = FileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
        result.paths.decoder = FileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
        result.paths.joiner = joinerPath;
    } else if (selected == SttModelKind::kParaformer) {
        result.paths.paraformerModel = paraformerModelPath;
    } else if (selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
               selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc) {
        result.paths.ctcModel = ctcModelPath;
    } else if (selected == SttModelKind::kWhisper) {
        result.paths.whisperEncoder = FileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
        result.paths.whisperDecoder = FileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
    } else if (selected == SttModelKind::kFunAsrNano) {
        result.paths.funasrEncoderAdaptor = FileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
        result.paths.funasrLLM = FileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
        result.paths.funasrEmbedding = FileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
        result.paths.funasrTokenizer = funasrTokenizerDir + "/vocab.json";
    } else if (selected == SttModelKind::kMoonshine) {
        result.paths.moonshinePreprocessor = moonshinePreprocess;
        result.paths.moonshineEncoder = moonshineEncode;
        result.paths.moonshineUncachedDecoder = moonshineUncachedDecode;
        result.paths.moonshineCachedDecoder = moonshineCachedDecode;
    } else if (selected == SttModelKind::kDolphin) {
        result.paths.dolphinModel = ctcModelPath.empty() ? paraformerModelPath : ctcModelPath;
    } else if (selected == SttModelKind::kFireRedAsr) {
        result.paths.fireRedEncoder = FileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
        result.paths.fireRedDecoder = FileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
    } else if (selected == SttModelKind::kCanary) {
        result.paths.canaryEncoder = FileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
        result.paths.canaryDecoder = FileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
    } else if (selected == SttModelKind::kOmnilingual) {
        result.paths.omnilingualModel = ctcModelPath;
    } else if (selected == SttModelKind::kMedAsr) {
        result.paths.medasrModel = ctcModelPath;
    } else if (selected == SttModelKind::kTeleSpeechCtc) {
        result.paths.telespeechCtcModel = ctcModelPath.empty() ? paraformerModelPath : ctcModelPath;
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

TtsDetectResult DetectTtsModel(const std::string& modelDir, const std::string& modelType) {
    TtsDetectResult result;

    if (modelDir.empty()) {
        result.error = "TTS: Model directory is empty";
        return result;
    }

    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "TTS: Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    std::string modelOnnx = modelDir + "/model.onnx";
    std::string modelFp16 = modelDir + "/model.fp16.onnx";
    std::string modelInt8 = modelDir + "/model.int8.onnx";
    std::string tokensFile = modelDir + "/tokens.txt";
    std::string lexiconFile = modelDir + "/lexicon.txt";
    std::string dataDirPath = modelDir + "/espeak-ng-data";
    std::string voicesFile = modelDir + "/voices.bin";
    std::string acousticModel = modelDir + "/acoustic_model.onnx";
    std::string vocoder = modelDir + "/vocoder.onnx";
    std::string encoder = modelDir + "/encoder.onnx";
    std::string decoder = modelDir + "/decoder.onnx";

    bool hasVits = FileExists(modelOnnx) || FileExists(modelFp16) || FileExists(modelInt8);
    bool hasMatcha = FileExists(acousticModel) && FileExists(vocoder);
    bool hasVoicesFile = FileExists(voicesFile);
    bool hasZipvoice = FileExists(encoder) && FileExists(decoder) && FileExists(vocoder);
    bool hasDataDir = IsDirectory(dataDirPath);

    std::string modelDirLower = ToLower(modelDir);
    bool isLikelyKitten = modelDirLower.find("kitten") != std::string::npos;
    bool isLikelyKokoro = modelDirLower.find("kokoro") != std::string::npos;

    if (hasMatcha) {
        result.detectedModels.push_back({"matcha", modelDir});
    }
    if (hasZipvoice && !hasMatcha) {
        result.detectedModels.push_back({"zipvoice", modelDir});
    }
    if (hasVoicesFile) {
        result.detectedModels.push_back({"kokoro", modelDir});
        result.detectedModels.push_back({"kitten", modelDir});
    }
    if (hasVits && !hasMatcha && !hasZipvoice && !hasVoicesFile) {
        result.detectedModels.push_back({"vits", modelDir});
    } else if (hasVits && hasVoicesFile) {
        result.detectedModels.push_back({"vits", modelDir});
    }

    TtsModelKind selected = TtsModelKind::kUnknown;
    if (modelType != "auto") {
        selected = ParseTtsModelType(modelType);
        if (selected == TtsModelKind::kUnknown) {
            result.error = "TTS: Unknown model type: " + modelType;
            return result;
        }
    } else {
        if (hasMatcha) {
            selected = TtsModelKind::kMatcha;
        } else if (hasZipvoice) {
            selected = TtsModelKind::kZipvoice;
        } else if (hasVoicesFile) {
            if (isLikelyKitten && !isLikelyKokoro) {
                selected = TtsModelKind::kKitten;
            } else if (isLikelyKokoro && !isLikelyKitten) {
                selected = TtsModelKind::kKokoro;
            } else {
                selected = TtsModelKind::kKokoro;
            }
        } else if (hasVits) {
            selected = TtsModelKind::kVits;
        }
    }

    if (selected == TtsModelKind::kUnknown) {
        result.error = "TTS: No compatible model type detected in " + modelDir;
        return result;
    }

    if (selected == TtsModelKind::kVits && !hasVits) {
        result.error = "TTS: VITS model requested but model.onnx not found in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kMatcha && !hasMatcha) {
        result.error = "TTS: Matcha model requested but required files not found in " + modelDir;
        return result;
    }
    if ((selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten) && (!hasVits || !hasVoicesFile)) {
        result.error = "TTS: Kokoro/Kitten model requested but required files not found in " + modelDir;
        return result;
    }
    if (selected == TtsModelKind::kZipvoice && !hasZipvoice) {
        result.error = "TTS: Zipvoice model requested but required files not found in " + modelDir;
        return result;
    }
    if ((selected == TtsModelKind::kVits || selected == TtsModelKind::kMatcha ||
         selected == TtsModelKind::kKokoro || selected == TtsModelKind::kKitten ||
         selected == TtsModelKind::kZipvoice) &&
        !hasDataDir) {
        result.error = "TTS: espeak-ng-data not found in " + modelDir +
                       ". Copy espeak-ng-data into the model directory.";
        return result;
    }

    std::string ttsModel;
    if (FileExists(modelInt8)) {
        ttsModel = modelInt8;
    } else if (FileExists(modelFp16)) {
        ttsModel = modelFp16;
    } else if (FileExists(modelOnnx)) {
        ttsModel = modelOnnx;
    }

    result.selectedKind = selected;
    result.paths.ttsModel = ttsModel;
    result.paths.tokens = tokensFile;
    result.paths.lexicon = FileExists(lexiconFile) ? lexiconFile : "";
    result.paths.dataDir = dataDirPath;
    result.paths.voices = voicesFile;
    result.paths.acousticModel = acousticModel;
    result.paths.vocoder = vocoder;
    result.paths.encoder = encoder;
    result.paths.decoder = decoder;

    if (!FileExists(tokensFile)) {
        result.error = "TTS: tokens.txt not found in " + modelDir;
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace sherpaonnx
