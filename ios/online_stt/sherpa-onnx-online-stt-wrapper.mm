/**
 * sherpa-onnx-online-stt-wrapper.mm
 *
 * Purpose: Wraps sherpa-onnx C++ OnlineRecognizer for iOS streaming STT.
 * Scans model directory, builds config, manages recognizer and streams.
 */

#include "sherpa-onnx-online-stt-wrapper.h"
#include "sherpa-onnx-model-detect-helper.h"

#include "sherpa-onnx/c-api/cxx-api.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>

#ifdef __APPLE__
#import <Foundation/Foundation.h>
#define LOGO(fmt, ...) NSLog(@"OnlineSttWrapper: " fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) NSLog(@"OnlineSttWrapper ERROR: " fmt, ##__VA_ARGS__)
#else
#define LOGO(...)
#define LOGE(...)
#endif

namespace sherpaonnx {

using namespace model_detect;

namespace {

/** Scan model directory for online model type; returns paths map (encoder, decoder, joiner, tokens or model, tokens). */
std::unordered_map<std::string, std::string> scanOnlineModelPaths(const std::string& modelDir, const std::string& modelType) {
    std::unordered_map<std::string, std::string> out;
    const int kMaxDepth = 4;
    std::vector<FileEntry> files = ListFilesRecursive(modelDir, kMaxDepth);

    auto firstOnnx = [&files](const std::vector<std::string>& tokens) -> std::string {
        return FindOnnxByAnyToken(files, tokens, std::nullopt);
    };
    std::string tokensPath = FindFileEndingWith(files, "tokens.txt");

    if (modelType == "transducer") {
        std::string enc = firstOnnx({"encoder"});
        std::string dec = firstOnnx({"decoder"});
        std::string join = firstOnnx({"joiner"});
        if (enc.empty() || dec.empty() || join.empty()) {
            return {};
        }
        out["encoder"] = enc;
        out["decoder"] = dec;
        out["joiner"] = join;
        out["tokens"] = tokensPath;
        return out;
    }
    if (modelType == "paraformer") {
        std::string enc = firstOnnx({"encoder"});
        std::string dec = firstOnnx({"decoder"});
        if (enc.empty() || dec.empty()) return {};
        out["encoder"] = enc;
        out["decoder"] = dec;
        out["tokens"] = tokensPath;
        return out;
    }
    if (modelType == "zipformer2_ctc" || modelType == "nemo_ctc" || modelType == "tone_ctc") {
        std::string modelPath = firstOnnx({"model"});
        if (modelPath.empty()) {
            std::vector<std::string> exclude = {"encoder", "decoder", "joiner", "vocoder", "acoustic", "embedding", "llm"};
            modelPath = FindLargestOnnxExcludingTokens(files, exclude);
        }
        if (modelPath.empty()) return {};
        out["model"] = modelPath;
        out["tokens"] = tokensPath;
        return out;
    }
    return {};
}

} // namespace

struct OnlineSttWrapper::Impl {
    std::unique_ptr<sherpa_onnx::cxx::OnlineRecognizer> recognizer;
    std::unordered_map<std::string, sherpa_onnx::cxx::OnlineStream> streams;
    bool initialized = false;
};

OnlineSttWrapper::OnlineSttWrapper() : pImpl(std::make_unique<Impl>()) {}

OnlineSttWrapper::~OnlineSttWrapper() {
    unload();
}

OnlineSttInitResult OnlineSttWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    bool enableEndpoint,
    const std::string& decodingMethod,
    int32_t maxActivePaths,
    const std::string& hotwordsFile,
    float hotwordsScore,
    int32_t numThreads,
    const std::string& provider,
    const std::string& ruleFsts,
    const std::string& ruleFars,
    float blankPenalty,
    bool debug,
    bool /* rule1MustContainNonSilence */,
    float rule1MinTrailingSilence,
    float rule1MinUtteranceLength,
    bool /* rule2MustContainNonSilence */,
    float rule2MinTrailingSilence,
    float rule2MinUtteranceLength,
    bool /* rule3MustContainNonSilence */,
    float rule3MinTrailingSilence,
    float rule3MinUtteranceLength
) {
    OnlineSttInitResult result;
    if (pImpl->initialized) {
        result.error = "Already initialized";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    auto paths = scanOnlineModelPaths(modelDir, modelType);
    if (paths.empty()) {
        result.error = "Unsupported or invalid online STT model type or missing files: " + modelType;
        return result;
    }

    sherpa_onnx::cxx::OnlineRecognizerConfig config;
    config.feat_config.sample_rate = 16000;
    config.feat_config.feature_dim = 80;
    config.decoding_method = decodingMethod.empty() ? "greedy_search" : decodingMethod;
    config.max_active_paths = maxActivePaths;
    config.enable_endpoint = enableEndpoint;
    config.rule1_min_trailing_silence = rule1MinTrailingSilence > 0 ? rule1MinTrailingSilence : 2.4f;
    config.rule2_min_trailing_silence = rule2MinTrailingSilence > 0 ? rule2MinTrailingSilence : 1.2f;
    config.rule3_min_utterance_length = rule3MinUtteranceLength > 0 ? rule3MinUtteranceLength : 20.f;
    config.hotwords_file = hotwordsFile;
    config.hotwords_score = hotwordsScore;
    config.rule_fsts = ruleFsts;
    config.rule_fars = ruleFars;
    config.blank_penalty = blankPenalty;
    config.model_config.num_threads = numThreads <= 0 ? 1 : numThreads;
    config.model_config.provider = provider.empty() ? "cpu" : provider;
    config.model_config.debug = debug;
    config.model_config.tokens = paths.count("tokens") ? paths["tokens"] : "";

    if (modelType == "transducer") {
        config.model_config.transducer.encoder = paths["encoder"];
        config.model_config.transducer.decoder = paths["decoder"];
        config.model_config.transducer.joiner = paths["joiner"];
        config.model_config.model_type = "zipformer";
    } else if (modelType == "paraformer") {
        config.model_config.paraformer.encoder = paths["encoder"];
        config.model_config.paraformer.decoder = paths["decoder"];
        config.model_config.model_type = "paraformer";
    } else if (modelType == "zipformer2_ctc") {
        config.model_config.zipformer2_ctc.model = paths["model"];
        config.model_config.model_type = "zipformer2";
    } else if (modelType == "nemo_ctc") {
        config.model_config.nemo_ctc.model = paths["model"];
        config.model_config.model_type = "nemo_ctc";
    } else if (modelType == "tone_ctc") {
        config.model_config.t_one_ctc.model = paths["model"];
        config.model_config.model_type = "t_one";
    } else {
        result.error = "Unsupported online STT model type: " + modelType;
        return result;
    }

    try {
        sherpa_onnx::cxx::OnlineRecognizer rec = sherpa_onnx::cxx::OnlineRecognizer::Create(config);
        pImpl->recognizer = std::make_unique<sherpa_onnx::cxx::OnlineRecognizer>(std::move(rec));
        pImpl->initialized = true;
        result.success = true;
    } catch (const std::exception& e) {
        result.error = std::string("OnlineRecognizer Create failed: ") + e.what();
        LOGE("%s", result.error.c_str());
    } catch (...) {
        result.error = "OnlineRecognizer Create failed: unknown error";
        LOGE("%s", result.error.c_str());
    }
    return result;
}

bool OnlineSttWrapper::createStream(const std::string& streamId, const std::string& hotwords) {
    if (!pImpl->initialized || !pImpl->recognizer) return false;
    if (pImpl->streams.count(streamId)) return false;
    try {
        sherpa_onnx::cxx::OnlineStream stream = hotwords.empty()
            ? pImpl->recognizer->CreateStream()
            : pImpl->recognizer->CreateStream(hotwords);
        pImpl->streams.emplace(streamId, std::move(stream));
        return true;
    } catch (...) {
        return false;
    }
}

void OnlineSttWrapper::acceptWaveform(const std::string& streamId, int32_t sampleRate, const float* samples, size_t n) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end()) return;
    it->second.AcceptWaveform(sampleRate, samples, static_cast<int32_t>(n));
}

