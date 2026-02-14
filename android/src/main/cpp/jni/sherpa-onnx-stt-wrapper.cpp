#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <android/log.h>
#include <algorithm>
#include <cctype>
#include <fstream>
#include <optional>
#include <sstream>
#include <sys/stat.h>

// Use filesystem if available (C++17), otherwise fallback
#if __cplusplus >= 201703L && __has_include(<filesystem>)
#include <filesystem>
namespace fs = std::filesystem;
#elif __has_include(<experimental/filesystem>)
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#else
// Fallback: use stat/opendir for older compilers
#include <dirent.h>
#include <sys/stat.h>
#endif

// sherpa-onnx headers - use cxx-api which is compatible with libsherpa-onnx-cxx-api.so
#include "sherpa-onnx/c-api/cxx-api.h"

#define LOG_TAG "SttWrapper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace sherpaonnx {

// PIMPL pattern implementation
class SttWrapper::Impl {
public:
    bool initialized = false;
    bool debug = false;
    std::string modelDir;
    std::optional<sherpa_onnx::cxx::OfflineRecognizer> recognizer;
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
    bool debug
) {
    SttInitializeResult result;
    result.success = false;
    result.error = "";

    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("Model directory is empty");
        result.error = "Model directory is empty";
        return result;
    }

    try {
        sherpa_onnx::cxx::OfflineRecognizerConfig config;
        config.feat_config.sample_rate = 16000;
        config.feat_config.feature_dim = 80;

        if (debug) {
            LOGI("STT: Detecting model in dir=%s", modelDir.c_str());
        }
        auto detect = DetectSttModel(modelDir, preferInt8, modelType);
        if (!detect.ok) {
            LOGE("STT: Model detection failed: %s", detect.error.c_str());
            result.error = detect.error;
            return result;
        }
        if (debug) {
            LOGI("STT: Model detection succeeded, selected kind=%d, detected %zu model(s)",
                 static_cast<int>(detect.selectedKind), detect.detectedModels.size());
        }

        switch (detect.selectedKind) {
            case SttModelKind::kTransducer:
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
            case SttModelKind::kUnknown:
            default:
                LOGE("No compatible model type detected in %s", modelDir.c_str());
                result.error = "No compatible model type detected in " + modelDir;
                return result;
        }

        if (!detect.paths.tokens.empty()) {
            config.model_config.tokens = detect.paths.tokens;
            if (debug) {
                LOGI("STT: tokens=%s", config.model_config.tokens.c_str());
            }
        } else {
            LOGW("STT: tokens path is empty — sherpa-onnx will reject the config "
                 "for all models except FunASR-nano");
        }

        config.decoding_method = "greedy_search";
        config.model_config.num_threads = 4;
        config.model_config.provider = "cpu";
        config.model_config.debug = debug;

        if (debug) {
            LOGI("STT: === Config before Create() ===");
            LOGI("STT: config.model_config.tokens=%s", config.model_config.tokens.c_str());
            LOGI("STT: config.model_config.num_threads=%d", config.model_config.num_threads);
            LOGI("STT: config.model_config.debug=%d", config.model_config.debug);
            LOGI("STT: config.model_config.provider=%s", config.model_config.provider.c_str());
            LOGI("STT: config.model_config.whisper.encoder=%s", config.model_config.whisper.encoder.c_str());
            LOGI("STT: config.model_config.whisper.decoder=%s", config.model_config.whisper.decoder.c_str());
            LOGI("STT: config.model_config.transducer.encoder=%s", config.model_config.transducer.encoder.c_str());
            LOGI("STT: config.model_config.transducer.decoder=%s", config.model_config.transducer.decoder.c_str());
            LOGI("STT: config.model_config.transducer.joiner=%s", config.model_config.transducer.joiner.c_str());
            LOGI("STT: config.model_config.paraformer.model=%s", config.model_config.paraformer.model.c_str());
            LOGI("STT: config.model_config.nemo_ctc.model=%s", config.model_config.nemo_ctc.model.c_str());
            LOGI("STT: config.decoding_method=%s", config.decoding_method.c_str());
        }

        if (debug) {
            auto checkFile = [](const std::string& path, const char* label) {
                if (path.empty()) return;
                std::ifstream f(path);
                if (f.good()) {
                    __android_log_print(ANDROID_LOG_INFO, "SttWrapper",
                        "STT: ifstream check OK: %s => %s", label, path.c_str());
                } else {
                    __android_log_print(ANDROID_LOG_ERROR, "SttWrapper",
                        "STT: ifstream check FAILED: %s => %s", label, path.c_str());
                }
            };
            checkFile(config.model_config.tokens, "tokens");
            checkFile(config.model_config.whisper.encoder, "whisper.encoder");
            checkFile(config.model_config.whisper.decoder, "whisper.decoder");
            checkFile(config.model_config.transducer.encoder, "transducer.encoder");
            checkFile(config.model_config.transducer.decoder, "transducer.decoder");
            checkFile(config.model_config.transducer.joiner, "transducer.joiner");
            checkFile(config.model_config.paraformer.model, "paraformer.model");
        }

        if (debug) {
            LOGI("STT: Creating OfflineRecognizer instance...");
        }
        try {
            pImpl->recognizer = sherpa_onnx::cxx::OfflineRecognizer::Create(config);
        } catch (const std::exception& e) {
            LOGE("STT: Failed to create recognizer: %s", e.what());
            result.error = std::string("Failed to create recognizer: ") + e.what();
            return result;
        }

        // The cxx-api Create() always returns an object, even on failure.
        // We must check the underlying C pointer via Get() to detect a failed load.
        if (!pImpl->recognizer.has_value() || pImpl->recognizer->Get() == nullptr) {
            LOGE("STT: OfflineRecognizer::Create returned an invalid object "
                 "(has_value=%d, Get()=%p). Model loading failed for: %s",
                 pImpl->recognizer.has_value() ? 1 : 0,
                 pImpl->recognizer.has_value() ? (const void*)pImpl->recognizer->Get() : nullptr,
                 modelDir.c_str());
            pImpl->recognizer.reset();
            result.error = "STT: Model loading failed. The sherpa-onnx engine could not "
                           "create the recognizer. Verify model files are complete and "
                           "paths are correct. modelDir=" + modelDir;
            return result;
        }

        pImpl->modelDir = modelDir;
        pImpl->initialized = true;
        pImpl->debug = debug;
        if (debug) {
            LOGI("STT: Initialization successful (C ptr=%p)", (const void*)pImpl->recognizer->Get());
        }

        // Success - return detected models
        result.success = true;
        result.detectedModels = detect.detectedModels;
        return result;
    } catch (const std::exception& e) {
        LOGE("Exception during initialization: %s", e.what());
        result.error = std::string("Exception during initialization: ") + e.what();
        return result;
    } catch (...) {
        LOGE("Unknown exception during initialization");
        result.error = "Unknown exception during initialization";
        return result;
    }
}

