/**
 * sherpa-onnx-model-detect-stt.cpp
 *
 * Purpose: Detects STT model type and fills SttModelPaths from a model directory. Supports
 * transducer, paraformer, whisper, and other STT variants. Used by nativeDetectSttModel (module-jni).
 */
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

static const char* KindToName(SttModelKind k) {
    switch (k) {
        case SttModelKind::kTransducer: return "transducer";
        case SttModelKind::kNemoTransducer: return "nemo_transducer";
        case SttModelKind::kParaformer: return "paraformer";
        case SttModelKind::kNemoCtc: return "nemo_ctc";
        case SttModelKind::kWenetCtc: return "wenet_ctc";
        case SttModelKind::kSenseVoice: return "sense_voice";
        case SttModelKind::kZipformerCtc: return "zipformer_ctc";
        case SttModelKind::kWhisper: return "whisper";
        case SttModelKind::kFunAsrNano: return "funasr_nano";
        case SttModelKind::kFireRedAsr: return "fire_red_asr";
        case SttModelKind::kMoonshine: return "moonshine";
        case SttModelKind::kMoonshineV2: return "moonshine_v2";
        case SttModelKind::kDolphin: return "dolphin";
        case SttModelKind::kCanary: return "canary";
        case SttModelKind::kOmnilingual: return "omnilingual";
        case SttModelKind::kMedAsr: return "medasr";
        case SttModelKind::kTeleSpeechCtc: return "telespeech_ctc";
        case SttModelKind::kToneCtc: return "tone_ctc";
        default: return "unknown";
    }
}

