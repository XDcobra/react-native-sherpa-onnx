#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <optional>
#include <sstream>
#include <cstdint>
#include <limits>

// iOS logging
#ifdef __APPLE__
#include <Foundation/Foundation.h>
#include <cstdio>
#define LOGI(fmt, ...) NSLog(@"SttWrapper: " fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) NSLog(@"SttWrapper ERROR: " fmt, ##__VA_ARGS__)
#else
#define LOGI(...)
#define LOGE(...)
#endif

// Use C++17 filesystem (podspec enforces C++17)
#include <filesystem>
namespace fs = std::filesystem;

// sherpa-onnx headers - use C++ API (RAII wrapper around C API)
#include "sherpa-onnx/c-api/cxx-api.h"

namespace sherpaonnx {

// Hotwords are only supported for transducer models (sherpa-onnx limitation).
static bool SupportsHotwords(sherpaonnx::SttModelKind kind) {
    return kind == sherpaonnx::SttModelKind::kTransducer || kind == sherpaonnx::SttModelKind::kNemoTransducer;
}

// Returns error message if hotwords file is invalid, else empty optional.
static std::optional<std::string> ValidateHotwordsFile(const std::string& filePath) {
    if (filePath.empty()) return std::nullopt;
    try {
        if (!fs::exists(filePath)) return "Hotwords file does not exist: " + filePath;
        if (!fs::is_regular_file(filePath)) return "Hotwords path is not a file: " + filePath;
        std::ifstream f(filePath, std::ios::binary);
        if (!f) return "Hotwords file is not readable: " + filePath;
        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        f.close();
        if (content.find('\0') != std::string::npos) return "Hotwords file contains null bytes (not a valid text file).";
        int validLines = 0;
        std::istringstream stream(content);
        std::string line;
        while (std::getline(stream, line, '\n')) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            size_t start = 0;
            while (start < line.size() && (line[start] == ' ' || line[start] == '\t')) start++;
            size_t end = line.size();
            while (end > start && (line[end - 1] == ' ' || line[end - 1] == '\t')) end--;
            if (start >= end) continue;
            line = line.substr(start, end - start);
            size_t spaceColon = line.rfind(" :");
            if (spaceColon != std::string::npos) {
                std::string scoreStr = line.substr(spaceColon + 2);
                try {
                    (void)std::stof(scoreStr);
                } catch (...) {
                    return "Invalid hotword line (score must be a number after ' :'): " + line.substr(0, 60) + "…";
                }
            }
            validLines++;
        }
        if (validLines == 0) return "Hotwords file has no valid lines (one hotword or phrase per line, UTF-8 text).";
        return std::nullopt;
    } catch (const std::exception& e) {
        return std::string("Failed to read hotwords file: ") + e.what();
    }
}

// PIMPL pattern implementation
class SttWrapper::Impl {
public:
    bool initialized = false;
    std::string modelDir;
    sherpaonnx::SttModelKind currentModelKind = sherpaonnx::SttModelKind::kUnknown;
    std::optional<sherpa_onnx::cxx::OfflineRecognizer> recognizer;
    std::optional<sherpa_onnx::cxx::OfflineRecognizerConfig> lastConfig;
};

SttWrapper::SttWrapper() : pImpl(std::make_unique<Impl>()) {
    LOGI("SttWrapper created");
}

SttWrapper::~SttWrapper() {
    release();
    LOGI("SttWrapper destroyed");
}

