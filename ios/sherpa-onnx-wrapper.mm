#include "sherpa-onnx-wrapper.h"
#include <fstream>
#include <sstream>
#include <optional>
#include <algorithm>
#include <cctype>
#include <cstring>

// iOS logging
#ifdef __APPLE__
#include <Foundation/Foundation.h>
#include <cstdio>
#define LOGI(fmt, ...) NSLog(@"SttWrapper: " fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) NSLog(@"SttWrapper ERROR: " fmt, ##__VA_ARGS__)
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

// PIMPL pattern implementation
class SttWrapper::Impl {
public:
    bool initialized = false;
    std::string modelDir;
    std::optional<sherpa_onnx::cxx::OfflineRecognizer> recognizer;
};

SttWrapper::SttWrapper() : pImpl(std::make_unique<Impl>()) {
    LOGI("SttWrapper created");
}

SttWrapper::~SttWrapper() {
    release();
    LOGI("SttWrapper destroyed");
}

SttInitializeResult SttWrapper::initialize(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType
) {
    SttInitializeResult result;
    result.success = false;
    
    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("Model directory is empty");
        return result;
    }

    try {
        // Helper function to check if file exists
        auto fileExists = [](const std::string& path) -> bool {
            return fs::exists(path);
        };

        auto isDirectory = [](const std::string& path) -> bool {
            return fs::is_directory(path);
        };

        // Check if model directory exists
        if (!fileExists(modelDir) || !isDirectory(modelDir)) {
            LOGE("Model directory does not exist or is not a directory: %s", modelDir.c_str());
            return result;
        }

        // Setup configuration using C++ API
        sherpa_onnx::cxx::OfflineRecognizerConfig config;
        
        // Set default feature config (16kHz, 80-dim for most models)
        config.feat_config.sample_rate = 16000;
        config.feat_config.feature_dim = 80;
        
        // Build paths for model files
        std::string encoderPath = modelDir + "/encoder.onnx";
        std::string decoderPath = modelDir + "/decoder.onnx";
        std::string joinerPath = modelDir + "/joiner.onnx";
        std::string encoderPathInt8 = modelDir + "/encoder.int8.onnx";
        std::string decoderPathInt8 = modelDir + "/decoder.int8.onnx";
        std::string paraformerPathInt8 = modelDir + "/model.int8.onnx";
        std::string paraformerPath = modelDir + "/model.onnx";
        std::string ctcPathInt8 = modelDir + "/model.int8.onnx";
        std::string ctcPath = modelDir + "/model.onnx";
        std::string tokensPath = modelDir + "/tokens.txt";
        
        // FunASR Nano paths
        std::string funasrEncoderAdaptor = modelDir + "/encoder_adaptor.onnx";
        std::string funasrEncoderAdaptorInt8 = modelDir + "/encoder_adaptor.int8.onnx";
        std::string funasrLLM = modelDir + "/llm.onnx";
        std::string funasrLLMInt8 = modelDir + "/llm.int8.onnx";
        std::string funasrEmbedding = modelDir + "/embedding.onnx";
        std::string funasrEmbeddingInt8 = modelDir + "/embedding.int8.onnx";
        
        // Helper function to find FunASR Nano tokenizer directory
        auto findFunAsrTokenizer = [&fileExists, &modelDir]() -> std::string {
            std::string vocabInMain = modelDir + "/vocab.json";
            if (fileExists(vocabInMain)) {
                return modelDir;
            }
            
            try {
                for (const auto& entry : fs::directory_iterator(modelDir)) {
                    if (entry.is_directory()) {
                        std::string dirName = entry.path().filename().string();
                        std::string dirNameLower = dirName;
                        std::transform(dirNameLower.begin(), dirNameLower.end(), dirNameLower.begin(),
                                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                        if (dirNameLower.find("qwen3") != std::string::npos) {
                            std::string vocabPath = entry.path().string() + "/vocab.json";
                            if (fileExists(vocabPath)) {
                                return entry.path().string();
                            }
                        }
                    }
                }
            } catch (const std::exception& e) {
                // Error accessing directory
            }
            
            std::string commonPath = modelDir + "/Qwen3-0.6B";
            if (fileExists(commonPath + "/vocab.json")) {
                return commonPath;
            }
            
            return "";
        };
        
        std::string funasrTokenizer = findFunAsrTokenizer();

        bool tokensRequired = true;

        // Configure based on model type - same logic as Android version
        std::string paraformerModelPath;
        if (preferInt8.has_value()) {
            if (preferInt8.value()) {
                if (fileExists(paraformerPathInt8)) {
                    paraformerModelPath = paraformerPathInt8;
                } else if (fileExists(paraformerPath)) {
                    paraformerModelPath = paraformerPath;
                }
            } else {
                if (fileExists(paraformerPath)) {
                    paraformerModelPath = paraformerPath;
                } else if (fileExists(paraformerPathInt8)) {
                    paraformerModelPath = paraformerPathInt8;
                }
            }
        } else {
            if (fileExists(paraformerPathInt8)) {
                paraformerModelPath = paraformerPathInt8;
            } else if (fileExists(paraformerPath)) {
                paraformerModelPath = paraformerPath;
            }
        }
        
        std::string ctcModelPath;
        if (preferInt8.has_value()) {
            if (preferInt8.value()) {
                if (fileExists(ctcPathInt8)) {
                    ctcModelPath = ctcPathInt8;
                } else if (fileExists(ctcPath)) {
                    ctcModelPath = ctcPath;
                }
            } else {
                if (fileExists(ctcPath)) {
                    ctcModelPath = ctcPath;
                } else if (fileExists(ctcPathInt8)) {
                    ctcModelPath = ctcPathInt8;
                }
            }
        } else {
            if (fileExists(ctcPathInt8)) {
                ctcModelPath = ctcPathInt8;
            } else if (fileExists(ctcPath)) {
                ctcModelPath = ctcPath;
            }
        }
        
        bool hasTransducer = fileExists(encoderPath) && 
                             fileExists(decoderPath) && 
                             fileExists(joinerPath);
        
        bool hasWhisperEncoder = fileExists(encoderPath) || fileExists(encoderPathInt8);
        bool hasWhisperDecoder = fileExists(decoderPath) || fileExists(decoderPathInt8);
        bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && !fileExists(joinerPath);
        
        bool hasFunAsrEncoderAdaptor = fileExists(funasrEncoderAdaptor) || fileExists(funasrEncoderAdaptorInt8);
        bool hasFunAsrLLM = fileExists(funasrLLM) || fileExists(funasrLLMInt8);
        bool hasFunAsrEmbedding = fileExists(funasrEmbedding) || fileExists(funasrEmbeddingInt8);
        bool hasFunAsrTokenizer = !funasrTokenizer.empty() && fileExists(funasrTokenizer + "/vocab.json");
        bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;
        
        bool isLikelyNemoCtc = modelDir.find("nemo") != std::string::npos ||
                                modelDir.find("parakeet") != std::string::npos;
        bool isLikelyWenetCtc = modelDir.find("wenet") != std::string::npos;
        bool isLikelySenseVoice = modelDir.find("sense") != std::string::npos ||
                                  modelDir.find("sensevoice") != std::string::npos;
        bool isLikelyFunAsrNano = modelDir.find("funasr") != std::string::npos ||
                                  modelDir.find("funasr-nano") != std::string::npos;
        bool isLikelyWhisper = modelDir.find("whisper") != std::string::npos;
        
        bool modelConfigured = false;
        
        // Use explicit model type if provided
        if (modelType.has_value()) {
            std::string type = modelType.value();
            if (type == "transducer" && hasTransducer) {
                LOGI("Using explicit Transducer model type");
                config.model_config.transducer.encoder = encoderPath;
                config.model_config.transducer.decoder = decoderPath;
                config.model_config.transducer.joiner = joinerPath;
                modelConfigured = true;
            } else if (type == "paraformer" && !paraformerModelPath.empty()) {
                LOGI("Using explicit Paraformer model type: %s", paraformerModelPath.c_str());
                config.model_config.paraformer.model = paraformerModelPath;
                modelConfigured = true;
            } else if (type == "nemo_ctc" && !ctcModelPath.empty()) {
                LOGI("Using explicit NeMo CTC model type: %s", ctcModelPath.c_str());
                config.model_config.nemo_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (type == "wenet_ctc" && !ctcModelPath.empty()) {
                LOGI("Using explicit WeNet CTC model type: %s", ctcModelPath.c_str());
                config.model_config.wenet_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (type == "sense_voice" && !ctcModelPath.empty()) {
                LOGI("Using explicit SenseVoice model type: %s", ctcModelPath.c_str());
                config.model_config.sense_voice.model = ctcModelPath;
                config.model_config.sense_voice.language = "auto";
                config.model_config.sense_voice.use_itn = false;
                modelConfigured = true;
            } else if (type == "funasr_nano" && hasFunAsrNano) {
                LOGI("Using explicit FunASR Nano model type");
                config.model_config.funasr_nano.encoder_adaptor = fileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
                config.model_config.funasr_nano.llm = fileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
                config.model_config.funasr_nano.embedding = fileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
                config.model_config.funasr_nano.tokenizer = funasrTokenizer;
                tokensRequired = false;
                modelConfigured = true;
            } else if (type == "whisper" && hasWhisper) {
                LOGI("Using explicit Whisper model type");
                config.model_config.whisper.encoder = fileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
                config.model_config.whisper.decoder = fileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
                config.model_config.whisper.language = "en";
                config.model_config.whisper.task = "transcribe";
                tokensRequired = true;
                if (fileExists(tokensPath)) {
                    config.model_config.tokens = tokensPath;
                    LOGI("Using tokens file for Whisper: %s", tokensPath.c_str());
                } else {
                    LOGE("Tokens file not found for Whisper model: %s", tokensPath.c_str());
                    return result;
                }
                modelConfigured = true;
            } else {
                LOGE("Explicit model type '%s' specified but required files not found", type.c_str());
                return result;
            }
        }
        
        // Auto-detect if no explicit type
        if (!modelConfigured) {
            if (hasTransducer) {
                LOGI("Auto-detected Transducer model");
                config.model_config.transducer.encoder = encoderPath;
                config.model_config.transducer.decoder = decoderPath;
                config.model_config.transducer.joiner = joinerPath;
                modelConfigured = true;
            } else if (hasFunAsrNano && isLikelyFunAsrNano) {
                LOGI("Auto-detected FunASR Nano model");
                config.model_config.funasr_nano.encoder_adaptor = fileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
                config.model_config.funasr_nano.llm = fileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
                config.model_config.funasr_nano.embedding = fileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
                config.model_config.funasr_nano.tokenizer = funasrTokenizer;
                tokensRequired = false;
                modelConfigured = true;
            } else if (hasWhisper && isLikelyWhisper) {
                LOGI("Auto-detected Whisper model");
                config.model_config.whisper.encoder = fileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
                config.model_config.whisper.decoder = fileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
                config.model_config.whisper.language = "en";
                config.model_config.whisper.task = "transcribe";
                tokensRequired = true;
                if (fileExists(tokensPath)) {
                    config.model_config.tokens = tokensPath;
                    LOGI("Using tokens file for Whisper: %s", tokensPath.c_str());
                } else {
                    LOGE("Tokens file not found for Whisper model: %s", tokensPath.c_str());
                    return result;
                }
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelySenseVoice) {
                LOGI("Auto-detected SenseVoice model: %s", ctcModelPath.c_str());
                config.model_config.sense_voice.model = ctcModelPath;
                config.model_config.sense_voice.language = "auto";
                config.model_config.sense_voice.use_itn = false;
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelyWenetCtc) {
                LOGI("Auto-detected WeNet CTC model: %s", ctcModelPath.c_str());
                config.model_config.wenet_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelyNemoCtc) {
                LOGI("Auto-detected NeMo CTC model: %s", ctcModelPath.c_str());
                config.model_config.nemo_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (!paraformerModelPath.empty()) {
                LOGI("Auto-detected Paraformer model: %s", paraformerModelPath.c_str());
                config.model_config.paraformer.model = paraformerModelPath;
                modelConfigured = true;
            } else if (!ctcModelPath.empty()) {
                // Fallback: try as CTC model
                LOGI("Auto-detected CTC model (fallback): %s", ctcModelPath.c_str());
                config.model_config.nemo_ctc.model = ctcModelPath;
                modelConfigured = true;
            }
        }
        
        if (tokensRequired) {
            if (!fileExists(tokensPath)) {
                LOGE("Tokens file not found: %s", tokensPath.c_str());
                return result;
            }
            config.model_config.tokens = tokensPath;
            LOGI("Using tokens file: %s", tokensPath.c_str());
        } else if (modelConfigured && fileExists(tokensPath)) {
            config.model_config.tokens = tokensPath;
            LOGI("Using tokens file (optional): %s", tokensPath.c_str());
        }
        
        if (!modelConfigured) {
            LOGE("No valid model files found in directory: %s", modelDir.c_str());
            return result;
        }

        // Set remaining config
        config.decoding_method = "greedy_search";
        config.model_config.num_threads = 4;
        config.model_config.provider = "cpu";
        config.model_config.debug = false;

        // Create the recognizer using C++ API
        try {
            auto recognizer = sherpa_onnx::cxx::OfflineRecognizer::Create(config);
            if (recognizer.Get() == nullptr) {
                LOGE("Failed to create OfflineRecognizer: Create returned invalid object (nullptr)");
                return result;
            }
            pImpl->recognizer = std::move(recognizer);
            LOGI("OfflineRecognizer created successfully using C++ API");
        } catch (const std::exception& e) {
            LOGE("Failed to create OfflineRecognizer: %s", e.what());
            return result;
        }
        
        pImpl->modelDir = modelDir;
        pImpl->initialized = true;
        // Collect detected models with type and path
        std::vector<DetectedModel> detectedModelsList;
        if (hasTransducer) detectedModelsList.push_back({"transducer", modelDir});
        if (!paraformerModelPath.empty()) detectedModelsList.push_back({"paraformer", modelDir});
        if (!ctcModelPath.empty()) {
            if (isLikelySenseVoice) {
                detectedModelsList.push_back({"sense_voice", modelDir});
            } else if (isLikelyWenetCtc) {
                detectedModelsList.push_back({"wenet_ctc", modelDir});
            } else if (isLikelyNemoCtc) {
                detectedModelsList.push_back({"nemo_ctc", modelDir});
            } else {
                detectedModelsList.push_back({"nemo_ctc", modelDir}); // Default CTC type
            }
        }
        if (hasWhisper) detectedModelsList.push_back({"whisper", modelDir});
        if (hasFunAsrNano) detectedModelsList.push_back({"funasr_nano", modelDir});
        
        result.success = true;
        result.detectedModels = detectedModelsList;
        return result;
        
    } catch (const std::exception& e) {
        LOGE("Exception during initialization: %s", e.what());
        return result;
    } catch (...) {
        LOGE("Unknown exception during initialization");
        return result;
    }
}

std::string SttWrapper::transcribeFile(const std::string& filePath) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value()) {
        LOGE("Not initialized. Call initialize() first.");
        return "";
    }

    try {
        if (!fs::exists(filePath)) {
            LOGE("Audio file does not exist: %s", filePath.c_str());
            return "";
        }

        // Read the wave file using C++ API
        sherpa_onnx::cxx::Wave wave = sherpa_onnx::cxx::ReadWave(filePath);
        
        if (wave.samples.empty()) {
            LOGE("Failed to read wave file or file is empty: %s", filePath.c_str());
            return "";
        }

        // Create a stream
        auto stream = pImpl->recognizer.value().CreateStream();
        
        // Feed audio data to the stream (all samples at once for offline recognition)
        stream.AcceptWaveform(wave.sample_rate, wave.samples.data(), wave.samples.size());
        
        // Decode the stream
        pImpl->recognizer.value().Decode(&stream);
        
        // Get result
        auto result = pImpl->recognizer.value().GetResult(&stream);
        
        return result.text;
    } catch (const std::exception& e) {
        LOGE("Exception during transcription: %s", e.what());
        return "";
    } catch (...) {
        LOGE("Unknown exception during transcription");
        return "";
    }
}

bool SttWrapper::isInitialized() const {
    return pImpl->initialized;
}

void SttWrapper::release() {
    if (pImpl->initialized) {
        // OfflineRecognizer uses RAII - destruction happens automatically when optional is reset
        pImpl->recognizer.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
        LOGI("Resources released");
    }
}

// ==================== TtsWrapper Implementation ====================

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
        // Helper functions for file checking
        auto fileExists = [](const std::string& path) -> bool {
            return fs::exists(path);
        };

        auto isDirectory = [](const std::string& path) -> bool {
            return fs::is_directory(path);
        };

        // Check if model directory exists
        if (!fileExists(modelDir) || !isDirectory(modelDir)) {
            LOGE("TTS: Model directory does not exist: %s", modelDir.c_str());
            return result;
        }

        // Build file paths
        std::string modelOnnx = modelDir + "/model.onnx";
        std::string modelFp16 = modelDir + "/model.fp16.onnx";
        std::string modelInt8 = modelDir + "/model.int8.onnx";
        std::string tokensFile = modelDir + "/tokens.txt";
        std::string lexiconFile = modelDir + "/lexicon.txt";
        std::string dataDirPath = modelDir + "/espeak-ng-data";
        std::string voicesFile = modelDir + "/voices.bin";
        std::string acousticModel = modelDir + "/acoustic_model.onnx";
        std::string vocoder = modelDir + "/vocoder.onnx";
        std::string encoder = modelDir + "/encoder.onnx";
        std::string decoder = modelDir + "/decoder.onnx";

        // Setup TTS configuration
        sherpa_onnx::cxx::OfflineTtsConfig config;
        config.model.num_threads = numThreads;
        config.model.debug = debug;

        // Collect detected models for return value


        std::vector<DetectedModel> detectedModelsList;


        


        // Detect all possible TTS model types based on file structure


        bool hasVits = fileExists(modelOnnx) || fileExists(modelFp16) || fileExists(modelInt8);


        bool hasMatcha = fileExists(acousticModel) && fileExists(vocoder);


        bool hasVoicesFile = fileExists(voicesFile);


        bool hasZipvoice = fileExists(encoder) && fileExists(decoder) && fileExists(vocoder);


        


        // Add detected model types to list


        if (hasMatcha) {


            detectedModelsList.push_back({"matcha", modelDir});


        }


        if (hasZipvoice && !hasMatcha) {  // Zipvoice has encoder+decoder+vocoder, Matcha only acoustic+vocoder


            detectedModelsList.push_back({"zipvoice", modelDir});


        }


        if (hasVoicesFile) {


            // Both kokoro and kitten use voices.bin - add both as possibilities


            detectedModelsList.push_back({"kokoro", modelDir});


            detectedModelsList.push_back({"kitten", modelDir});


        }


        if (hasVits && !hasMatcha && !hasZipvoice && !hasVoicesFile) {


            // Only add VITS if no other specific model type detected


            detectedModelsList.push_back({"vits", modelDir});


        } else if (hasVits && (hasVoicesFile || hasMatcha || hasZipvoice)) {


            // If VITS files exist alongside other model types, still add VITS as option


            detectedModelsList.push_back({"vits", modelDir});


        }


        


        // Detect model type or use explicit type
        std::string detectedType = modelType;
        
        if (modelType == "auto") {
            LOGI("TTS: Auto-detecting model type...");
            
            // Matcha: acoustic_model + vocoder
            if (fileExists(acousticModel) && fileExists(vocoder)) {
                detectedType = "matcha";
                LOGI("TTS: Detected Matcha model");
            }
            // Kokoro/Kitten: voices.bin present
            else if (fileExists(voicesFile)) {
                detectedType = "kokoro";
                LOGI("TTS: Detected Kokoro/Kitten model (voices.bin present)");
            }
            // Zipvoice: encoder + decoder + vocoder
            else if (fileExists(encoder) && fileExists(decoder) && fileExists(vocoder)) {
                detectedType = "zipvoice";
                LOGI("TTS: Detected Zipvoice model");
            }
            // VITS: model.onnx (most common)
            else if (fileExists(modelOnnx) || fileExists(modelFp16) || fileExists(modelInt8)) {
                detectedType = "vits";
                LOGI("TTS: Detected VITS model");
            }
            else {
                LOGE("TTS: Cannot auto-detect model type. No recognizable files found.");
                return result;
            }
        }

        // Configure based on model type
        if (detectedType == "vits") {
            // VITS model configuration
            if (fileExists(modelInt8)) {
                config.model.vits.model = modelInt8;
                LOGI("TTS: Using quantized VITS model: %s", modelInt8.c_str());
            } else if (fileExists(modelFp16)) {
                config.model.vits.model = modelFp16;
                LOGI("TTS: Using fp16 VITS model: %s", modelFp16.c_str());
            } else if (fileExists(modelOnnx)) {
                config.model.vits.model = modelOnnx;
                LOGI("TTS: Using VITS model: %s", modelOnnx.c_str());
            } else {
                LOGE("TTS: VITS model.onnx not found");
                return result;
            }

            if (fileExists(tokensFile)) {
                config.model.vits.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found");
                return result;
            }

            if (fileExists(lexiconFile)) {
                config.model.vits.lexicon = lexiconFile;
                LOGI("TTS: Using lexicon: %s", lexiconFile.c_str());
            }

            if (fileExists(dataDirPath) && isDirectory(dataDirPath)) {
                config.model.vits.data_dir = dataDirPath;
                LOGI("TTS: Using espeak-ng data dir: %s", dataDirPath.c_str());
            }
        }
        else if (detectedType == "matcha") {
            // Matcha model configuration
            config.model.matcha.acoustic_model = acousticModel;
            config.model.matcha.vocoder = vocoder;

            if (fileExists(tokensFile)) {
                config.model.matcha.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Matcha model");
                return result;
            }

            if (fileExists(lexiconFile)) {
                config.model.matcha.lexicon = lexiconFile;
            }

            if (fileExists(dataDirPath) && isDirectory(dataDirPath)) {
                config.model.matcha.data_dir = dataDirPath;
            }

            LOGI("TTS: Configured Matcha model");
        }
        else if (detectedType == "kokoro") {
            // Kokoro model configuration
            if (fileExists(modelOnnx)) {
                config.model.kokoro.model = modelOnnx;
            } else {
                LOGE("TTS: Kokoro model.onnx not found");
                return result;
            }

            if (fileExists(voicesFile)) {
                config.model.kokoro.voices = voicesFile;
            } else {
                LOGE("TTS: Kokoro voices.bin not found");
                return result;
            }

            if (fileExists(tokensFile)) {
                config.model.kokoro.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Kokoro model");
                return result;
            }

            if (fileExists(dataDirPath) && isDirectory(dataDirPath)) {
                config.model.kokoro.data_dir = dataDirPath;
            }

            if (fileExists(lexiconFile)) {
                config.model.kokoro.lexicon = lexiconFile;
            }

            LOGI("TTS: Configured Kokoro model");
        }
        else if (detectedType == "kitten") {
            // KittenTTS model configuration
            if (fileExists(modelFp16)) {
                config.model.kitten.model = modelFp16;
                LOGI("TTS: Using fp16 Kitten model");
            } else if (fileExists(modelOnnx)) {
                config.model.kitten.model = modelOnnx;
            } else {
                LOGE("TTS: Kitten model.onnx not found");
                return result;
            }

            if (fileExists(voicesFile)) {
                config.model.kitten.voices = voicesFile;
            } else {
                LOGE("TTS: Kitten voices.bin not found");
                return result;
            }

            if (fileExists(tokensFile)) {
                config.model.kitten.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Kitten model");
                return result;
            }

            if (fileExists(dataDirPath) && isDirectory(dataDirPath)) {
                config.model.kitten.data_dir = dataDirPath;
            }

            LOGI("TTS: Configured Kitten model");
        }
        else if (detectedType == "zipvoice") {
            // Zipvoice model configuration
            config.model.zipvoice.encoder = encoder;
            config.model.zipvoice.decoder = decoder;
            config.model.zipvoice.vocoder = vocoder;

            if (fileExists(tokensFile)) {
                config.model.zipvoice.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Zipvoice model");
                return result;
            }

            if (fileExists(lexiconFile)) {
                config.model.zipvoice.lexicon = lexiconFile;
            }

            if (fileExists(dataDirPath) && isDirectory(dataDirPath)) {
                config.model.zipvoice.data_dir = dataDirPath;
            }

            LOGI("TTS: Configured Zipvoice model");
        }
        else {
            LOGE("TTS: Unknown model type: %s", detectedType.c_str());
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


        result.detectedModels = detectedModelsList;


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

} // namespace sherpaonnx
