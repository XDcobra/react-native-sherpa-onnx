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
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace sherpaonnx {

// PIMPL pattern implementation
class SttWrapper::Impl {
public:
    bool initialized = false;
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
    const std::optional<std::string>& modelType
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

        auto detect = DetectSttModel(modelDir, preferInt8, modelType);
        if (!detect.ok) {
            LOGE("%s", detect.error.c_str());
            result.error = detect.error;
            return result;
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
        }

        config.decoding_method = "greedy_search";
        config.model_config.num_threads = 4;
        config.model_config.provider = "cpu";

        // Create recognizer
        // Log configuration details
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
            result.error = std::string("Failed to create recognizer: ") + e.what();
            return result;
        }

        pImpl->modelDir = modelDir;
        pImpl->initialized = true;

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
        LOGE("Not initialized. Call initialize() first.");
        return "";
    }

    try {
        // Helper function to check if file exists
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

        // Check if file exists
        if (!fileExists(filePath)) {
            LOGE("Audio file not found: %s", filePath.c_str());
            return "";
        }

        // Read audio file using cxx-api
        sherpa_onnx::cxx::Wave wave = sherpa_onnx::cxx::ReadWave(filePath);

        if (wave.samples.empty()) {
            LOGE("Audio file is empty or failed to read: %s", filePath.c_str());
            return "";
        }

        // Create a stream
        auto stream = pImpl->recognizer.value().CreateStream();

        // Feed audio data to the stream (all samples at once for offline recognition)
        stream.AcceptWaveform(wave.sample_rate, wave.samples.data(), wave.samples.size());

        // Decode the stream
        pImpl->recognizer.value().Decode(&stream);

        // Get result
        auto result = pImpl->recognizer.value().GetResult(&stream);

        return result.text;
    } catch (const std::exception& e) {
        LOGE("Exception during transcription: %s", e.what());
        return "";
    } catch (...) {
        LOGE("Unknown exception during transcription");
        return "";
    }
}

bool SttWrapper::isInitialized() const {
    return pImpl->initialized;
}

void SttWrapper::release() {
    if (pImpl->initialized) {
        // OfflineRecognizer uses RAII - destruction happens automatically when optional is reset
        pImpl->recognizer.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
    }
}

} // namespace sherpaonnx