SttInitializeResult SttWrapper::initialize(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType,
    bool debug,
    const std::optional<std::string>& hotwordsFile,
    const std::optional<float>& hotwordsScore,
    const std::optional<int32_t>& numThreads,
    const std::optional<std::string>& provider,
    const std::optional<std::string>& ruleFsts,
    const std::optional<std::string>& ruleFars,
    const std::optional<float>& dither,
    const SttWhisperOptions* whisperOpts,
    const SttSenseVoiceOptions* senseVoiceOpts,
    const SttCanaryOptions* canaryOpts,
    const SttFunAsrNanoOptions* funasrNanoOpts
) {
    SttInitializeResult result;
    result.success = false;

    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("Model directory is empty");
        return result;
    }

    try {
        sherpa_onnx::cxx::OfflineRecognizerConfig config;
        config.feat_config.sample_rate = 16000;
        config.feat_config.feature_dim = 80;

        auto detect = DetectSttModel(modelDir, preferInt8, modelType, debug);
        if (!detect.ok) {
            LOGE("%s", detect.error.c_str());
            return result;
        }

        switch (detect.selectedKind) {
            case SttModelKind::kTransducer:
            case SttModelKind::kNemoTransducer:
                config.model_config.transducer.encoder = detect.paths.encoder;
                config.model_config.transducer.decoder = detect.paths.decoder;
                config.model_config.transducer.joiner = detect.paths.joiner;
                break;
            case SttModelKind::kParaformer:
                config.model_config.paraformer.model = detect.paths.paraformerModel;
                break;
            case SttModelKind::kNemoCtc:
                config.model_config.nemo_ctc.model = detect.paths.ctcModel;
                break;
            case SttModelKind::kWenetCtc:
                config.model_config.wenet_ctc.model = detect.paths.ctcModel;
                break;
            case SttModelKind::kSenseVoice:
                config.model_config.sense_voice.model = detect.paths.ctcModel;
                break;
            case SttModelKind::kZipformerCtc:
                config.model_config.zipformer_ctc.model = detect.paths.ctcModel;
                break;
            case SttModelKind::kWhisper:
                config.model_config.whisper.encoder = detect.paths.whisperEncoder;
                config.model_config.whisper.decoder = detect.paths.whisperDecoder;
                break;
            case SttModelKind::kFunAsrNano:
                config.model_config.funasr_nano.encoder_adaptor = detect.paths.funasrEncoderAdaptor;
                config.model_config.funasr_nano.llm = detect.paths.funasrLLM;
                config.model_config.funasr_nano.embedding = detect.paths.funasrEmbedding;
                config.model_config.funasr_nano.tokenizer = detect.paths.funasrTokenizer;
                break;
            case SttModelKind::kFireRedAsr:
                config.model_config.fire_red_asr.encoder = detect.paths.fireRedEncoder;
                config.model_config.fire_red_asr.decoder = detect.paths.fireRedDecoder;
                break;
            case SttModelKind::kMoonshine:
                config.model_config.moonshine.preprocessor = detect.paths.moonshinePreprocessor;
                config.model_config.moonshine.encoder = detect.paths.moonshineEncoder;
                config.model_config.moonshine.uncached_decoder = detect.paths.moonshineUncachedDecoder;
                config.model_config.moonshine.cached_decoder = detect.paths.moonshineCachedDecoder;
                break;
            case SttModelKind::kDolphin:
                config.model_config.dolphin.model = detect.paths.dolphinModel;
                break;
            case SttModelKind::kCanary:
                config.model_config.canary.encoder = detect.paths.canaryEncoder;
                config.model_config.canary.decoder = detect.paths.canaryDecoder;
                break;
            case SttModelKind::kOmnilingual:
                config.model_config.omnilingual.model = detect.paths.omnilingualModel;
                break;
            case SttModelKind::kMedAsr:
                config.model_config.medasr.model = detect.paths.medasrModel;
                break;
            case SttModelKind::kTeleSpeechCtc:
                config.model_config.telespeech_ctc = detect.paths.telespeechCtcModel;
                break;
            case SttModelKind::kUnknown:
            default:
                LOGE("No compatible model type detected in %s", modelDir.c_str());
                return result;
        }

        if (!detect.paths.tokens.empty()) {
            config.model_config.tokens = detect.paths.tokens;
        }

        // Apply model-specific options (only for the loaded model type).
        switch (detect.selectedKind) {
            case SttModelKind::kWhisper:
                if (whisperOpts) {
                    if (whisperOpts->language.has_value())
                        config.model_config.whisper.language = *whisperOpts->language;
                    if (whisperOpts->task.has_value())
                        config.model_config.whisper.task = *whisperOpts->task;
                    if (whisperOpts->tail_paddings.has_value())
                        config.model_config.whisper.tail_paddings = *whisperOpts->tail_paddings;
                }
                break;
            case SttModelKind::kSenseVoice:
                if (senseVoiceOpts) {
                    if (senseVoiceOpts->language.has_value())
                        config.model_config.sense_voice.language = *senseVoiceOpts->language;
                    if (senseVoiceOpts->use_itn.has_value())
                        config.model_config.sense_voice.use_itn = *senseVoiceOpts->use_itn;
                }
                break;
            case SttModelKind::kCanary:
                if (canaryOpts) {
                    if (canaryOpts->src_lang.has_value())
                        config.model_config.canary.src_lang = *canaryOpts->src_lang;
                    if (canaryOpts->tgt_lang.has_value())
                        config.model_config.canary.tgt_lang = *canaryOpts->tgt_lang;
                    if (canaryOpts->use_pnc.has_value())
                        config.model_config.canary.use_pnc = *canaryOpts->use_pnc;
                }
                break;
            case SttModelKind::kFunAsrNano:
                if (funasrNanoOpts) {
                    if (funasrNanoOpts->system_prompt.has_value())
                        config.model_config.funasr_nano.system_prompt = *funasrNanoOpts->system_prompt;
                    if (funasrNanoOpts->user_prompt.has_value())
                        config.model_config.funasr_nano.user_prompt = *funasrNanoOpts->user_prompt;
                    if (funasrNanoOpts->max_new_tokens.has_value())
                        config.model_config.funasr_nano.max_new_tokens = *funasrNanoOpts->max_new_tokens;
                    if (funasrNanoOpts->temperature.has_value())
                        config.model_config.funasr_nano.temperature = *funasrNanoOpts->temperature;
                    if (funasrNanoOpts->top_p.has_value())
                        config.model_config.funasr_nano.top_p = *funasrNanoOpts->top_p;
                    if (funasrNanoOpts->seed.has_value())
                        config.model_config.funasr_nano.seed = *funasrNanoOpts->seed;
                    if (funasrNanoOpts->language.has_value())
                        config.model_config.funasr_nano.language = *funasrNanoOpts->language;
                    if (funasrNanoOpts->itn.has_value())
                        config.model_config.funasr_nano.itn = *funasrNanoOpts->itn;
                    if (funasrNanoOpts->hotwords.has_value())
                        config.model_config.funasr_nano.hotwords = *funasrNanoOpts->hotwords;
                }
                break;
            default:
                break;
        }

        if (hotwordsFile.has_value() && !hotwordsFile->empty()) {
            if (!SupportsHotwords(detect.selectedKind)) {
                result.success = false;
                result.error = "HOTWORDS_NOT_SUPPORTED: Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type is not transducer.";
                LOGE("%s", result.error.c_str());
                return result;
            }
            auto validateErr = ValidateHotwordsFile(*hotwordsFile);
            if (validateErr.has_value()) {
                result.success = false;
                result.error = "INVALID_HOTWORDS_FILE: " + *validateErr;
                LOGE("%s", result.error.c_str());
                return result;
            }
        }

        config.decoding_method = "greedy_search";
        config.model_config.num_threads = numThreads.value_or(1);
        config.model_config.provider = provider.value_or("cpu");
        if (hotwordsFile.has_value() && !hotwordsFile->empty()) {
            config.hotwords_file = *hotwordsFile;
        }
        if (hotwordsScore.has_value()) {
            config.hotwords_score = *hotwordsScore;
        }
        if (ruleFsts.has_value() && !ruleFsts->empty()) {
            config.rule_fsts = *ruleFsts;
        }
        if (ruleFars.has_value() && !ruleFars->empty()) {
            config.rule_fars = *ruleFars;
        }
        (void)dither;  // FeatureConfig in bundled cxx-api.h has no dither; reserve for future use

        bool isWhisperModel = !config.model_config.whisper.encoder.empty() && !config.model_config.whisper.decoder.empty();
        if (isWhisperModel) {
            LOGI("Initializing Whisper model with encoder: %s, decoder: %s", config.model_config.whisper.encoder.c_str(), config.model_config.whisper.decoder.c_str());
        } else {
            LOGI("Initializing non-Whisper model");
        }
        try {
            pImpl->recognizer = sherpa_onnx::cxx::OfflineRecognizer::Create(config);
        } catch (const std::exception& e) {
            LOGE("Failed to create recognizer: %s", e.what());
            return result;
        }

        pImpl->lastConfig = config;
        pImpl->modelDir = modelDir;
        pImpl->currentModelKind = detect.selectedKind;
        pImpl->initialized = true;

        result.success = true;
        result.detectedModels = detect.detectedModels;
        result.modelType = detect.detectedModels.empty() ? "" : detect.detectedModels[0].type;
        return result;
    } catch (const std::exception& e) {
        LOGE("Exception during initialization: %s", e.what());
        return result;
    } catch (...) {
        LOGE("Unknown exception during initialization");
        return result;
    }
}

