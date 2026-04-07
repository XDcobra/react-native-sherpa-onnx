/**
 * sherpa-onnx-kws-wrapper.h
 *
 * Purpose: Wraps sherpa-onnx C++ KeywordSpotter for iOS keyword spotting.
 * Manages spotter instances and streams; scans model directory for paths.
 * Used by SherpaOnnx+KWS.mm.
 */

#ifndef SHERPA_ONNX_KWS_WRAPPER_H
#define SHERPA_ONNX_KWS_WRAPPER_H

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpaonnx {

struct KwsInitResult {
    bool success = false;
    std::string error;
};

struct KwsStreamResult {
    std::string keyword;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
};

/**
 * Wrapper for sherpa-onnx KeywordSpotter (keyword spotting).
 * One wrapper per instanceId; multiple streams per instance.
 */
class KwsWrapper {
public:
    KwsWrapper();
    ~KwsWrapper();

    KwsInitResult initialize(
        const std::string& modelDir,
        const std::string& keywordsFile,
        float keywordsScore,
        float keywordsThreshold,
        int32_t numTrailingBlanks,
        int32_t maxActivePaths,
        int32_t numThreads,
        const std::string& provider,
        bool debug
    );

    bool createStream(const std::string& streamId, const std::string& keywords);
    void acceptWaveform(const std::string& streamId, int32_t sampleRate, const float* samples, size_t n);
    void decode(const std::string& streamId);
    bool isReady(const std::string& streamId);
    KwsStreamResult getResult(const std::string& streamId);
    void resetStream(const std::string& streamId);
    void releaseStream(const std::string& streamId);
    void unload();

    bool isInitialized() const;

private:
    struct Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_KWS_WRAPPER_H
