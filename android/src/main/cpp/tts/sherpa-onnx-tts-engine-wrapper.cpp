/**
 * sherpa-onnx-tts-engine-wrapper.cpp
 *
 * Shared CXX OfflineTts wrapper for TTS (Android + iOS). Builds config from
 * TtsModelPaths, creates TTS instance, generates audio from text.
 */

#include "sherpa-onnx-tts-engine-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-validate-tts.h"
#include <cctype>
#include <cstdio>
#include <cstring>
#include <optional>
#include <sstream>

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:tts", __VA_ARGS__)
#define LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:tts", __VA_ARGS__)
#elif defined(__APPLE__)
#define LOGI(...)                                                       \
  do {                                                                  \
    std::fprintf(stderr, "[SherpaOnnx:tts] ");                          \
    std::fprintf(stderr, __VA_ARGS__);                                  \
    std::fprintf(stderr, "\n");                                         \
  } while (0)
#define LOGE(...) LOGI(__VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

// Use C++17 filesystem (podspec enforces C++17)
#include <filesystem>
namespace fs = std::filesystem;

// sherpa-onnx headers - use C++ API (RAII wrapper around C API)
#include "sherpa-onnx/c-api/cxx-api.h"

namespace sherpaonnx {

namespace {

TtsModelKind ParseTtsModelTypeFromString(const std::string& modelType) {
    if (modelType == "vits") return TtsModelKind::kVits;
    if (modelType == "matcha") return TtsModelKind::kMatcha;
    if (modelType == "kokoro") return TtsModelKind::kKokoro;
    if (modelType == "kitten") return TtsModelKind::kKitten;
    if (modelType == "pocket") return TtsModelKind::kPocket;
    if (modelType == "zipvoice") return TtsModelKind::kZipvoice;
    if (modelType == "supertonic") return TtsModelKind::kSupertonic;
    return TtsModelKind::kUnknown;
}

bool HasPhonemeOrTokenInput(const std::optional<VoiceCloneOptions>& cloning) {
    return cloning.has_value() &&
        (!cloning->phoneme_codepoints.empty() || !cloning->tokens.empty());
}

void ApplyPhonemesToGc(
    sherpa_onnx::cxx::GenerationConfig& gc,
    const VoiceCloneOptions& vo
) {
    gc.phoneme_codepoints = vo.phoneme_codepoints;
    gc.tokens = vo.tokens;
}

bool ShouldRejectEmptyText(const std::string& text, bool allowEmpty) {
    if (!text.empty() || allowEmpty) return false;
    LOGE("TTS: Input text is empty");
    return true;
}

bool HasLiveTtsHandle(const std::optional<sherpa_onnx::cxx::OfflineTts>& tts) {
    return tts.has_value() && tts->Get() != nullptr;
}

bool VoiceCloneHasReferencePcm(const VoiceCloneOptions& options) {
    if (options.reference_sample_rate <= 0) return false;
    if (!options.reference_audio.empty()) return true;
    return options.reference_pcm != nullptr && options.reference_pcm_count > 0;
}

void AssignVoiceCloneReference(sherpa_onnx::cxx::GenerationConfig& gc,
                               const VoiceCloneOptions& options) {
    if (!options.reference_audio.empty()) {
        gc.reference_audio = options.reference_audio;
    } else if (options.reference_pcm != nullptr && options.reference_pcm_count > 0) {
        gc.reference_audio.assign(options.reference_pcm,
                                  options.reference_pcm + options.reference_pcm_count);
    }
}

}  // namespace

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
    const std::optional<std::string>& provider,
    const std::optional<std::string>& lexiconLanguageId,
    const std::optional<std::string>& kokoroLang
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

        auto detect = DetectTtsModel(
            std::optional<std::string>(modelDir), std::nullopt, modelType);
        if (!detect.ok) {
            result.error = detect.error;
            LOGE("%s", detect.error.c_str());
            return result;
        }

        std::string lexiconPath = ResolveLexiconPath(
            detect.lexiconLanguages,
            lexiconLanguageId.value_or(""));
        if (!lexiconPath.empty()) {
            detect.paths.lexicon = lexiconPath;
        } else if (lexiconLanguageId.has_value() && !lexiconLanguageId->empty()) {
            result.error = "lexiconLanguageId '" + *lexiconLanguageId + "' not found in detected lexiconLanguages";
            LOGE("%s", result.error.c_str());
            return result;
        }