static const char* EmptyOrPath(const std::string& s) {
    return s.empty() ? "(empty)" : s.c_str();
}

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
    if (modelType == "fire_red_asr") return SttModelKind::kFireRedAsr;
    if (modelType == "moonshine") return SttModelKind::kMoonshine;
    if (modelType == "moonshine_v2") return SttModelKind::kMoonshineV2;
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

    // Depth 4 supports layouts like root/data/lang_bpe_500/tokens.txt (icefall, k2)
    const int kMaxSearchDepth = 4;
    const auto files = ListFilesRecursive(modelDir, kMaxSearchDepth);
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

    std::string funasrEncoderAdaptor = FindOnnxByAnyToken(files, {"encoder_adaptor", "encoder-adaptor"}, preferInt8);
    std::string funasrLLM = FindOnnxByAnyToken(files, {"llm"}, preferInt8);
    std::string funasrEmbedding = FindOnnxByAnyToken(files, {"embedding"}, preferInt8);

    std::string funasrTokenizerDir = ResolveTokenizerDir(modelDir);

    // Moonshine v1: preprocess, encode, uncached_decode, cached_decode (e.g. preprocess.onnx, encode.int8.onnx, ...)
    // Moonshine v2: encoder + merged decoder (e.g. encoder_model.ort, decoder_model_merged.ort or merged_decode.onnx)
    std::string moonshinePreprocessor = FindOnnxByAnyToken(files, {"preprocess", "preprocessor"}, preferInt8);
    std::string moonshineEncoder = FindOnnxByAnyToken(files, {"encode", "encoder_model"}, preferInt8);
    std::string moonshineUncachedDecoder = FindOnnxByAnyToken(files, {"uncached_decode", "uncached"}, preferInt8);
    // Cached decoder must NOT match uncached_decode (e.g. "cached_decode" is substring of "uncached_decode").
    std::string moonshineCachedDecoder = model_detect::FindOnnxByAnyTokenExcluding(
        files, std::vector<std::string>{"cached_decode", "cached"}, std::vector<std::string>{"uncached"}, preferInt8);
    std::string moonshineMergedDecoder = FindOnnxByAnyToken(files, {"merged_decode", "merged_decoder", "decoder_model_merged", "merged"}, preferInt8);

    std::vector<std::string> modelExcludes = {
        "encoder",
        "decoder",
        "joiner",
        "vocoder",
        "acoustic",
        "embedding",
        "llm",
        "encoder_adaptor",
        "encoder-adaptor",
        "encoder_model",
        "decoder_model",
        "merged_decoder",
        "decoder_model_merged",
        "preprocess",
        "encode",
        "uncached",
        "cached"
    };

    std::string paraformerModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    // Don't use encoder/decoder-style files (e.g. encoder_model.ort, decoder_model_merged.ort) as paraformer model
    if (!paraformerModelPath.empty()) {
        std::string pLower = model_detect::ToLower(paraformerModelPath);
        if (pLower.find("encoder_model") != std::string::npos ||
            pLower.find("decoder_model") != std::string::npos ||
            pLower.find("merged_decoder") != std::string::npos) {
            paraformerModelPath.clear();
        }
    }
    if (paraformerModelPath.empty()) {
        paraformerModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    std::string ctcModelPath = FindOnnxByAnyToken(files, {"model"}, preferInt8);
    if (!ctcModelPath.empty()) {
        std::string cLower = model_detect::ToLower(ctcModelPath);
        if (cLower.find("encoder_model") != std::string::npos ||
            cLower.find("decoder_model") != std::string::npos ||
            cLower.find("merged_decoder") != std::string::npos) {
            ctcModelPath.clear();
        }
    }
    if (ctcModelPath.empty()) {
        ctcModelPath = FindLargestOnnxExcludingTokens(files, modelExcludes);
    }

    // Search for tokens file: first try exact "tokens.txt", then suffix match
    // (e.g. "tiny-tokens.txt" for Whisper models). Use same depth as file list
    // so layouts like root/data/lang_bpe_500/tokens.txt (icefall) are found.
    std::string tokensPath = FindFileEndingWith(modelDir, "tokens.txt", kMaxSearchDepth);
    LOGI("DetectSttModel: tokens=%s", tokensPath.c_str());

    // Optional: BPE vocabulary for hotwords (sentencepiece bpe.vocab). Used when modeling_unit is bpe or cjkchar+bpe.
    std::string bpeVocabPath = FindFileByName(modelDir, "bpe.vocab", kMaxSearchDepth);

    // Log all detected paths so missing files are obvious when debugging (empty => "(empty)").
    LOGI("DetectSttModel: transducer encoder=%s decoder=%s joiner=%s",
         EmptyOrPath(encoderPath), EmptyOrPath(decoderPath), EmptyOrPath(joinerPath));
    LOGI("DetectSttModel: paraformerModel=%s ctcModel=%s tokens=%s bpeVocab=%s",
         EmptyOrPath(paraformerModelPath), EmptyOrPath(ctcModelPath), EmptyOrPath(tokensPath), EmptyOrPath(bpeVocabPath));
    LOGI("DetectSttModel: moonshine preprocessor=%s encoder=%s uncachedDecoder=%s cachedDecoder=%s mergedDecoder=%s",
         EmptyOrPath(moonshinePreprocessor), EmptyOrPath(moonshineEncoder), EmptyOrPath(moonshineUncachedDecoder),
         EmptyOrPath(moonshineCachedDecoder), EmptyOrPath(moonshineMergedDecoder));
    LOGI("DetectSttModel: whisper encoder=%s decoder=%s (same as transducer; joiner empty => whisper)",
         EmptyOrPath(encoderPath), EmptyOrPath(decoderPath));
    LOGI("DetectSttModel: funasr encoderAdaptor=%s llm=%s embedding=%s tokenizerDir=%s",
         EmptyOrPath(funasrEncoderAdaptor), EmptyOrPath(funasrLLM), EmptyOrPath(funasrEmbedding), EmptyOrPath(funasrTokenizerDir));

    bool hasTransducer = !encoderPath.empty() && !decoderPath.empty() && !joinerPath.empty();

    bool hasWhisperEncoder = !encoderPath.empty();
    bool hasWhisperDecoder = !decoderPath.empty();
    bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty();

    bool hasFunAsrEncoderAdaptor = !funasrEncoderAdaptor.empty();
    bool hasFunAsrLLM = !funasrLLM.empty();
    bool hasFunAsrEmbedding = !funasrEmbedding.empty();
    bool hasFunAsrTokenizer = !funasrTokenizerDir.empty() && FileExists(funasrTokenizerDir + "/vocab.json");
    bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;

    // Case-insensitive path hints so "Nemo parakeet Tdt CTC 110m EN" etc. are recognized
    std::string modelDirLower = model_detect::ToLower(modelDir);
    bool isLikelyNemo = modelDirLower.find("nemo") != std::string::npos ||
                        modelDirLower.find("parakeet") != std::string::npos;
    bool isLikelyTdt = modelDirLower.find("tdt") != std::string::npos;
    bool isLikelyWenetCtc = modelDirLower.find("wenet") != std::string::npos;
    bool isLikelySenseVoice = modelDirLower.find("sense") != std::string::npos ||
                              modelDirLower.find("sensevoice") != std::string::npos;
    bool isLikelyFunAsrNano = modelDirLower.find("funasr") != std::string::npos ||
                              modelDirLower.find("funasr-nano") != std::string::npos;
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
                           model_detect::ContainsWord(modelDirLower, "tone");

    bool hasMoonshine = !moonshinePreprocessor.empty() && !moonshineUncachedDecoder.empty() &&
                        !moonshineCachedDecoder.empty() && !moonshineEncoder.empty();
    // Moonshine v2: encoder (encoder.onnx / encoder_model.ort) + merged decoder (merged_decode.* / decoder_model_merged.ort); no joiner (distinguishes from transducer).
    std::string encoderForV2 = encoderPath.empty() ? FindOnnxByAnyToken(files, {"encoder", "encoder_model"}, preferInt8) : encoderPath;
    bool hasMoonshineV2 = !moonshineMergedDecoder.empty() && !encoderForV2.empty() && joinerPath.empty();
    bool hasDolphin = isLikelyDolphin && !ctcModelPath.empty();

    LOGI("DetectSttModel: hasTransducer=%d hasWhisper=%d hasMoonshine=%d hasMoonshineV2=%d hasParaformer=%d hasFunAsrNano=%d",
         (int)hasTransducer, (int)hasWhisper, (int)hasMoonshine, (int)hasMoonshineV2,
         (int)(!paraformerModelPath.empty()), (int)hasFunAsrNano);
    LOGI("DetectSttModel: isLikelyMoonshine=%d isLikelyNemo=%d isLikelyWenetCtc=%d isLikelySenseVoice=%d",
         (int)isLikelyMoonshine, (int)isLikelyNemo, (int)isLikelyWenetCtc, (int)isLikelySenseVoice);
    bool hasFireRedAsr = hasTransducer && isLikelyFireRedAsr;
    // Canary (NeMo Canary) uses encoder + decoder without joiner; same file pattern as Whisper but path contains "canary"
    bool hasCanary = hasWhisperEncoder && hasWhisperDecoder && joinerPath.empty() && isLikelyCanary;
    bool hasOmnilingual = !ctcModelPath.empty() && isLikelyOmnilingual;
    bool hasMedAsr = !ctcModelPath.empty() && isLikelyMedAsr;
    bool hasTeleSpeechCtc = (!ctcModelPath.empty() || !paraformerModelPath.empty()) && isLikelyTeleSpeech;
    bool hasToneCtc = !ctcModelPath.empty() && isLikelyToneCtc;

    if (hasTransducer) {
        if (isLikelyNemo || isLikelyTdt) {
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
    if (hasMoonshine) {
        result.detectedModels.push_back({"moonshine", modelDir});
    }
    if (hasMoonshineV2) {
        result.detectedModels.push_back({"moonshine_v2", modelDir});
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
            result.error = "Paraformer model requested but model file not found in " + modelDir;
            return result;
        }
        if ((selected == SttModelKind::kNemoCtc || selected == SttModelKind::kWenetCtc ||
             selected == SttModelKind::kSenseVoice || selected == SttModelKind::kZipformerCtc ||
             selected == SttModelKind::kToneCtc) &&
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
        if (selected == SttModelKind::kMoonshine && !hasMoonshine) {
            result.error = "Moonshine v1 model requested but preprocess/encode/uncached_decode/cached_decode not found in " + modelDir;
            return result;
        }
        if (selected == SttModelKind::kMoonshineV2 && !hasMoonshineV2) {
            result.error = "Moonshine v2 model requested but encoder/merged_decode not found in " + modelDir;
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
        } else if (isLikelyMoonshine && hasMoonshineV2) {
            selected = SttModelKind::kMoonshineV2;
        } else if (isLikelyMoonshine && hasMoonshine) {
            selected = SttModelKind::kMoonshine;
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
        } else if (hasMoonshineV2) {
            selected = SttModelKind::kMoonshineV2;
        } else if (hasDolphin) {
            selected = SttModelKind::kDolphin;
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
        LOGE("%s", result.error.c_str());
        return result;
    }

    LOGI("DetectSttModel: selected kind=%d (%s)", static_cast<int>(selected), KindToName(selected));
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
        // FunASR Nano C++ expects tokenizer directory (e.g. .../Qwen3-0.6B), not path to vocab.json
        result.paths.funasrTokenizer = funasrTokenizerDir;
    } else if (selected == SttModelKind::kMoonshine) {
        result.paths.moonshinePreprocessor = moonshinePreprocessor;
        result.paths.moonshineEncoder = moonshineEncoder;
        result.paths.moonshineUncachedDecoder = moonshineUncachedDecoder;
        result.paths.moonshineCachedDecoder = moonshineCachedDecoder;
    } else if (selected == SttModelKind::kMoonshineV2) {
        result.paths.moonshineEncoder = encoderForV2;
        result.paths.moonshineMergedDecoder = moonshineMergedDecoder;
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
        LOGE("%s", result.error.c_str());
        return result;
    }

    if (!bpeVocabPath.empty() && FileExists(bpeVocabPath)) {
        result.paths.bpeVocab = bpeVocabPath;
    }

    // Log paths actually set for the selected kind (so we can verify nothing is missing).
    switch (selected) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
            LOGI("DetectSttModel: paths set encoder=%s decoder=%s joiner=%s",
                 EmptyOrPath(result.paths.encoder), EmptyOrPath(result.paths.decoder), EmptyOrPath(result.paths.joiner));
            break;
        case SttModelKind::kParaformer:
            LOGI("DetectSttModel: paths set paraformerModel=%s", EmptyOrPath(result.paths.paraformerModel));
            break;
        case SttModelKind::kWhisper:
            LOGI("DetectSttModel: paths set whisperEncoder=%s whisperDecoder=%s",
                 EmptyOrPath(result.paths.whisperEncoder), EmptyOrPath(result.paths.whisperDecoder));
            break;
        case SttModelKind::kMoonshine:
            LOGI("DetectSttModel: paths set moonshine preprocessor=%s encoder=%s uncachedDecoder=%s cachedDecoder=%s",
                 EmptyOrPath(result.paths.moonshinePreprocessor), EmptyOrPath(result.paths.moonshineEncoder),
                 EmptyOrPath(result.paths.moonshineUncachedDecoder), EmptyOrPath(result.paths.moonshineCachedDecoder));
            break;
        case SttModelKind::kMoonshineV2:
            LOGI("DetectSttModel: paths set moonshine_v2 encoder=%s mergedDecoder=%s",
                 EmptyOrPath(result.paths.moonshineEncoder), EmptyOrPath(result.paths.moonshineMergedDecoder));
            break;
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kSenseVoice:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            LOGI("DetectSttModel: paths set ctcModel=%s", EmptyOrPath(result.paths.ctcModel));
            break;
        case SttModelKind::kFunAsrNano:
            LOGI("DetectSttModel: paths set funasr adaptor=%s llm=%s embedding=%s tokenizer=%s",
                 EmptyOrPath(result.paths.funasrEncoderAdaptor), EmptyOrPath(result.paths.funasrLLM),
                 EmptyOrPath(result.paths.funasrEmbedding), EmptyOrPath(result.paths.funasrTokenizer));
            break;
        default:
            break;
    }
    LOGI("DetectSttModel: tokens=%s (required=%d)", EmptyOrPath(result.paths.tokens), (int)result.tokensRequired);
    LOGI("DetectSttModel: detection OK for %s", modelDir.c_str());
    result.ok = true;
    return result;
}

} // namespace sherpaonnx