namespace {
SttRecognitionResult offlineResultToSttResult(const sherpa_onnx::cxx::OfflineRecognizerResult& r) {
    SttRecognitionResult out;
    out.text = r.text;
    out.tokens = r.tokens;
    out.timestamps = r.timestamps;
    out.lang = r.lang;
    out.emotion = r.emotion;
    out.event = r.event;
    out.durations = r.durations;
    return out;
}
}  // namespace

SttRecognitionResult SttWrapper::transcribeFile(const std::string& filePath) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value()) {
        LOGE("Not initialized. Call initialize() first.");
        throw std::runtime_error("STT not initialized. Call initialize() first.");
    }

    auto fileExists = [](const std::string& path) -> bool {
        return fs::exists(path);
    };

    LOGI("Transcribe: file=%s", filePath.c_str());
    if (!fileExists(filePath)) {
        LOGE("Audio file not found: %s", filePath.c_str());
        throw std::runtime_error(std::string("Audio file not found: ") + filePath);
    }

    sherpa_onnx::cxx::Wave wave;
    try {
        wave = sherpa_onnx::cxx::ReadWave(filePath);
    } catch (const std::exception& e) {
        LOGE("Transcribe: ReadWave failed: %s", e.what());
        throw;
    } catch (...) {
        LOGE("Transcribe: ReadWave failed (unknown exception)");
        throw std::runtime_error(std::string("Failed to read audio file: ") + filePath);
    }

    if (wave.samples.empty()) {
        LOGE("Audio file is empty or failed to read: %s", filePath.c_str());
        throw std::runtime_error(std::string("Audio file is empty or could not be read: ") + filePath);
    }

    try {
        auto stream = pImpl->recognizer.value().CreateStream();

        // Ensure safe conversions: AcceptWaveform expects 32-bit ints
        if (wave.samples.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
            LOGE("Audio too large: sample count %zu exceeds int32_t max", wave.samples.size());
            throw std::runtime_error("Audio too large to process");
        }

        int32_t sample_rate = 0;
        if (wave.sample_rate > static_cast<uint32_t>(std::numeric_limits<int32_t>::max())) {
            LOGE("Sample rate too large: %u", wave.sample_rate);
            throw std::runtime_error("Unsupported sample rate");
        } else {
            sample_rate = static_cast<int32_t>(wave.sample_rate);
        }

        int32_t n_samples = static_cast<int32_t>(wave.samples.size());

        stream.AcceptWaveform(sample_rate, wave.samples.data(), n_samples);
        pImpl->recognizer.value().Decode(&stream);
        auto result = pImpl->recognizer.value().GetResult(&stream);
        return offlineResultToSttResult(result);
    } catch (const std::exception& e) {
        LOGE("Transcribe: recognition failed: %s", e.what());
        throw;
    } catch (...) {
        LOGE("Transcribe: recognition failed (unknown exception)");
        throw std::runtime_error(
            "Recognition failed. Ensure the model supports offline decoding and audio is 16 kHz mono WAV."
        );
    }
}