        switch (detect.selectedKind) {
            case TtsModelKind::kVits:
                config.model.vits.model = detect.paths.ttsModel;
                config.model.vits.tokens = detect.paths.tokens;
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
                if (!detect.paths.lexicon.empty()) {
                    config.model.matcha.lexicon = detect.paths.lexicon;
                }
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
                config.model.kokoro.voices = detect.paths.voices;
                if (!detect.paths.lexicon.empty()) {
                    config.model.kokoro.lexicon = detect.paths.lexicon;
                }
                if (lengthScale.has_value()) {
                    config.model.kokoro.length_scale = *lengthScale;
                }
                if (kokoroLang.has_value() && !kokoroLang->empty()) {
                    config.model.kokoro.lang = *kokoroLang;
                }
                break;
            case TtsModelKind::kKitten:
                config.model.kitten.model = detect.paths.ttsModel;
                config.model.kitten.tokens = detect.paths.tokens;
                config.model.kitten.voices = detect.paths.voices;
                if (!detect.paths.lexicon.empty()) {
                    config.model.kitten.lexicon = detect.paths.lexicon;
                }
                if (lengthScale.has_value()) {
                    config.model.kitten.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kZipvoice:
                config.model.zipvoice.encoder = detect.paths.encoder;
                config.model.zipvoice.decoder = detect.paths.decoder;
                config.model.zipvoice.vocoder = detect.paths.vocoder;
                config.model.zipvoice.tokens = detect.paths.tokens;
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

        LOGI("TTS: modelDir=%s lexicon=%s", modelDir.c_str(),
             detect.paths.lexicon.empty() ? "(empty)" : detect.paths.lexicon.c_str());
        LOGI("TTS: Creating OfflineTts instance...");
        auto created = sherpa_onnx::cxx::OfflineTts::Create(config);
        if (created.Get() == nullptr) {
            result.error = "TTS: OfflineTts::Create returned null";
            LOGE("[SherpaOnnx:init] tts Create Get()==null branch=reject");
            return result;
        }
        pImpl->tts = std::move(created);
        LOGI("[SherpaOnnx:init] tts Create Get() ok");

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

TtsInitializeResult TtsWrapper::initializeCustom(
    const std::string& modelType,
    const TtsModelPaths& paths,
    int32_t numThreads,
    bool debug,
    const std::optional<float>& noiseScale,
    const std::optional<float>& noiseScaleW,
    const std::optional<float>& lengthScale,
    const std::optional<std::string>& ruleFsts,
    const std::optional<std::string>& ruleFars,
    const std::optional<int32_t>& maxNumSentences,
    const std::optional<float>& silenceScale,
    const std::optional<std::string>& provider,
    const std::optional<std::string>& kokoroLang
) {
    TtsInitializeResult result;
    result.success = false;

    if (pImpl->initialized) {
        release();
    }

    const TtsModelKind selectedKind = ParseTtsModelTypeFromString(modelType);
    if (selectedKind == TtsModelKind::kUnknown) {
        result.error = "Unsupported custom TTS model type: " + modelType;
        LOGE("%s", result.error.c_str());
        return result;
    }

    auto validation = ValidateTtsPaths(selectedKind, paths, "custom");
    if (!validation.ok) {
        result.error = validation.error;
        LOGE("%s", result.error.c_str());
        return result;
    }

    try {
        sherpa_onnx::cxx::OfflineTtsConfig config;
        config.model.num_threads = numThreads;
        config.model.debug = debug;
        if (provider.has_value() && !provider->empty()) {
            config.model.provider = *provider;
        }

        switch (selectedKind) {
            case TtsModelKind::kVits:
                config.model.vits.model = paths.ttsModel;
                config.model.vits.tokens = paths.tokens;
                if (!paths.lexicon.empty()) {
                    config.model.vits.lexicon = paths.lexicon;
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
                config.model.matcha.acoustic_model = paths.acousticModel;
                config.model.matcha.vocoder = paths.vocoder;
                config.model.matcha.tokens = paths.tokens;
                if (!paths.lexicon.empty()) {
                    config.model.matcha.lexicon = paths.lexicon;
                }
                if (noiseScale.has_value()) {
                    config.model.matcha.noise_scale = *noiseScale;
                }
                if (lengthScale.has_value()) {
                    config.model.matcha.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kKokoro:
                config.model.kokoro.model = paths.ttsModel;
                config.model.kokoro.tokens = paths.tokens;
                config.model.kokoro.voices = paths.voices;
                if (!paths.lexicon.empty()) {
                    config.model.kokoro.lexicon = paths.lexicon;
                }
                if (lengthScale.has_value()) {
                    config.model.kokoro.length_scale = *lengthScale;
                }
                if (kokoroLang.has_value() && !kokoroLang->empty()) {
                    config.model.kokoro.lang = *kokoroLang;
                }
                break;
            case TtsModelKind::kKitten:
                config.model.kitten.model = paths.ttsModel;
                config.model.kitten.tokens = paths.tokens;
                config.model.kitten.voices = paths.voices;
                if (!paths.lexicon.empty()) {
                    config.model.kitten.lexicon = paths.lexicon;
                }
                if (lengthScale.has_value()) {
                    config.model.kitten.length_scale = *lengthScale;
                }
                break;
            case TtsModelKind::kZipvoice:
                config.model.zipvoice.encoder = paths.encoder;
                config.model.zipvoice.decoder = paths.decoder;
                config.model.zipvoice.vocoder = paths.vocoder;
                config.model.zipvoice.tokens = paths.tokens;
                if (!paths.lexicon.empty()) {
                    config.model.zipvoice.lexicon = paths.lexicon;
                }
                config.model.num_threads = 1;
                break;
            case TtsModelKind::kPocket:
                config.model.pocket.lm_flow = paths.lmFlow;
                config.model.pocket.lm_main = paths.lmMain;
                config.model.pocket.encoder = paths.encoder;
                config.model.pocket.decoder = paths.decoder;
                config.model.pocket.text_conditioner = paths.textConditioner;
                config.model.pocket.vocab_json = paths.vocabJson;
                config.model.pocket.token_scores_json = paths.tokenScoresJson;
                break;
            case TtsModelKind::kSupertonic:
                config.model.supertonic.duration_predictor = paths.durationPredictor;
                config.model.supertonic.text_encoder = paths.textEncoder;
                config.model.supertonic.vector_estimator = paths.vectorEstimator;
                config.model.supertonic.vocoder = paths.vocoder;
                config.model.supertonic.tts_json = paths.ttsJson;
                config.model.supertonic.unicode_indexer = paths.unicodeIndexer;
                config.model.supertonic.voice_style = paths.voiceStyle;
                break;
            case TtsModelKind::kUnknown:
            default:
                result.error = "TTS: Unknown model type: " + modelType;
                LOGE("TTS: Unknown model type: %s", modelType.c_str());
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

        LOGI("TTS: Creating OfflineTts instance (custom init)...");
        auto created = sherpa_onnx::cxx::OfflineTts::Create(config);
        if (created.Get() == nullptr) {
            result.error = "TTS: OfflineTts::Create returned null";
            LOGE("[SherpaOnnx:init] tts custom Create Get()==null branch=reject");
            return result;
        }
        pImpl->tts = std::move(created);
        LOGI("[SherpaOnnx:init] tts custom Create Get() ok");

        pImpl->initialized = true;
        pImpl->modelDir = "custom";
        pImpl->modelKind = selectedKind;

        LOGI("TTS: Custom initialization successful");
        result.success = true;
        result.detectedModels.push_back({modelType, "custom"});
        return result;
    } catch (const std::exception& e) {
        result.error = std::string("TTS custom init exception: ") + e.what();
        LOGE("TTS: Exception during custom initialization: %s", e.what());
        return result;
    } catch (...) {
        result.error = "TTS: Unknown exception during custom initialization";
        LOGE("TTS: Unknown exception during custom initialization");
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

    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
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
    int32_t numSteps
) {
    AudioResult result;
    result.sampleRate = 0;

    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return result;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return result;
    }

    try {
        LOGI("TTS: Generating speech for text: %s (sid=%d, speed=%.2f, num_steps=%d)",
             text.c_str(), sid, speed, numSteps);

        sherpa_onnx::cxx::GenerationConfig gc;
        gc.speed = speed;
        gc.sid = sid;
        gc.num_steps = numSteps;

        auto audio = pImpl->tts.value().Generate(text, gc);

        result.samples = std::move(audio.samples);
        result.sampleRate = audio.sample_rate;

        LOGI("TTS: Generated %zu samples at %d Hz",
             result.samples.size(), result.sampleRate);

        return result;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during generation (numSteps): %s", e.what());
        return result;
    } catch (...) {
        LOGE("TTS: Unknown exception during generation (numSteps)");
        return result;
    }
}

TtsWrapper::AudioResult TtsWrapper::generate(
    const std::string& text,
    int32_t sid,
    float speed,
    const std::optional<VoiceCloneOptions>& cloning
) {
    if (cloning.has_value() &&
        !VoiceCloneHasReferencePcm(*cloning) &&
        (!cloning->extra.empty() || cloning->apply_num_steps ||
         !cloning->phoneme_codepoints.empty() || !cloning->tokens.empty())) {
        AudioResult result;
        result.sampleRate = 0;

        if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
            LOGE("TTS: Not initialized. Call initialize() first.");
            return result;
        }

        if (ShouldRejectEmptyText(text, HasPhonemeOrTokenInput(cloning))) {
            return result;
        }

        try {
            sherpa_onnx::cxx::GenerationConfig gc;
            gc.speed = speed;
            gc.sid = sid;
            if (cloning->apply_num_steps) {
                gc.num_steps = cloning->num_steps;
            }
            if (!cloning->extra.empty()) {
                gc.extra = cloning->extra;
            }
            ApplyPhonemesToGc(gc, *cloning);
            auto audio = pImpl->tts.value().Generate(text, gc);
            result.samples = std::move(audio.samples);
            result.sampleRate = audio.sample_rate;
            return result;
        } catch (const std::exception& e) {
            LOGE("TTS: Exception during generation (extra/numSteps): %s", e.what());
            return result;
        } catch (...) {
            LOGE("TTS: Unknown exception during generation (extra/numSteps)");
            return result;
        }
    }

    if (!cloning.has_value() || !VoiceCloneHasReferencePcm(*cloning)) {
        return generate(text, sid, speed);
    }

    AudioResult result;
    result.sampleRate = 0;

    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return result;
    }

    if (ShouldRejectEmptyText(text, HasPhonemeOrTokenInput(cloning))) {
        return result;
    }

    try {
        sherpa_onnx::cxx::GenerationConfig gc;
        gc.silence_scale = cloning->silence_scale;
        gc.speed = speed;
        gc.sid = sid;
        AssignVoiceCloneReference(gc, *cloning);
        gc.reference_sample_rate = cloning->reference_sample_rate;
        gc.reference_text = cloning->reference_text;
        gc.num_steps = cloning->num_steps;
        gc.extra = cloning->extra;
        ApplyPhonemesToGc(gc, *cloning);

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
    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
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
    int32_t numSteps
) {
    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return false;
    }

    if (text.empty()) {
        LOGE("TTS: Input text is empty");
        return false;
    }

    try {
        LOGI("TTS: Streaming generation for text: %s (sid=%d, speed=%.2f, num_steps=%d)",
             text.c_str(), sid, speed, numSteps);

        auto callbackCopy = callback;
        auto shim = [](const float *samples, int32_t numSamples, float progress, void *arg) -> int32_t {
            auto *cb = reinterpret_cast<TtsStreamCallback*>(arg);
            if (!cb || !(*cb)) return 0;
            return (*cb)(samples, numSamples, progress);
        };

        sherpa_onnx::cxx::GenerationConfig gc;
        gc.speed = speed;
        gc.sid = sid;
        gc.num_steps = numSteps;

        pImpl->tts.value().Generate(
            text,
            gc,
            callbackCopy ? shim : nullptr,
            callbackCopy ? &callbackCopy : nullptr
        );

        return true;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during streaming generation (numSteps): %s", e.what());
        return false;
    } catch (...) {
        LOGE("TTS: Unknown exception during streaming generation (numSteps)");
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
    if (cloning.has_value() &&
        !VoiceCloneHasReferencePcm(*cloning) &&
        (cloning->apply_num_steps || !cloning->phoneme_codepoints.empty() ||
         !cloning->tokens.empty() || !cloning->extra.empty())) {
        if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
            LOGE("TTS: Not initialized. Call initialize() first.");
            return false;
        }
        if (ShouldRejectEmptyText(text, HasPhonemeOrTokenInput(cloning))) {
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
            gc.speed = speed;
            gc.sid = sid;
            if (cloning->apply_num_steps) {
                gc.num_steps = cloning->num_steps;
            }
            if (!cloning->extra.empty()) {
                gc.extra = cloning->extra;
            }
            ApplyPhonemesToGc(gc, *cloning);
            pImpl->tts.value().Generate(
                text,
                gc,
                callbackCopy ? shim : nullptr,
                callbackCopy ? &callbackCopy : nullptr
            );
            return true;
        } catch (const std::exception& e) {
            LOGE("TTS: Exception during streaming generation (extra/phonemes): %s", e.what());
            return false;
        } catch (...) {
            LOGE("TTS: Unknown exception during streaming generation (extra/phonemes)");
            return false;
        }
    }

    if (!cloning.has_value() || !VoiceCloneHasReferencePcm(*cloning)) {
        return generateStream(text, sid, speed, callback);
    }

    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return false;
    }

    if (ShouldRejectEmptyText(text, HasPhonemeOrTokenInput(cloning))) {
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
        AssignVoiceCloneReference(gc, *cloning);
        gc.reference_sample_rate = cloning->reference_sample_rate;
        gc.reference_text = cloning->reference_text;
        gc.num_steps = cloning->num_steps;
        gc.extra = cloning->extra;
        ApplyPhonemesToGc(gc, *cloning);

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
    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
        LOGE("TTS: Not initialized. Call initialize() first.");
        return 0;
    }
    return pImpl->tts.value().SampleRate();
}

int32_t TtsWrapper::getNumSpeakers() const {
    if (!pImpl->initialized || !HasLiveTtsHandle(pImpl->tts)) {
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

} // namespace sherpaonnx