std::string SttWrapper::transcribeFile(const std::string& filePath) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value()) {
        LOGE("STT: Not initialized. Call initialize() first.");
        throw std::runtime_error("STT not initialized. Call initialize() first.");
    }

    // Extra safety: check the C pointer is valid
    if (pImpl->recognizer->Get() == nullptr) {
        LOGE("STT: Recognizer C pointer is null — model was not loaded correctly.");
        throw std::runtime_error(
            "STT: Recognizer is in an invalid state (null C pointer). "
            "The model was not loaded correctly. Re-initialize before transcribing."
        );
    }

    auto fileExists = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
        return std::filesystem::exists(path);
#elif __has_include(<experimental/filesystem>)
        return std::experimental::filesystem::exists(path);
#else
        struct stat buffer;
        return (stat(path.c_str(), &buffer) == 0);
#endif
    };

    if (pImpl->debug) {
        LOGI("STT: Transcribe: file=%s", filePath.c_str());
    }
    if (!fileExists(filePath)) {
        LOGE("STT: Audio file not found: %s", filePath.c_str());
        throw std::runtime_error(std::string("Audio file not found: ") + filePath);
    }

    sherpa_onnx::cxx::Wave wave;
    try {
        wave = sherpa_onnx::cxx::ReadWave(filePath);
        if (pImpl->debug) {
            LOGI("STT: ReadWave OK — %zu samples at %d Hz", wave.samples.size(), wave.sample_rate);
        }
    } catch (const std::exception& e) {
        LOGE("STT: ReadWave failed: %s", e.what());
        throw;
    } catch (...) {
        LOGE("STT: ReadWave failed (unknown exception)");
        throw std::runtime_error(std::string("Failed to read audio file: ") + filePath);
    }

    if (wave.samples.empty()) {
        LOGE("STT: Audio file is empty or failed to read: %s", filePath.c_str());
        throw std::runtime_error(std::string("Audio file is empty or could not be read: ") + filePath);
    }

    try {
        if (pImpl->debug) {
            LOGI("STT: Creating stream from recognizer (C ptr=%p)...",
                 (const void*)pImpl->recognizer->Get());
        }
        auto stream = pImpl->recognizer.value().CreateStream();
        if (pImpl->debug) {
            LOGI("STT: Stream created, accepting waveform...");
        }
        stream.AcceptWaveform(wave.sample_rate, wave.samples.data(), wave.samples.size());
        if (pImpl->debug) {
            LOGI("STT: Decoding...");
        }
        pImpl->recognizer.value().Decode(&stream);
        auto result = pImpl->recognizer.value().GetResult(&stream);
        if (pImpl->debug) {
            LOGI("STT: Transcription result: '%s'", result.text.c_str());
        }
        return result.text;
    } catch (const std::exception& e) {
        LOGE("STT: Recognition failed: %s", e.what());
        throw;
    } catch (...) {
        LOGE("STT: Recognition failed (unknown exception)");
        throw std::runtime_error(
            "Recognition failed. Ensure the model supports offline decoding and audio is 16 kHz mono WAV."
        );
    }
}

bool SttWrapper::isInitialized() const {
    return pImpl->initialized && pImpl->recognizer.has_value() && pImpl->recognizer->Get() != nullptr;
}

void SttWrapper::release() {
    if (pImpl->initialized || pImpl->recognizer.has_value()) {
        LOGI("STT: Releasing resources (initialized=%d, has_value=%d)",
             pImpl->initialized ? 1 : 0, pImpl->recognizer.has_value() ? 1 : 0);
        pImpl->recognizer.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
    }
}

} // namespace sherpaonnx
