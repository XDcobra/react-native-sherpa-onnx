/**
 * sherpa-onnx-tts-wrapper.mm
 *
 * Purpose: Wraps the sherpa-onnx C++ OfflineTts for iOS. Builds config from TtsModelPaths, creates
 * TTS instance, generates audio from text. Used by SherpaOnnx+TTS.mm.
 */

#include "sherpa-onnx-tts-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <optional>
#include <sstream>

// iOS logging
#ifdef __APPLE__
#include <Foundation/Foundation.h>
#include <cstdio>
#define LOGI(fmt, ...) NSLog(@"TtsWrapper: " fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) NSLog(@"TtsWrapper ERROR: " fmt, ##__VA_ARGS__)
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

class TtsWrapper::Impl {
public:
    bool initialized = false;
    std::string modelDir;
    TtsModelKind modelKind = TtsModelKind::kUnknown;
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
    bool debug,
    const std::optional<float>& noiseScale,
    const std::optional<float>& noiseScaleW,
    const std::optional<float>& lengthScale,
    const std::optional<std::string>& ruleFsts,
    const std::optional<std::string>& ruleFars,
    const std::optional<int32_t>& maxNumSentences,
    const std::optional<float>& silenceScale,
    const std::optional<std::string>& provider
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
        if (provider.has_value() && !provider->empty()) {
            config.model.provider = *provider;
        }

        auto detect = DetectTtsModel(modelDir, modelType);
        if (!detect.ok) {
            result.error = detect.error;
            LOGE("%s", detect.error.c_str());
            return result;
        }

