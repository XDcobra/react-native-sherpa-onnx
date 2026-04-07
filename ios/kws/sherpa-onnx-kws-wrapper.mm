/**
 * sherpa-onnx-kws-wrapper.mm
 *
 * Purpose: Wraps sherpa-onnx C++ KeywordSpotter for iOS keyword spotting.
 * Scans model directory, builds config, manages spotter and streams.
 */

#include "sherpa-onnx-kws-wrapper.h"
#include "sherpa-onnx-model-detect-helper.h"

#include "sherpa-onnx/c-api/cxx-api.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>

#ifdef __APPLE__
#import <Foundation/Foundation.h>
#define LOGO(fmt, ...) NSLog(@"KwsWrapper: " fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) NSLog(@"KwsWrapper ERROR: " fmt, ##__VA_ARGS__)
#else
#define LOGO(...)
#define LOGE(...)
#endif

namespace sherpaonnx {

using namespace model_detect;

namespace {

/** Scan model directory for KWS model paths; returns paths map (encoder, decoder, joiner, tokens, keywords). */
std::unordered_map<std::string, std::string> scanKwsModelPaths(const std::string& modelDir) {
    std::unordered_map<std::string, std::string> out;
    const int kMaxDepth = 4;
    std::vector<FileEntry> files = ListFilesRecursive(modelDir, kMaxDepth);

    auto firstOnnx = [&files](const std::vector<std::string>& tokens) -> std::string {
        return FindOnnxByAnyToken(files, tokens, std::nullopt);
    };
    std::string tokensPath = FindFileEndingWith(files, "tokens.txt");
    std::string keywordsPath = FindFileEndingWith(files, "keywords.txt");

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
    out["keywords"] = keywordsPath;
    return out;
}

} // namespace

struct KwsWrapper::Impl {
    std::unique_ptr<sherpa_onnx::cxx::KeywordSpotter> spotter;
    std::unordered_map<std::string, sherpa_onnx::cxx::OnlineStream> streams;
    bool initialized = false;
};

KwsWrapper::KwsWrapper() : pImpl(std::make_unique<Impl>()) {}

KwsWrapper::~KwsWrapper() {
    unload();
}

KwsInitResult KwsWrapper::initialize(
    const std::string& modelDir,
    const std::string& keywordsFile,
    float keywordsScore,
    float keywordsThreshold,
    int32_t numTrailingBlanks,
    int32_t maxActivePaths,
    int32_t numThreads,
    const std::string& provider,
    bool debug
) {
    KwsInitResult result;
    if (pImpl->initialized) {
        result.error = "Already initialized";
        return result;
    }
    if (!FileExists(modelDir) || !IsDirectory(modelDir)) {
        result.error = "Model directory does not exist or is not a directory: " + modelDir;
        return result;
    }

    auto paths = scanKwsModelPaths(modelDir);
    if (paths.empty()) {
        result.error = "Invalid KWS model or missing files in: " + modelDir;
        return result;
    }

    sherpa_onnx::cxx::KeywordSpotterConfig config;
    config.feat_config.sample_rate = 16000;
    config.feat_config.feature_dim = 80;
    config.model_config.transducer.encoder = paths["encoder"];
    config.model_config.transducer.decoder = paths["decoder"];
    config.model_config.transducer.joiner = paths["joiner"];
    config.model_config.tokens = paths.count("tokens") ? paths["tokens"] : "";
    config.model_config.num_threads = numThreads <= 0 ? 1 : numThreads;
    config.model_config.provider = provider.empty() ? "cpu" : provider;
    config.model_config.debug = debug;
    config.model_config.model_type = "zipformer";
    config.keywords_file = keywordsFile.empty() ? (paths.count("keywords") ? paths["keywords"] : "") : keywordsFile;
    config.keywords_score = keywordsScore;
    config.keywords_threshold = keywordsThreshold;
    config.num_trailing_blanks = numTrailingBlanks;
    config.max_active_paths = maxActivePaths;

    try {
        sherpa_onnx::cxx::KeywordSpotter sp = sherpa_onnx::cxx::KeywordSpotter::Create(config);
        pImpl->spotter = std::make_unique<sherpa_onnx::cxx::KeywordSpotter>(std::move(sp));
        pImpl->initialized = true;
        result.success = true;
    } catch (const std::exception& e) {
        result.error = std::string("KeywordSpotter Create failed: ") + e.what();
        LOGE("%s", result.error.c_str());
    } catch (...) {
        result.error = "KeywordSpotter Create failed: unknown error";
        LOGE("%s", result.error.c_str());
    }
    return result;
}

bool KwsWrapper::createStream(const std::string& streamId, const std::string& keywords) {
    if (!pImpl->initialized || !pImpl->spotter) return false;
    if (pImpl->streams.count(streamId)) return false;
    try {
        sherpa_onnx::cxx::OnlineStream stream = keywords.empty()
            ? pImpl->spotter->CreateStream()
            : pImpl->spotter->CreateStream(keywords);
        pImpl->streams.emplace(streamId, std::move(stream));
        return true;
    } catch (...) {
        return false;
    }
}

void KwsWrapper::acceptWaveform(const std::string& streamId, int32_t sampleRate, const float* samples, size_t n) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end()) return;
    it->second.AcceptWaveform(sampleRate, samples, static_cast<int32_t>(n));
}

void KwsWrapper::decode(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->spotter) return;
    pImpl->spotter->Decode(&it->second);
}

bool KwsWrapper::isReady(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->spotter) return false;
    return pImpl->spotter->IsReady(&it->second);
}

KwsStreamResult KwsWrapper::getResult(const std::string& streamId) {
    KwsStreamResult r;
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->spotter) return r;
    sherpa_onnx::cxx::KeywordResult res = pImpl->spotter->GetResult(&it->second);
    r.keyword = res.keyword;
    r.tokens = res.tokens;
    r.timestamps = res.timestamps;
    return r;
}

void KwsWrapper::resetStream(const std::string& streamId) {
    auto it = pImpl->streams.find(streamId);
    if (it == pImpl->streams.end() || !pImpl->spotter) return;
    pImpl->spotter->Reset(&it->second);
}

void KwsWrapper::releaseStream(const std::string& streamId) {
    pImpl->streams.erase(streamId);
}

void KwsWrapper::unload() {
    pImpl->streams.clear();
    pImpl->spotter.reset();
    pImpl->initialized = false;
}

bool KwsWrapper::isInitialized() const {
    return pImpl->initialized && pImpl->spotter != nullptr;
}

} // namespace sherpaonnx
