#include "sherpa-onnx-tts-wrapper.h"
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

#define LOG_TAG "TtsWrapper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace sherpaonnx {

class TtsWrapper::Impl {
public:
    bool initialized = false;
    std::string modelDir;
    std::optional<sherpa_onnx::cxx::OfflineTts> tts;
};

TtsWrapper::TtsWrapper() : pImpl(std::make_unique<Impl>()) {
    LOGI("TtsWrapper created");
}

TtsWrapper::~TtsWrapper() {
    release();
    LOGI("TtsWrapper destroyed");
}

TtsInitializeResult TtsWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    int32_t numThreads,
    bool debug
) {
    TtsInitializeResult result;
    result.success = false;

    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("TTS: Model directory is empty");
        return result;
    }

    try {
        sherpa_onnx::cxx::OfflineTtsConfig config;
        config.model.num_threads = numThreads;
        config.model.debug = debug;

        auto detect = DetectTtsModel(modelDir, modelType);
        if (!detect.ok) {
            LOGE("%s", detect.error.c_str());
            return result;
        }

        switch (detect.selectedKind) {
            case TtsModelKind::kVits:
                config.model.vits.model = detect.paths.ttsModel;
                config.model.vits.tokens = detect.paths.tokens;
                config.model.vits.data_dir = detect.paths.dataDir;
                break;
            case TtsModelKind::kMatcha:
                config.model.matcha.acoustic_model = detect.paths.acousticModel;
                config.model.matcha.vocoder = detect.paths.vocoder;
                config.model.matcha.tokens = detect.paths.tokens;
                config.model.matcha.data_dir = detect.paths.dataDir;
                break;
            case TtsModelKind::kKokoro:
                config.model.kokoro.model = detect.paths.ttsModel;
                config.model.kokoro.tokens = detect.paths.tokens;
                config.model.kokoro.data_dir = detect.paths.dataDir;
                config.model.kokoro.voices = detect.paths.voices;
                if (!detect.paths.lexicon.empty()) {
                    config.model.kokoro.lexicon = detect.paths.lexicon;
                }
                break;
            case TtsModelKind::kKitten:
                config.model.kitten.model = detect.paths.ttsModel;
                config.model.kitten.tokens = detect.paths.tokens;
                config.model.kitten.data_dir = detect.paths.dataDir;
                config.model.kitten.voices = detect.paths.voices;
                break;
            case TtsModelKind::kZipvoice:
                config.model.zipvoice.encoder = detect.paths.encoder;
                config.model.zipvoice.decoder = detect.paths.decoder;
                config.model.zipvoice.vocoder = detect.paths.vocoder;
                config.model.zipvoice.tokens = detect.paths.tokens;
                config.model.zipvoice.data_dir = detect.paths.dataDir;
                break;
            case TtsModelKind::kUnknown:
            default:
                LOGE("TTS: Unknown model type: %s", modelType.c_str());
                return result;
        }

        // Create TTS instance
        LOGI("TTS: Creating OfflineTts instance...");
        pImpl->tts = sherpa_onnx::cxx::OfflineTts::Create(config);

        if (!pImpl->tts.has_value()) {
            LOGE("TTS: Failed to create OfflineTts instance");
            return result;
        }

        pImpl->initialized = true;
        pImpl->modelDir = modelDir;

        LOGI("TTS: Initialization successful");
        LOGI("TTS: Sample rate: %d Hz", pImpl->tts.value().SampleRate());
        LOGI("TTS: Number of speakers: %d", pImpl->tts.value().NumSpeakers());

        // Success - return detected models
        result.success = true;
        result.detectedModels = detect.detectedModels;
        return result;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during initialization: %s", e.what());
        return result;
    } catch (...) {
        LOGE("TTS: Unknown exception during initialization");
        return result;
    }
}

TtsWrapper::AudioResult TtsWrapper::generate(
    const std::string& text,
    int32_t sid,
    float speed
) {
    AudioResult result;
    result.sampleRate = 0;

    if (!pImpl->initialized || !pImpl->tts.has_value()) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return result;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return result;
    }

    try {
        LOGI("TTS: Generating speech for text: %s (sid=%d, speed=%.2f)",
             text.c_str(), sid, speed);

        // Generate audio using cxx-api
        auto audio = pImpl->tts.value().Generate(text, sid, speed);

        // Copy samples to result
        result.samples = std::move(audio.samples);
        result.sampleRate = audio.sample_rate;

        LOGI("TTS: Generated %zu samples at %d Hz",
             result.samples.size(), result.sampleRate);

        return result;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during generation: %s", e.what());
        return result;
    } catch (...) {
        LOGE("TTS: Unknown exception during generation");
        return result;
    }
}

