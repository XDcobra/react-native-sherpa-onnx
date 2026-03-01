/**
 * sherpa-onnx-online-stt-wrapper.h
 *
 * Purpose: Wraps sherpa-onnx C++ OnlineRecognizer for iOS streaming STT.
 * Manages recognizer instances and streams; scans model directory for paths.
 * Used by SherpaOnnx+OnlineSTT.mm.
 */

#ifndef SHERPA_ONNX_ONLINE_STT_WRAPPER_H
#define SHERPA_ONNX_ONLINE_STT_WRAPPER_H

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpaonnx {

struct OnlineSttInitResult {
    bool success = false;
    std::string error;
};

struct OnlineSttStreamResult {
    std::string text;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
    bool isEndpoint = false;
};

/**
 * Wrapper for sherpa-onnx OnlineRecognizer (streaming STT).
 * One wrapper per instanceId; multiple streams per instance.
 */
class OnlineSttWrapper {
public:
    OnlineSttWrapper();
    ~OnlineSttWrapper();

    OnlineSttInitResult initialize(
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
        bool rule1MustContainNonSilence,
        float rule1MinTrailingSilence,
        float rule1MinUtteranceLength,
        bool rule2MustContainNonSilence,
        float rule2MinTrailingSilence,
        float rule2MinUtteranceLength,
        bool rule3MustContainNonSilence,
        float rule3MinTrailingSilence,
        float rule3MinUtteranceLength
    );

    bool createStream(const std::string& streamId, const std::string& hotwords);
    void acceptWaveform(const std::string& streamId, int32_t sampleRate, const float* samples, size_t n);
    void inputFinished(const std::string& streamId);
    void decode(const std::string& streamId);
    bool isReady(const std::string& streamId);
    OnlineSttStreamResult getResult(const std::string& streamId);
    bool isEndpoint(const std::string& streamId);
    void resetStream(const std::string& streamId);
    void releaseStream(const std::string& streamId);
    void unload();

    bool isInitialized() const;

private:
    struct Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_ONLINE_STT_WRAPPER_H