void OnlineSttWrapper::inputFinished(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end()) return;
    it->second.InputFinished();
}

void OnlineSttWrapper::decode(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->recognizer) return;
    pImpl->recognizer->Decode(&it->second);
}

bool OnlineSttWrapper::isReady(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->recognizer) return false;
    return pImpl->recognizer->IsReady(&it->second);
}

OnlineSttStreamResult OnlineSttWrapper::getResult(const std::string& streamId) {
    OnlineSttStreamResult r;
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->recognizer) return r;
    sherpa_onnx::cxx::OnlineRecognizerResult res = pImpl->recognizer->GetResult(&it->second);
    r.text = res.text;
    r.tokens = res.tokens;
    r.timestamps = res.timestamps;
    return r;
}

bool OnlineSttWrapper::isEndpoint(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->recognizer) return false;
    return pImpl->recognizer->IsEndpoint(&it->second);
}

void OnlineSttWrapper::resetStream(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->recognizer) return;
    pImpl->recognizer->Reset(&it->second);
}

void OnlineSttWrapper::releaseStream(const std::string& streamId) {
    pImpl->streams.erase(streamId);
}

void OnlineSttWrapper::unload() {
    pImpl->streams.clear();
    pImpl->recognizer.reset();
    pImpl->initialized = false;
}

bool OnlineSttWrapper::isInitialized() const {
    return pImpl->initialized && pImpl->recognizer != nullptr;
}

} // namespace sherpaonnx
