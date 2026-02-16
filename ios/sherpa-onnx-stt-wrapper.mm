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
    const std::optional<std::string>& modelType,
    bool debug /* = false */
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
                return result;
        }

        if (!detect.paths.tokens.empty()) {
            config.model_config.tokens = detect.paths.tokens;
        }

        config.decoding_method = "greedy_search";
        config.model_config.num_threads = 4;
        config.model_config.provider = "cpu";

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

        pImpl->modelDir = modelDir;
        pImpl->initialized = true;

        result.success = true;
        result.detectedModels = detect.detectedModels;
        return result;
    } catch (const std::exception& e) {
        LOGE("Exception during initialization: %s", e.what());
        return result;
    } catch (...) {
        LOGE("Unknown exception during initialization");
        return result;
    }
}

std::string SttWrapper::transcribeFile(const std::string& filePath) {
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
        return result.text;
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

bool SttWrapper::isInitialized() const {
    return pImpl->initialized;
}

void SttWrapper::release() {
    if (pImpl->initialized) {
        pImpl->recognizer.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
    }
}

} // namespace sherpaonnx