bool TtsWrapper::generateStream(
    const std::string& text,
    int32_t sid,
    float speed,
    const TtsStreamCallback& callback
) {
    if (!pImpl->initialized || !pImpl->tts.has_value()) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return false;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return false;
    }

    try {
        LOGI("TTS: Streaming generation for text: %s (sid=%d, speed=%.2f)",
             text.c_str(), sid, speed);

        auto callbackCopy = callback;
        auto shim = [](const float *samples, int32_t numSamples, float progress, void *arg) -> int32_t {
            auto *cb = reinterpret_cast<TtsStreamCallback*>(arg);
            if (!cb || !(*cb)) return 0;
            return (*cb)(samples, numSamples, progress);
        };

        pImpl->tts.value().Generate(
            text,
            sid,
            speed,
            callbackCopy ? shim : nullptr,
            callbackCopy ? &callbackCopy : nullptr
        );

        return true;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during streaming generation: %s", e.what());
        return false;
    } catch (...) {
        LOGE("TTS: Unknown exception during streaming generation");
        return false;
    }
}

int32_t TtsWrapper::getSampleRate() const {
    if (!pImpl->initialized || !pImpl->tts.has_value()) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return 0;
    }
    return pImpl->tts.value().SampleRate();
}

int32_t TtsWrapper::getNumSpeakers() const {
    if (!pImpl->initialized || !pImpl->tts.has_value()) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return 0;
    }
    return pImpl->tts.value().NumSpeakers();
}

bool TtsWrapper::isInitialized() const {
    return pImpl->initialized;
}

void TtsWrapper::release() {
    if (pImpl->initialized) {
        pImpl->tts.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
        LOGI("TTS: Resources released");
    }
}

bool TtsWrapper::saveToWavFile(
    const std::vector<float>& samples,
    int32_t sampleRate,
    const std::string& filePath
) {
    if (samples.empty()) {
        LOGE("TTS: Cannot save empty audio samples");
        return false;
    }

    if (sampleRate <= 0) {
        LOGE("TTS: Invalid sample rate: %d", sampleRate);
        return false;
    }

    try {
        std::ofstream outfile(filePath, std::ios::binary);
        if (!outfile) {
            LOGE("TTS: Failed to open output file: %s", filePath.c_str());
            return false;
        }

        // WAV file header
        const int32_t numChannels = 1;  // Mono
        const int32_t bitsPerSample = 16;  // 16-bit PCM
        const int32_t byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const int32_t blockAlign = numChannels * bitsPerSample / 8;
        const int32_t dataSize = static_cast<int32_t>(samples.size()) * bitsPerSample / 8;
        const int32_t chunkSize = 36 + dataSize;

        // RIFF header
        outfile.write("RIFF", 4);
        outfile.write(reinterpret_cast<const char*>(&chunkSize), 4);
        outfile.write("WAVE", 4);

        // fmt subchunk
        outfile.write("fmt ", 4);
        const int32_t subchunk1Size = 16;  // PCM
        outfile.write(reinterpret_cast<const char*>(&subchunk1Size), 4);
        const int16_t audioFormat = 1;  // PCM
        outfile.write(reinterpret_cast<const char*>(&audioFormat), 2);
        const int16_t numChannelsInt16 = static_cast<int16_t>(numChannels);
        outfile.write(reinterpret_cast<const char*>(&numChannelsInt16), 2);
        outfile.write(reinterpret_cast<const char*>(&sampleRate), 4);
        outfile.write(reinterpret_cast<const char*>(&byteRate), 4);
        const int16_t blockAlignInt16 = static_cast<int16_t>(blockAlign);
        outfile.write(reinterpret_cast<const char*>(&blockAlignInt16), 2);
        const int16_t bitsPerSampleInt16 = static_cast<int16_t>(bitsPerSample);
        outfile.write(reinterpret_cast<const char*>(&bitsPerSampleInt16), 2);

        // data subchunk
        outfile.write("data", 4);
        outfile.write(reinterpret_cast<const char*>(&dataSize), 4);

        // Convert float samples to int16 PCM and write
        for (float sample : samples) {
            float clamped = std::max(-1.0f, std::min(1.0f, sample));
            int16_t intSample = static_cast<int16_t>(clamped * 32767.0f);
            outfile.write(reinterpret_cast<const char*>(&intSample), sizeof(int16_t));
        }

        outfile.close();
        LOGI("TTS: Successfully saved %zu samples to %s", samples.size(), filePath.c_str());
        return true;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception while saving WAV file: %s", e.what());
        return false;
    }
}

} // namespace sherpaonnx
