#ifndef SHERPA_ONNX_WRAPPER_H
#define SHERPA_ONNX_WRAPPER_H

#include <string>
#include <memory>
#include <optional>

namespace sherpaonnx {

/**
 * Wrapper class for sherpa-onnx OfflineRecognizer (STT).
 * This provides a C++ interface that can be easily called from iOS Objective-C++.
 */
class SttWrapper {
public:
    SttWrapper();
    ~SttWrapper();

    /**
     * Initialize sherpa-onnx with model directory.
     * @param modelDir Path to the model directory
     * @param preferInt8 Optional: true = prefer int8 models, false = prefer regular models, nullopt = try int8 first (default)
     * @param modelType Optional: explicit model type ("transducer", "paraformer", "nemo_ctc"), nullopt = auto-detect (default)
     * @return true if successful, false otherwise
     */
    bool initialize(
        const std::string& modelDir,
        const std::optional<bool>& preferInt8 = std::nullopt,
        const std::optional<std::string>& modelType = std::nullopt
    );

    /**
     * Transcribe an audio file.
     * @param filePath Path to the audio file (WAV 16kHz mono 16-bit PCM)
     * @return Transcribed text
     */
    std::string transcribeFile(const std::string& filePath);

    /**
     * Check if the recognizer is initialized.
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

/**
 * Wrapper class for sherpa-onnx OfflineTts.
 * This provides a C++ interface for Text-to-Speech functionality.
 * Shared between iOS and Android.
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
     * @return true if successful, false otherwise
     */
    bool initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 2,
        bool debug = false
    );

    /**
     * Audio generation result.
     */
    struct AudioResult {
        std::vector<float> samples;  // Audio samples in range [-1.0, 1.0]
        int32_t sampleRate;           // Sample rate in Hz
    };

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

#endif // SHERPA_ONNX_WRAPPER_H