SttRecognitionResult SttWrapper::transcribeSamples(const std::vector<float>& samples, int32_t sampleRate) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value()) {
        LOGE("Not initialized. Call initialize() first.");
        throw std::runtime_error("STT not initialized. Call initialize() first.");
    }
    if (samples.empty()) {
        SttRecognitionResult empty;
        return empty;
    }
    if (samples.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
        LOGE("Samples too large: %zu", samples.size());
        throw std::runtime_error("Samples array too large to process");
    }
    try {
        auto stream = pImpl->recognizer.value().CreateStream();
        int32_t n = static_cast<int32_t>(samples.size());
        stream.AcceptWaveform(sampleRate, samples.data(), n);
        pImpl->recognizer.value().Decode(&stream);
        auto result = pImpl->recognizer.value().GetResult(&stream);
        return offlineResultToSttResult(result);
    } catch (const std::exception& e) {
        LOGE("TranscribeSamples: recognition failed: %s", e.what());
        throw;
    } catch (...) {
        LOGE("TranscribeSamples: recognition failed (unknown exception)");
        throw std::runtime_error("Recognition failed.");
    }
}

void SttWrapper::setConfig(const SttRuntimeConfigOptions& options) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value() || !pImpl->lastConfig.has_value()) {
        LOGE("Not initialized or no stored config.");
        throw std::runtime_error("STT not initialized. Call initialize() first.");
    }
    auto& config = pImpl->lastConfig.value();
    if (options.hotwords_file.has_value() && !options.hotwords_file->empty()) {
        if (!SupportsHotwords(pImpl->currentModelKind)) {
            LOGE("Hotwords are only supported for transducer models.");
            throw std::runtime_error("HOTWORDS_NOT_SUPPORTED: Hotwords are only supported for transducer models (transducer, nemo_transducer). Current model type is not transducer.");
        }
        auto validateErr = ValidateHotwordsFile(*options.hotwords_file);
        if (validateErr.has_value()) {
            LOGE("%s", validateErr->c_str());
            throw std::runtime_error("INVALID_HOTWORDS_FILE: " + *validateErr);
        }
    }
    if (options.decoding_method.has_value()) config.decoding_method = *options.decoding_method;
    if (options.max_active_paths.has_value()) config.max_active_paths = *options.max_active_paths;
    if (options.hotwords_file.has_value()) config.hotwords_file = *options.hotwords_file;
    if (options.hotwords_score.has_value()) config.hotwords_score = *options.hotwords_score;
    if (options.blank_penalty.has_value()) config.blank_penalty = *options.blank_penalty;
    if (options.rule_fsts.has_value()) config.rule_fsts = *options.rule_fsts;
    if (options.rule_fars.has_value()) config.rule_fars = *options.rule_fars;
    pImpl->recognizer.value().SetConfig(config);
}

bool SttWrapper::isInitialized() const {
    return pImpl->initialized;
}

void SttWrapper::release() {
    if (pImpl->initialized) {
        pImpl->recognizer.reset();
        pImpl->lastConfig.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
        pImpl->currentModelKind = sherpaonnx::SttModelKind::kUnknown;
    }
}

} // namespace sherpaonnx