        switch (detect.selectedKind) {
            case TtsModelKind::kVits:
                config.model.vits.model = detect.paths.ttsModel;
                config.model.vits.tokens = detect.paths.tokens;
                config.model.vits.data_dir = detect.paths.dataDir;
                if (!detect.paths.lexicon.empty()) {
                    config.model.vits.lexicon = detect.paths.lexicon;
                }
                if (noiseScale.has_value()) {
                    config.model.vits.noise_scale = *noiseScale;
                }
                if (noiseScaleW.has_value()) {
                    config.model.vits.noise_scale_w = *noiseScaleW;
                }
                if (lengthScale.has_value()) {
                    config.model.vits.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kMatcha:
                config.model.matcha.acoustic_model = detect.paths.acousticModel;
                config.model.matcha.vocoder = detect.paths.vocoder;
                config.model.matcha.tokens = detect.paths.tokens;
                config.model.matcha.data_dir = detect.paths.dataDir;
                if (noiseScale.has_value()) {
                    config.model.matcha.noise_scale = *noiseScale;
                }
                if (lengthScale.has_value()) {
                    config.model.matcha.length_scale = *lengthScale;
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
                    config.model.kokoro.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kKitten:
                config.model.kitten.model = detect.paths.ttsModel;
                config.model.kitten.tokens = detect.paths.tokens;
                config.model.kitten.data_dir = detect.paths.dataDir;
                config.model.kitten.voices = detect.paths.voices;
                if (lengthScale.has_value()) {
                    config.model.kitten.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kZipvoice:
                config.model.zipvoice.encoder = detect.paths.encoder;
                config.model.zipvoice.decoder = detect.paths.decoder;
                config.model.zipvoice.vocoder = detect.paths.vocoder;
                config.model.zipvoice.tokens = detect.paths.tokens;
                config.model.zipvoice.data_dir = detect.paths.dataDir;
                if (!detect.paths.lexicon.empty()) {
                    config.model.zipvoice.lexicon = detect.paths.lexicon;
                }
                // Limit peak RAM (same idea as Android Zipvoice init).
                config.model.num_threads = 1;
                break;
            case TtsModelKind::kPocket:
                config.model.pocket.lm_flow = detect.paths.lmFlow;
                config.model.pocket.lm_main = detect.paths.lmMain;
                config.model.pocket.encoder = detect.paths.encoder;
                config.model.pocket.decoder = detect.paths.decoder;
                config.model.pocket.text_conditioner = detect.paths.textConditioner;
                config.model.pocket.vocab_json = detect.paths.vocabJson;
                config.model.pocket.token_scores_json = detect.paths.tokenScoresJson;
                break;
            case TtsModelKind::kSupertonic:
                config.model.supertonic.duration_predictor = detect.paths.durationPredictor;
                config.model.supertonic.text_encoder = detect.paths.textEncoder;
                config.model.supertonic.vector_estimator = detect.paths.vectorEstimator;
                config.model.supertonic.vocoder = detect.paths.vocoder;
                config.model.supertonic.tts_json = detect.paths.ttsJson;
                config.model.supertonic.unicode_indexer = detect.paths.unicodeIndexer;
                config.model.supertonic.voice_style = detect.paths.voiceStyle;
                break;
            case TtsModelKind::kUnknown:
            default:
                result.error = "TTS: Unknown model type: " + modelType;
                LOGE("TTS: Unknown model type: %s", modelType.c_str());
                return result;
        }

        // Prevent hard native aborts from sherpa-onnx when phonemization data is missing.
        // Some VITS models require either espeak-ng-data or a lexicon. If both are missing,
        // fail gracefully so JS/UI can display a recoverable error instead of crashing.
        if (detect.selectedKind == TtsModelKind::kVits &&
            detect.paths.dataDir.empty() &&
            detect.paths.lexicon.empty()) {
            result.error =
                "TTS VITS init blocked: missing both espeak-ng-data and lexicon. "
                "Please add espeak-ng-data to the model folder or provide a lexicon.";
            LOGE("%s", result.error.c_str());
            return result;
        }

        if (ruleFsts.has_value() && !ruleFsts->empty()) {
            config.rule_fsts = *ruleFsts;
        }
        if (ruleFars.has_value() && !ruleFars->empty()) {
            config.rule_fars = *ruleFars;
        }
        if (maxNumSentences.has_value() && *maxNumSentences >= 1) {
            config.max_num_sentences = *maxNumSentences;
        }
        if (silenceScale.has_value()) {
            config.silence_scale = *silenceScale;
        }

        // Log paths passed to sherpa-onnx C++ API to diagnose /usr/share/espeak-ng-data fallback.
        LOGI("TTS: modelDir=%s", modelDir.c_str());
        switch (detect.selectedKind) {
            case TtsModelKind::kVits:
                LOGI("TTS: vits data_dir=%s (empty=%d)", detect.paths.dataDir.empty() ? "(empty)" : detect.paths.dataDir.c_str(), (int)detect.paths.dataDir.empty());
                break;
            case TtsModelKind::kMatcha:
                LOGI("TTS: matcha data_dir=%s (empty=%d)", detect.paths.dataDir.empty() ? "(empty)" : detect.paths.dataDir.c_str(), (int)detect.paths.dataDir.empty());
                break;
            case TtsModelKind::kKokoro:
            case TtsModelKind::kKitten:
            case TtsModelKind::kZipvoice:
                LOGI("TTS: data_dir=%s (empty=%d)", detect.paths.dataDir.empty() ? "(empty)" : detect.paths.dataDir.c_str(), (int)detect.paths.dataDir.empty());
                break;
            default:
                break;
        }
        LOGI("TTS: Creating OfflineTts instance...");
        pImpl->tts = sherpa_onnx::cxx::OfflineTts::Create(config);

        if (!pImpl->tts.has_value()) {
            result.error = "TTS: Failed to create OfflineTts instance (e.g. missing espeak-ng data or invalid model)";
            LOGE("%s", result.error.c_str());
            return result;
        }

        pImpl->initialized = true;
        pImpl->modelDir = modelDir;
        pImpl->modelKind = detect.selectedKind;

        LOGI("TTS: Initialization successful");
        LOGI("TTS: Sample rate: %d Hz", pImpl->tts.value().SampleRate());
        LOGI("TTS: Number of speakers: %d", pImpl->tts.value().NumSpeakers());

        result.success = true;
        result.detectedModels = detect.detectedModels;
        return result;
    } catch (const std::exception& e) {
        result.error = std::string("TTS init exception: ") + e.what();
        LOGE("TTS: Exception during initialization: %s", e.what());
        return result;
    } catch (...) {
        result.error = "TTS: Unknown exception during initialization";
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

        auto audio = pImpl->tts.value().Generate(text, sid, speed);

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

TtsWrapper::AudioResult TtsWrapper::generate(
    const std::string& text,
    int32_t sid,
    float speed,
    const std::optional<VoiceCloneOptions>& cloning
) {
    if (!cloning.has_value() || cloning->reference_audio.empty() ||
        cloning->reference_sample_rate <= 0) {
        return generate(text, sid, speed);
    }

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
        sherpa_onnx::cxx::GenerationConfig gc;
        gc.silence_scale = cloning->silence_scale;
        gc.speed = speed;
        gc.sid = sid;
        gc.reference_audio = cloning->reference_audio;
        gc.reference_sample_rate = cloning->reference_sample_rate;
        gc.reference_text = cloning->reference_text;
        gc.num_steps = cloning->num_steps;
        gc.extra = cloning->extra;

        auto audio = pImpl->tts.value().Generate(text, gc);
        result.samples = std::move(audio.samples);
        result.sampleRate = audio.sample_rate;
        LOGI("TTS: Generated (voice clone) %zu samples at %d Hz", result.samples.size(), result.sampleRate);
        return result;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during generation (clone): %s", e.what());
        return result;
    } catch (...) {
        LOGE("TTS: Unknown exception during generation (clone)");
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

bool TtsWrapper::generateStream(
    const std::string& text,
    int32_t sid,
    float speed,
    const TtsStreamCallback& callback,
    const std::optional<VoiceCloneOptions>& cloning
) {
    if (!cloning.has_value() || cloning->reference_audio.empty() ||
        cloning->reference_sample_rate <= 0) {
        return generateStream(text, sid, speed, callback);
    }

    if (!pImpl->initialized || !pImpl->tts.has_value()) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return false;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return false;
    }

    try {
        auto callbackCopy = callback;
        auto shim = [](const float *samples, int32_t numSamples, float progress, void *arg) -> int32_t {
            auto *cb = reinterpret_cast<TtsStreamCallback*>(arg);
            if (!cb || !(*cb)) return 0;
            return (*cb)(samples, numSamples, progress);
        };

        sherpa_onnx::cxx::GenerationConfig gc;
        gc.silence_scale = cloning->silence_scale;
        gc.speed = speed;
        gc.sid = sid;
        gc.reference_audio = cloning->reference_audio;
        gc.reference_sample_rate = cloning->reference_sample_rate;
        gc.reference_text = cloning->reference_text;
        gc.num_steps = cloning->num_steps;
        gc.extra = cloning->extra;

        pImpl->tts.value().Generate(
            text,
            gc,
            callbackCopy ? shim : nullptr,
            callbackCopy ? &callbackCopy : nullptr
        );

        return true;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during streaming generation (clone): %s", e.what());
        return false;
    } catch (...) {
        LOGE("TTS: Unknown exception during streaming generation (clone)");
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
        pImpl->modelKind = TtsModelKind::kUnknown;
        LOGI("TTS: Resources released");
    }
}

TtsModelKind TtsWrapper::getModelKind() const {
    return pImpl->modelKind;
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

        const int32_t numChannels = 1;
        const int32_t bitsPerSample = 16;
        const int32_t byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const int32_t blockAlign = numChannels * bitsPerSample / 8;
        const int32_t dataSize = static_cast<int32_t>(samples.size()) * bitsPerSample / 8;
        const int32_t chunkSize = 36 + dataSize;

        outfile.write("RIFF", 4);
        outfile.write(reinterpret_cast<const char*>(&chunkSize), 4);
        outfile.write("WAVE", 4);

        outfile.write("fmt ", 4);
        const int32_t subchunk1Size = 16;
        outfile.write(reinterpret_cast<const char*>(&subchunk1Size), 4);
        const int16_t audioFormat = 1;
        outfile.write(reinterpret_cast<const char*>(&audioFormat), 2);
        const int16_t numChannelsInt16 = static_cast<int16_t>(numChannels);
        outfile.write(reinterpret_cast<const char*>(&numChannelsInt16), 2);
        outfile.write(reinterpret_cast<const char*>(&sampleRate), 4);
        outfile.write(reinterpret_cast<const char*>(&byteRate), 4);
        const int16_t blockAlignInt16 = static_cast<int16_t>(blockAlign);
        outfile.write(reinterpret_cast<const char*>(&blockAlignInt16), 2);
        const int16_t bitsPerSampleInt16 = static_cast<int16_t>(bitsPerSample);
        outfile.write(reinterpret_cast<const char*>(&bitsPerSampleInt16), 2);

        outfile.write("data", 4);
        outfile.write(reinterpret_cast<const char*>(&dataSize), 4);

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
