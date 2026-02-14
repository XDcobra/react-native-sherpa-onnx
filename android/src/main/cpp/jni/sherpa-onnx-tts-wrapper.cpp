#include "sherpa-onnx-tts-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <android/log.h>
#include <algorithm>
#include <cctype>
#include <fstream>
#include <mutex>
#include <optional>
#include <unordered_map>
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
    bool debug = false;
    std::string modelDir;
    std::optional<sherpa_onnx::cxx::OfflineTts> tts;
    // Hold active stream callbacks to ensure they remain alive while native code may call them
    std::unordered_map<uint64_t, std::shared_ptr<TtsStreamCallback>> activeStreamCallbacks;
    std::mutex streamMutex;
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
    bool debug,
    std::optional<float> noiseScale,
    std::optional<float> noiseScaleW,
    std::optional<float> lengthScale
) {
    TtsInitializeResult result;
    result.success = false;
    result.error = "";

    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("TTS: Model directory is empty");
        result.error = "TTS: Model directory is empty";
        return result;
    }

    try {
        sherpa_onnx::cxx::OfflineTtsConfig config;
        config.model.num_threads = numThreads;
        config.model.debug = debug;

        if (debug) {
            LOGI("TTS: Detecting model in dir=%s with type=%s", modelDir.c_str(), modelType.c_str());
        }
        auto detect = DetectTtsModel(modelDir, modelType);
        if (!detect.ok) {
            LOGE("TTS: Model detection failed: %s", detect.error.c_str());
            result.error = detect.error;
            return result;
        }
        if (debug) {
            LOGI("TTS: Model detection succeeded, selected kind=%d, detected %zu model(s)",
                 static_cast<int>(detect.selectedKind), detect.detectedModels.size());
        }

        switch (detect.selectedKind) {
            case TtsModelKind::kVits:
                config.model.vits.model = detect.paths.ttsModel;
                config.model.vits.tokens = detect.paths.tokens;
                config.model.vits.data_dir = detect.paths.dataDir;
                if (noiseScale.has_value()) {
                    config.model.vits.noise_scale = noiseScale.value();
                }
                if (noiseScaleW.has_value()) {
                    config.model.vits.noise_scale_w = noiseScaleW.value();
                }
                if (lengthScale.has_value()) {
                    config.model.vits.length_scale = lengthScale.value();
                }
                break;
            case TtsModelKind::kMatcha:
                config.model.matcha.acoustic_model = detect.paths.acousticModel;
                config.model.matcha.vocoder = detect.paths.vocoder;
                config.model.matcha.tokens = detect.paths.tokens;
                config.model.matcha.data_dir = detect.paths.dataDir;
                if (noiseScale.has_value()) {
                    config.model.matcha.noise_scale = noiseScale.value();
                }
                if (lengthScale.has_value()) {
                    config.model.matcha.length_scale = lengthScale.value();
                }
                break;
            case TtsModelKind::kKokoro:
                config.model.kokoro.model = detect.paths.ttsModel;
                config.model.kokoro.tokens = detect.paths.tokens;
                config.model.kokoro.data_dir = detect.paths.dataDir;
                config.model.kokoro.voices = detect.paths.voices;
                if (!detect.paths.lexicon.empty()) {
                    config.model.kokoro.lexicon = detect.paths.lexicon;
                }
                if (lengthScale.has_value()) {
                    config.model.kokoro.length_scale = lengthScale.value();
                }
                break;
            case TtsModelKind::kKitten:
                config.model.kitten.model = detect.paths.ttsModel;
                config.model.kitten.tokens = detect.paths.tokens;
                config.model.kitten.data_dir = detect.paths.dataDir;
                config.model.kitten.voices = detect.paths.voices;
                if (lengthScale.has_value()) {
                    config.model.kitten.length_scale = lengthScale.value();
                }
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
                result.error = "TTS: Unknown model type: " + modelType;
                return result;
        }

        if (debug) {
            LOGI("TTS: === Config before Create() ===");
            LOGI("TTS: config.model.vits.model=%s", config.model.vits.model.c_str());
            LOGI("TTS: config.model.vits.tokens=%s", config.model.vits.tokens.c_str());
            LOGI("TTS: config.model.vits.lexicon=%s", config.model.vits.lexicon.c_str());
            LOGI("TTS: config.model.vits.data_dir=%s", config.model.vits.data_dir.c_str());
            LOGI("TTS: config.model.vits.noise_scale=%.3f", config.model.vits.noise_scale);
            LOGI("TTS: config.model.vits.noise_scale_w=%.3f", config.model.vits.noise_scale_w);
            LOGI("TTS: config.model.vits.length_scale=%.3f", config.model.vits.length_scale);
            LOGI("TTS: config.model.matcha.acoustic_model=%s", config.model.matcha.acoustic_model.c_str());
            LOGI("TTS: config.model.kokoro.model=%s", config.model.kokoro.model.c_str());
            LOGI("TTS: config.model.num_threads=%d", config.model.num_threads);
            LOGI("TTS: config.model.debug=%d", config.model.debug);
            LOGI("TTS: config.model.provider=%s", config.model.provider.c_str());
            LOGI("TTS: config.max_num_sentences=%d", config.max_num_sentences);
            LOGI("TTS: config.silence_scale=%.3f", config.silence_scale);
            LOGI("TTS: config.rule_fsts=%s", config.rule_fsts.c_str());
            LOGI("TTS: config.rule_fars=%s", config.rule_fars.c_str());
        }

        if (debug) {
            auto checkFile = [](const std::string& path, const char* label) {
                if (path.empty()) return;
                std::ifstream f(path);
                if (f.good()) {
                    __android_log_print(ANDROID_LOG_INFO, "TtsWrapper",
                        "TTS: ifstream check OK: %s => %s", label, path.c_str());
                } else {
                    __android_log_print(ANDROID_LOG_ERROR, "TtsWrapper",
                        "TTS: ifstream check FAILED: %s => %s", label, path.c_str());
                }
            };
            checkFile(config.model.vits.model, "vits.model");
            checkFile(config.model.vits.tokens, "vits.tokens");
            if (!config.model.vits.data_dir.empty()) {
                checkFile(config.model.vits.data_dir + "/phontab", "data_dir/phontab");
                checkFile(config.model.vits.data_dir + "/phonindex", "data_dir/phonindex");
                checkFile(config.model.vits.data_dir + "/phondata", "data_dir/phondata");
                checkFile(config.model.vits.data_dir + "/intonations", "data_dir/intonations");
            }
        }

        // Create TTS instance
        if (debug) {
            LOGI("TTS: Creating OfflineTts instance for modelDir=%s ...", modelDir.c_str());
        }
        pImpl->tts = sherpa_onnx::cxx::OfflineTts::Create(config);

        // The cxx-api Create() always returns an object, even on failure.
        // We must check the underlying C pointer via Get() to detect a failed load.
        if (!pImpl->tts.has_value() || pImpl->tts->Get() == nullptr) {
            LOGE("TTS: OfflineTts::Create returned an invalid object "
                 "(has_value=%d, Get()=%p). Model loading failed for: %s",
                 pImpl->tts.has_value() ? 1 : 0,
                 pImpl->tts.has_value() ? (const void*)pImpl->tts->Get() : nullptr,
                 modelDir.c_str());
            pImpl->tts.reset();
            result.error = "TTS: Model loading failed. The sherpa-onnx engine could not "
                           "create the TTS instance. Verify model files are complete and "
                           "paths are correct. modelDir=" + modelDir;
            return result;
        }

        pImpl->initialized = true;
        pImpl->debug = debug;
        pImpl->modelDir = modelDir;

        if (debug) {
            LOGI("TTS: Initialization successful (C ptr=%p)", (const void*)pImpl->tts->Get());
        }

        // Safely query model capabilities — some models may not support these
        int32_t sampleRate = 0;
        int32_t numSpeakers = 0;
        try {
            sampleRate = pImpl->tts->SampleRate();
            if (debug) {
                LOGI("TTS: Sample rate: %d Hz", sampleRate);
            }
        } catch (...) {
            LOGE("TTS: SampleRate() threw an exception — model may not support it");
        }
        try {
            numSpeakers = pImpl->tts->NumSpeakers();
            if (debug) {
                LOGI("TTS: Number of speakers: %d", numSpeakers);
            }
        } catch (...) {
            LOGE("TTS: NumSpeakers() threw an exception — model may not support it");
        }

        // Success - return detected models
        result.success = true;
        result.sampleRate = sampleRate;
        result.numSpeakers = numSpeakers;
        result.detectedModels = detect.detectedModels;
        return result;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during initialization: %s", e.what());
        result.error = std::string("TTS: Exception during initialization: ") + e.what();
        return result;
    } catch (...) {
        LOGE("TTS: Unknown exception during initialization");
        result.error = "TTS: Unknown exception during initialization";
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

    if (!pImpl->initialized || !pImpl->tts.has_value() || pImpl->tts->Get() == nullptr) {
        LOGE("TTS: Not initialized or invalid C ptr. Call initialize() first. "
             "(initialized=%d, has_value=%d, Get()=%p)",
             pImpl->initialized ? 1 : 0,
             pImpl->tts.has_value() ? 1 : 0,
             pImpl->tts.has_value() ? (const void*)pImpl->tts->Get() : nullptr);
        return result;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return result;
    }

    try {
        if (pImpl->debug) {
            LOGI("TTS: Generating speech for text: %s (sid=%d, speed=%.2f)",
                 text.c_str(), sid, speed);
        }

        // Generate audio using cxx-api
        auto audio = pImpl->tts.value().Generate(text, sid, speed);

        // Copy samples to result
        result.samples = std::move(audio.samples);
        result.sampleRate = audio.sample_rate;

        if (pImpl->debug) {
            LOGI("TTS: Generated %zu samples at %d Hz",
                 result.samples.size(), result.sampleRate);
        }

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
    StreamId streamId,
    const TtsStreamCallback& callback
) {
    if (!pImpl->initialized || !pImpl->tts.has_value() || pImpl->tts->Get() == nullptr) {
        LOGE("TTS: Not initialized or invalid C ptr for streaming. "
             "(initialized=%d, has_value=%d, Get()=%p)",
             pImpl->initialized ? 1 : 0,
             pImpl->tts.has_value() ? 1 : 0,
             pImpl->tts.has_value() ? (const void*)pImpl->tts->Get() : nullptr);
        return false;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return false;
    }

    try {
        if (pImpl->debug) {
            LOGI("TTS: Streaming generation for text: %s (sid=%d, speed=%.2f)",
                 text.c_str(), sid, speed);
        }

        // Keep a shared_ptr to the callback so it remains valid while native code may call it.
        std::shared_ptr<TtsStreamCallback> cbPtr = nullptr;
        if (callback) {
            cbPtr = std::make_shared<TtsStreamCallback>(callback);
            std::lock_guard<std::mutex> lock(pImpl->streamMutex);
            pImpl->activeStreamCallbacks.emplace(streamId, cbPtr);
        }

        auto shim = [](const float *samples, int32_t numSamples, float progress, void *arg) -> int32_t {
            auto *cb = reinterpret_cast<TtsStreamCallback*>(arg);
            if (!cb || !(*cb)) return 0;
            return (*cb)(samples, numSamples, progress);
        };

        pImpl->tts.value().Generate(
            text,
            sid,
            speed,
            cbPtr ? shim : nullptr,
            cbPtr ? cbPtr.get() : nullptr
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

void TtsWrapper::cancelStream(StreamId streamId) {
    if (streamId == 0) return;
    std::lock_guard<std::mutex> lock(pImpl->streamMutex);
    pImpl->activeStreamCallbacks.erase(streamId);
}

void TtsWrapper::endStream(StreamId streamId) {
    if (streamId == 0) return;
    std::lock_guard<std::mutex> lock(pImpl->streamMutex);
    pImpl->activeStreamCallbacks.erase(streamId);
}

int32_t TtsWrapper::getSampleRate() const {
    if (!pImpl->initialized || !pImpl->tts.has_value() || pImpl->tts->Get() == nullptr) {
        LOGE("TTS: Not initialized or invalid. Call initialize() first.");
        return 0;
    }
    try {
        return pImpl->tts.value().SampleRate();
    } catch (...) {
        LOGE("TTS: SampleRate() threw an exception");
        return 0;
    }
}

int32_t TtsWrapper::getNumSpeakers() const {
    if (!pImpl->initialized || !pImpl->tts.has_value() || pImpl->tts->Get() == nullptr) {
        LOGE("TTS: Not initialized or invalid. Call initialize() first.");
        return 0;
    }
    try {
        return pImpl->tts.value().NumSpeakers();
    } catch (...) {
        LOGE("TTS: NumSpeakers() threw an exception");
        return 0;
    }
}

bool TtsWrapper::isInitialized() const {
    return pImpl->initialized && pImpl->tts.has_value() && pImpl->tts->Get() != nullptr;
}

void TtsWrapper::release() {
    if (pImpl->initialized || pImpl->tts.has_value()) {
        if (pImpl->debug) {
            LOGI("TTS: Releasing resources (initialized=%d, has_value=%d, Get()=%p)",
                 pImpl->initialized ? 1 : 0,
                 pImpl->tts.has_value() ? 1 : 0,
                 pImpl->tts.has_value() ? (const void*)pImpl->tts->Get() : nullptr);
        }
        pImpl->tts.reset();
        // Clear any stored callbacks to allow them to be freed
        {
            std::lock_guard<std::mutex> lock(pImpl->streamMutex);
            pImpl->activeStreamCallbacks.clear();
        }
        pImpl->initialized = false;
        pImpl->modelDir.clear();
        if (pImpl->debug) {
            LOGI("TTS: Resources released");
        }
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
