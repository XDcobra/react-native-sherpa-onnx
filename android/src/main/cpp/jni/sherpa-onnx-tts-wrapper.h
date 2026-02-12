#ifndef SHERPA_ONNX_TTS_WRAPPER_H
#define SHERPA_ONNX_TTS_WRAPPER_H

#include "sherpa-onnx-common.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

/**
 * Result of TTS initialization.
 */
struct TtsInitializeResult {
    bool success;
    std::string error;
    std::vector<DetectedModel> detectedModels;  // List of detected models with type and path
};

/**
 * Wrapper class for sherpa-onnx OfflineTts.
 * This provides a C++ interface for Text-to-Speech functionality.
 */
class TtsWrapper {
public:
    TtsWrapper();
    ~TtsWrapper();

    /**
     * Initialize TTS with model directory.
     * @param modelDir Path to the model directory
     * @param modelType Model type ('vits', 'matcha', 'kokoro', 'kitten', 'zipvoice', 'auto')
     * @param numThreads Number of threads for inference (default: 2)
     * @param debug Enable debug logging (default: false)
     * @return TtsInitializeResult with success status and list of detected usable models
     */
    TtsInitializeResult initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 2,
        bool debug = false,
        std::optional<float> noiseScale = std::nullopt,
        std::optional<float> noiseScaleW = std::nullopt,
        std::optional<float> lengthScale = std::nullopt
    );

    /**
     * Audio generation result.
     */
    struct AudioResult {
        std::vector<float> samples;  // Audio samples in range [-1.0, 1.0]
        int32_t sampleRate;           // Sample rate in Hz
    };

    using StreamId = uint64_t;

    using TtsStreamCallback = std::function<int32_t(
        const float *samples,
        int32_t numSamples,
        float progress
    )>;

    /**
     * Generate speech from text.
     * @param text Text to convert to speech
     * @param sid Speaker ID for multi-speaker models (default: 0)
     * @param speed Speech speed multiplier (default: 1.0)
     * @return AudioResult with samples and sample rate
     */
    AudioResult generate(
        const std::string& text,
        int32_t sid = 0,
        float speed = 1.0f
    );

    /**
     * Generate speech with streaming callback.
     * @param text Text to convert to speech
     * @param sid Speaker ID for multi-speaker models (default: 0)
     * @param speed Speech speed multiplier (default: 1.0)
     * @param callback Callback invoked with partial audio samples
     * @return true if generation started, false on error
     */
    bool generateStream(
        const std::string& text,
        int32_t sid,
        float speed,
        StreamId streamId,
        const TtsStreamCallback& callback
    );

    /**
     * Cancel a streaming TTS callback and release its resources by ID.
     */
    void cancelStream(StreamId streamId);

    /**
     * Mark a stream as completed and release its resources by ID.
     */
    void endStream(StreamId streamId);

    /**
     * Save audio samples to a WAV file.
     * @param samples Audio samples vector
     * @param sampleRate Sample rate in Hz
     * @param filePath Output file path
     * @return true if successful, false otherwise
     */
    static bool saveToWavFile(
        const std::vector<float>& samples,
        int32_t sampleRate,
        const std::string& filePath
    );

    /**
     * Get the sample rate of the initialized TTS model.
     * @return Sample rate in Hz
     */
    int32_t getSampleRate() const;

    /**
     * Get the number of speakers/voices available in the model.
     * @return Number of speakers (0 or 1 for single-speaker models)
     */
    int32_t getNumSpeakers() const;

    /**
     * Check if the TTS is initialized.
     * @return true if initialized, false otherwise
     */
    bool isInitialized() const;

    /**
     * Release resources.
     */
    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_TTS_WRAPPER_H
