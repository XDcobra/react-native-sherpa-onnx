#include "sherpa-onnx-wrapper.h"
#include <android/log.h>
#include <fstream>
#include <sstream>
#include <optional>
#include <sys/stat.h>
#include <algorithm>
#include <cctype>

// Use filesystem if available (C++17), otherwise fallback
#if __cplusplus >= 201703L && __has_include(<filesystem>)
#include <filesystem>
namespace fs = std::filesystem;
#elif __has_include(<experimental/filesystem>)
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#else
// Fallback: use stat/opendir for older compilers
#include <sys/stat.h>
#include <dirent.h>
#endif

// sherpa-onnx headers - use cxx-api which is compatible with libsherpa-onnx-cxx-api.so
#include "sherpa-onnx/c-api/cxx-api.h"

#define LOG_TAG "SherpaOnnxWrapper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace sherpaonnx {

// PIMPL pattern implementation
class SherpaOnnxWrapper::Impl {
public:
    bool initialized = false;
    std::string modelDir;
    std::optional<sherpa_onnx::cxx::OfflineRecognizer> recognizer;
};

SherpaOnnxWrapper::SherpaOnnxWrapper() : pImpl(std::make_unique<Impl>()) {
    LOGI("SherpaOnnxWrapper created");
}

SherpaOnnxWrapper::~SherpaOnnxWrapper() {
    release();
    LOGI("SherpaOnnxWrapper destroyed");
}

bool SherpaOnnxWrapper::initialize(
    const std::string& modelDir,
    const std::optional<bool>& preferInt8,
    const std::optional<std::string>& modelType
) {
    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("Model directory is empty");
        return false;
    }

    try {
        // Helper function to check if file exists
        auto fileExists = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            return std::filesystem::exists(path);
#elif __has_include(<experimental/filesystem>)
            return std::experimental::filesystem::exists(path);
#else
            struct stat buffer;
            return (stat(path.c_str(), &buffer) == 0);
#endif
        };

        auto isDirectory = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            return std::filesystem::is_directory(path);
#elif __has_include(<experimental/filesystem>)
            return std::experimental::filesystem::is_directory(path);
#else
            struct stat buffer;
            if (stat(path.c_str(), &buffer) != 0) return false;
            return S_ISDIR(buffer.st_mode);
#endif
        };

        // Check if model directory exists
        if (!fileExists(modelDir) || !isDirectory(modelDir)) {
            LOGE("Model directory does not exist or is not a directory: %s", modelDir.c_str());
            return false;
        }

        // Setup configuration
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
        // Looks in main directory and subdirectories with "Qwen3" in name
        auto findFunAsrTokenizer = [&fileExists, &modelDir]() -> std::string {
            // First check if vocab.json exists directly in model directory
            std::string vocabInMain = modelDir + "/vocab.json";
            if (fileExists(vocabInMain)) {
                return modelDir; // Tokenizer files are in main directory
            }
            
            // Search for subdirectories with "Qwen3" in name
            try {
                for (const auto& entry : fs::directory_iterator(modelDir)) {
                    if (entry.is_directory()) {
                        std::string dirName = entry.path().filename().string();
                        // Check if directory name contains "Qwen3" (case-insensitive check)
                        std::string dirNameLower = dirName;
                        std::transform(dirNameLower.begin(), dirNameLower.end(), dirNameLower.begin(), ::tolower);
                        if (dirNameLower.find("qwen3") != std::string::npos) {
                            std::string vocabPath = entry.path().string() + "/vocab.json";
                            if (fileExists(vocabPath)) {
                                return entry.path().string();
                            }
                        }
                    }
                }
            } catch (const std::exception& e) {
                // Error accessing directory - will return empty string
            }
            
            // Fallback: try common name
            std::string commonPath = modelDir + "/Qwen3-0.6B";
            if (fileExists(commonPath + "/vocab.json")) {
                return commonPath;
            }
            
            return ""; // Not found
        };
        
        std::string funasrTokenizer = findFunAsrTokenizer();

        // Tokens file is required for most models, but Whisper doesn't use it
        // We'll check for it conditionally based on model type
        bool tokensRequired = true;

        // Configure based on model type
        // Check for Paraformer model based on preferInt8 preference
        std::string paraformerModelPath;
        if (preferInt8.has_value()) {
            if (preferInt8.value()) {
                // Prefer int8 models
                if (fileExists(paraformerPathInt8)) {
                    paraformerModelPath = paraformerPathInt8;
                } else if (fileExists(paraformerPath)) {
                    paraformerModelPath = paraformerPath;
                }
            } else {
                // Prefer regular models
                if (fileExists(paraformerPath)) {
                    paraformerModelPath = paraformerPath;
                } else if (fileExists(paraformerPathInt8)) {
                    paraformerModelPath = paraformerPathInt8;
                }
            }
        } else {
            // Default: try int8 first, then regular
            if (fileExists(paraformerPathInt8)) {
                paraformerModelPath = paraformerPathInt8;
            } else if (fileExists(paraformerPath)) {
                paraformerModelPath = paraformerPath;
            }
        }
        
        // Check for CTC model (NeMo CTC) - similar structure to Paraformer
        std::string ctcModelPath;
        if (preferInt8.has_value()) {
            if (preferInt8.value()) {
                // Prefer int8 models
                if (fileExists(ctcPathInt8)) {
                    ctcModelPath = ctcPathInt8;
                } else if (fileExists(ctcPath)) {
                    ctcModelPath = ctcPath;
                }
            } else {
                // Prefer regular models
                if (fileExists(ctcPath)) {
                    ctcModelPath = ctcPath;
                } else if (fileExists(ctcPathInt8)) {
                    ctcModelPath = ctcPathInt8;
                }
            }
        } else {
            // Default: try int8 first, then regular
            if (fileExists(ctcPathInt8)) {
                ctcModelPath = ctcPathInt8;
            } else if (fileExists(ctcPath)) {
                ctcModelPath = ctcPath;
            }
        }
        
        // Determine model type: use explicit type if provided, otherwise auto-detect
        bool hasTransducer = fileExists(encoderPath) && 
                             fileExists(decoderPath) && 
                             fileExists(joinerPath);
        
        // Check for Whisper model (encoder + decoder, but no joiner)
        // Whisper can have tokens.txt but it's optional
        bool hasWhisperEncoder = fileExists(encoderPath) || fileExists(encoderPathInt8);
        bool hasWhisperDecoder = fileExists(decoderPath) || fileExists(decoderPathInt8);
        bool hasWhisper = hasWhisperEncoder && hasWhisperDecoder && !fileExists(joinerPath);
        
        // Check for FunASR Nano model (encoder_adaptor, llm, embedding, tokenizer directory)
        // Note: funasrTokenizer is already found by findFunAsrTokenizer() above
        bool hasFunAsrEncoderAdaptor = fileExists(funasrEncoderAdaptor) || fileExists(funasrEncoderAdaptorInt8);
        bool hasFunAsrLLM = fileExists(funasrLLM) || fileExists(funasrLLMInt8);
        bool hasFunAsrEmbedding = fileExists(funasrEmbedding) || fileExists(funasrEmbeddingInt8);
        bool hasFunAsrTokenizer = !funasrTokenizer.empty() && fileExists(funasrTokenizer + "/vocab.json");
        bool hasFunAsrNano = hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding && hasFunAsrTokenizer;
        
        // Check if directory name suggests NeMo CTC model (contains "nemo", "parakeet")
        bool isLikelyNemoCtc = modelDir.find("nemo") != std::string::npos ||
                                modelDir.find("parakeet") != std::string::npos;
        
        // Check if directory name suggests WeNet CTC model (contains "wenet")
        bool isLikelyWenetCtc = modelDir.find("wenet") != std::string::npos;
        
        // Check if directory name suggests SenseVoice model (contains "sense" or "sensevoice")
        bool isLikelySenseVoice = modelDir.find("sense") != std::string::npos ||
                                  modelDir.find("sensevoice") != std::string::npos;
        
        // Check if directory name suggests FunASR Nano model (contains "funasr" or "funasr-nano")
        bool isLikelyFunAsrNano = modelDir.find("funasr") != std::string::npos ||
                                  modelDir.find("funasr-nano") != std::string::npos;
        
        // Check if directory name suggests Whisper model
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
                config.model_config.sense_voice.language = "auto"; // Default to auto language detection
                config.model_config.sense_voice.use_itn = false; // Default to no ITN
                modelConfigured = true;
            } else if (type == "funasr_nano" && hasFunAsrNano) {
                LOGI("Using explicit FunASR Nano model type");
                // FunASR Nano uses encoder_adaptor, llm, embedding, and tokenizer directory
                std::string encoderAdaptorPath = fileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
                std::string llmPath = fileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
                std::string embeddingPath = fileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
                config.model_config.funasr_nano.encoder_adaptor = encoderAdaptorPath;
                config.model_config.funasr_nano.llm = llmPath;
                config.model_config.funasr_nano.embedding = embeddingPath;
                config.model_config.funasr_nano.tokenizer = funasrTokenizer;
                // Use default values for prompts and generation parameters
                tokensRequired = false; // FunASR Nano doesn't use tokens.txt
                modelConfigured = true;
            } else if (type == "whisper" && hasWhisper) {
                LOGI("Using explicit Whisper model type");
                // Whisper uses encoder and decoder, prefer int8 if available
                std::string whisperEncoder = fileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
                std::string whisperDecoder = fileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
                config.model_config.whisper.encoder = whisperEncoder;
                config.model_config.whisper.decoder = whisperDecoder;
                config.model_config.whisper.language = "en"; // Default to English
                config.model_config.whisper.task = "transcribe"; // Default task
                // Whisper requires tokens.txt - set it if it exists
                tokensRequired = true;
                if (fileExists(tokensPath)) {
                    config.model_config.tokens = tokensPath;
                    LOGI("Using tokens file for Whisper: %s", tokensPath.c_str());
                } else {
                    LOGE("Tokens file not found for Whisper model: %s", tokensPath.c_str());
                    return false;
                }
                modelConfigured = true;
            } else {
                LOGE("Explicit model type '%s' specified but required files not found", type.c_str());
                return false;
            }
        }
        
        // Auto-detect if no explicit type or auto was specified
        if (!modelConfigured) {
            if (hasTransducer) {
                // Zipformer/Transducer model (has encoder, decoder, AND joiner)
                LOGI("Auto-detected Transducer model: encoder=%s, decoder=%s, joiner=%s", 
                     encoderPath.c_str(), decoderPath.c_str(), joinerPath.c_str());
                config.model_config.transducer.encoder = encoderPath;
                config.model_config.transducer.decoder = decoderPath;
                config.model_config.transducer.joiner = joinerPath;
                modelConfigured = true;
            } else if (hasFunAsrNano && isLikelyFunAsrNano) {
                // FunASR Nano model (has encoder_adaptor, llm, embedding, and tokenizer)
                std::string encoderAdaptorPath = fileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
                std::string llmPath = fileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
                std::string embeddingPath = fileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
                LOGI("Auto-detected FunASR Nano model: encoder_adaptor=%s, llm=%s, embedding=%s, tokenizer=%s", 
                     encoderAdaptorPath.c_str(), llmPath.c_str(), embeddingPath.c_str(), funasrTokenizer.c_str());
                config.model_config.funasr_nano.encoder_adaptor = encoderAdaptorPath;
                config.model_config.funasr_nano.llm = llmPath;
                config.model_config.funasr_nano.embedding = embeddingPath;
                config.model_config.funasr_nano.tokenizer = funasrTokenizer;
                tokensRequired = false; // FunASR Nano doesn't use tokens.txt
                modelConfigured = true;
            } else if (hasWhisper && isLikelyWhisper) {
                // Whisper model (encoder + decoder, but no joiner, and directory name suggests Whisper)
                std::string whisperEncoder = fileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
                std::string whisperDecoder = fileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
                LOGI("Auto-detected Whisper model: encoder=%s, decoder=%s", 
                     whisperEncoder.c_str(), whisperDecoder.c_str());
                config.model_config.whisper.encoder = whisperEncoder;
                config.model_config.whisper.decoder = whisperDecoder;
                config.model_config.whisper.language = "en"; // Default to English
                config.model_config.whisper.task = "transcribe"; // Default task
                // Whisper requires tokens.txt - set it if it exists
                tokensRequired = true; // Whisper requires tokens.txt
                if (fileExists(tokensPath)) {
                    config.model_config.tokens = tokensPath;
                    LOGI("Using tokens file for Whisper: %s", tokensPath.c_str());
                } else {
                    LOGE("Tokens file not found for Whisper model: %s", tokensPath.c_str());
                    return false;
                }
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelySenseVoice) {
                // SenseVoice model (model.onnx exists and directory name suggests SenseVoice)
                LOGI("Auto-detected SenseVoice model: %s (detected by directory name)", ctcModelPath.c_str());
                config.model_config.sense_voice.model = ctcModelPath;
                config.model_config.sense_voice.language = "auto"; // Default to auto language detection
                config.model_config.sense_voice.use_itn = false; // Default to no ITN
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelyWenetCtc) {
                // WeNet CTC model (model.onnx exists and directory name suggests WeNet)
                LOGI("Auto-detected WeNet CTC model: %s (detected by directory name)", ctcModelPath.c_str());
                config.model_config.wenet_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelyNemoCtc) {
                // NeMo CTC model (model.onnx exists and directory name suggests NeMo CTC)
                LOGI("Auto-detected NeMo CTC model: %s (detected by directory name)", ctcModelPath.c_str());
                config.model_config.nemo_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else if (!paraformerModelPath.empty()) {
                // Paraformer model (has model.onnx, and directory name doesn't suggest CTC)
                LOGI("Auto-detected Paraformer model: %s", paraformerModelPath.c_str());
                config.model_config.paraformer.model = paraformerModelPath;
                modelConfigured = true;
            } else if (!ctcModelPath.empty() && isLikelyWenetCtc) {
                // Fallback: WeNet CTC model (model.onnx exists, directory name suggests WeNet)
                LOGI("Auto-detected WeNet CTC model: %s (fallback detection)", ctcModelPath.c_str());
                config.model_config.wenet_ctc.model = ctcModelPath;
                modelConfigured = true;
            } else {
                // Fallback: Set all found files and let sherpa-onnx detect the model type from metadata
                // This increases the chance of success for unknown model types
                LOGI("No specific model type detected. Setting all found files and letting sherpa-onnx auto-detect from metadata");
                
                bool anyFileSet = false;
                
                // Set transducer files if present
                if (hasTransducer) {
                    config.model_config.transducer.encoder = encoderPath;
                    config.model_config.transducer.decoder = decoderPath;
                    config.model_config.transducer.joiner = joinerPath;
                    anyFileSet = true;
                    LOGI("Set transducer files: encoder=%s, decoder=%s, joiner=%s", 
                         encoderPath.c_str(), decoderPath.c_str(), joinerPath.c_str());
                }
                
                // Set Whisper files if present (encoder + decoder, no joiner)
                if (hasWhisper) {
                    std::string whisperEncoder = fileExists(encoderPathInt8) ? encoderPathInt8 : encoderPath;
                    std::string whisperDecoder = fileExists(decoderPathInt8) ? decoderPathInt8 : decoderPath;
                    config.model_config.whisper.encoder = whisperEncoder;
                    config.model_config.whisper.decoder = whisperDecoder;
                    config.model_config.whisper.language = "en"; // Default
                    config.model_config.whisper.task = "transcribe"; // Default
                    anyFileSet = true;
                    LOGI("Set Whisper files: encoder=%s, decoder=%s", 
                         whisperEncoder.c_str(), whisperDecoder.c_str());
                }
                
                // Set Paraformer model if present
                if (!paraformerModelPath.empty()) {
                    config.model_config.paraformer.model = paraformerModelPath;
                    anyFileSet = true;
                    LOGI("Set Paraformer model: %s", paraformerModelPath.c_str());
                }
                
                // Set FunASR Nano files if present (re-check tokenizer in fallback mode)
                if (hasFunAsrEncoderAdaptor && hasFunAsrLLM && hasFunAsrEmbedding) {
                    // Try to find tokenizer if not already found
                    std::string tokenizerPath = funasrTokenizer;
                    if (tokenizerPath.empty()) {
                        // Re-run tokenizer search in fallback mode
                        std::string vocabInMain = modelDir + "/vocab.json";
                        if (fileExists(vocabInMain)) {
                            tokenizerPath = modelDir;
                        } else {
                            // Search for subdirectories with "Qwen3" in name
                            try {
                                for (const auto& entry : fs::directory_iterator(modelDir)) {
                                    if (entry.is_directory()) {
                                        std::string dirName = entry.path().filename().string();
                                        std::string dirNameLower = dirName;
                                        std::transform(dirNameLower.begin(), dirNameLower.end(), dirNameLower.begin(), ::tolower);
                                        if (dirNameLower.find("qwen3") != std::string::npos) {
                                            std::string vocabPath = entry.path().string() + "/vocab.json";
                                            if (fileExists(vocabPath)) {
                                                tokenizerPath = entry.path().string();
                                                break;
                                            }
                                        }
                                    }
                                }
                            } catch (const std::exception& e) {
                                LOGE("Error searching for FunASR tokenizer in fallback: %s", e.what());
                            }
                        }
                    }
                    
                    if (!tokenizerPath.empty() && fileExists(tokenizerPath + "/vocab.json")) {
                        std::string encoderAdaptorPath = fileExists(funasrEncoderAdaptorInt8) ? funasrEncoderAdaptorInt8 : funasrEncoderAdaptor;
                        std::string llmPath = fileExists(funasrLLMInt8) ? funasrLLMInt8 : funasrLLM;
                        std::string embeddingPath = fileExists(funasrEmbeddingInt8) ? funasrEmbeddingInt8 : funasrEmbedding;
                        config.model_config.funasr_nano.encoder_adaptor = encoderAdaptorPath;
                        config.model_config.funasr_nano.llm = llmPath;
                        config.model_config.funasr_nano.embedding = embeddingPath;
                        config.model_config.funasr_nano.tokenizer = tokenizerPath;
                        anyFileSet = true;
                        LOGI("Set FunASR Nano files (fallback): encoder_adaptor=%s, llm=%s, embedding=%s, tokenizer=%s", 
                             encoderAdaptorPath.c_str(), llmPath.c_str(), embeddingPath.c_str(), tokenizerPath.c_str());
                    }
                }
                
                // Set CTC models if present (try all CTC types)
                if (!ctcModelPath.empty()) {
                    // Set all CTC model types - sherpa-onnx will use the correct one based on metadata
                    config.model_config.nemo_ctc.model = ctcModelPath;
                    config.model_config.wenet_ctc.model = ctcModelPath;
                    // Also set SenseVoice if directory name suggests it
                    if (isLikelySenseVoice) {
                        config.model_config.sense_voice.model = ctcModelPath;
                        config.model_config.sense_voice.language = "auto";
                        config.model_config.sense_voice.use_itn = false;
                        LOGI("Set SenseVoice model: %s", ctcModelPath.c_str());
                    }
                    // Note: We could also set tdnn, zipformer_ctc, telespeech_ctc here
                    // but those are less common, so we'll let sherpa-onnx handle them
                    anyFileSet = true;
                    LOGI("Set CTC model files: %s (will be detected as NeMo CTC, WeNet CTC, SenseVoice, or other CTC type from metadata)", 
                         ctcModelPath.c_str());
                }
                
                if (anyFileSet) {
                    modelConfigured = true;
                    LOGI("Fallback: All found files set. sherpa-onnx will detect model type from metadata.");
                }
            }
        }
        
        // Set tokens if required or if available (for fallback mode)
        if (tokensRequired) {
            if (!fileExists(tokensPath)) {
                LOGE("Tokens file not found: %s", tokensPath.c_str());
                return false;
            }
            config.model_config.tokens = tokensPath;
            LOGI("Using tokens file: %s", tokensPath.c_str());
        } else if (modelConfigured && fileExists(tokensPath)) {
            // In fallback mode, set tokens.txt if available (many models need it)
            config.model_config.tokens = tokensPath;
            LOGI("Using tokens file (fallback mode): %s", tokensPath.c_str());
        }
        
        if (!modelConfigured) {
            LOGE("No valid model files found in directory: %s", modelDir.c_str());
            LOGE("Checked paths:");
            LOGE("  Paraformer (int8): %s (exists: %s)", paraformerPathInt8.c_str(), fileExists(paraformerPathInt8) ? "yes" : "no");
            LOGE("  Paraformer: %s (exists: %s)", paraformerPath.c_str(), fileExists(paraformerPath) ? "yes" : "no");
            LOGE("  CTC (int8): %s (exists: %s)", ctcPathInt8.c_str(), fileExists(ctcPathInt8) ? "yes" : "no");
            LOGE("  CTC: %s (exists: %s)", ctcPath.c_str(), fileExists(ctcPath) ? "yes" : "no");
            LOGE("  Encoder: %s (exists: %s)", encoderPath.c_str(), fileExists(encoderPath) ? "yes" : "no");
            LOGE("  Encoder (int8): %s (exists: %s)", encoderPathInt8.c_str(), fileExists(encoderPathInt8) ? "yes" : "no");
            LOGE("  Decoder: %s (exists: %s)", decoderPath.c_str(), fileExists(decoderPath) ? "yes" : "no");
            LOGE("  Decoder (int8): %s (exists: %s)", decoderPathInt8.c_str(), fileExists(decoderPathInt8) ? "yes" : "no");
            LOGE("  Joiner: %s (exists: %s)", joinerPath.c_str(), fileExists(joinerPath) ? "yes" : "no");
            LOGE("Expected transducer model (encoder.onnx, decoder.onnx, joiner.onnx), whisper model (encoder.onnx, decoder.onnx), paraformer model (model.onnx or model.int8.onnx), NeMo CTC model (model.onnx or model.int8.onnx), WeNet CTC model (model.onnx or model.int8.onnx), SenseVoice model (model.onnx or model.int8.onnx), or FunASR Nano model (encoder_adaptor.onnx, llm.onnx, embedding.onnx, tokenizer directory)");
            return false;
        }

        // Set common configuration
        config.decoding_method = "greedy_search";
        config.model_config.num_threads = 4;
        config.model_config.provider = "cpu";

        // Create recognizer
        // Log configuration details
        bool isWhisperModel = !config.model_config.whisper.encoder.empty() && !config.model_config.whisper.decoder.empty();
        if (isWhisperModel) {
            std::string tokensInfo = config.model_config.tokens.empty() ? "none" : config.model_config.tokens;
            LOGI("Creating OfflineRecognizer with Whisper config: encoder=%s, decoder=%s, language=%s, task=%s, tokens=%s, num_threads=%d, provider=%s", 
                 config.model_config.whisper.encoder.c_str(), 
                 config.model_config.whisper.decoder.c_str(),
                 config.model_config.whisper.language.c_str(),
                 config.model_config.whisper.task.c_str(),
                 tokensInfo.c_str(),
                 config.model_config.num_threads, 
                 config.model_config.provider.c_str());
        } else {
            LOGI("Creating OfflineRecognizer with config: tokens=%s, num_threads=%d, provider=%s", 
                 config.model_config.tokens.c_str(), config.model_config.num_threads, config.model_config.provider.c_str());
        }
        try {
            auto recognizer = sherpa_onnx::cxx::OfflineRecognizer::Create(config);
            // Check if recognizer is valid by checking internal pointer
            if (recognizer.Get() == nullptr) {
                LOGE("Failed to create OfflineRecognizer: Create returned invalid object (nullptr)");
                return false;
            }
            pImpl->recognizer = std::move(recognizer);
            LOGI("OfflineRecognizer created successfully");
        } catch (const std::exception& e) {
            LOGE("Failed to create OfflineRecognizer: %s", e.what());
            return false;
        }

        pImpl->modelDir = modelDir;
        pImpl->initialized = true;
        return true;
    } catch (const std::exception& e) {
        LOGE("Exception during initialization: %s", e.what());
        return false;
    } catch (...) {
        LOGE("Unknown exception during initialization");
        return false;
    }
}

std::string SherpaOnnxWrapper::transcribeFile(const std::string& filePath) {
    if (!pImpl->initialized || !pImpl->recognizer.has_value()) {
        LOGE("Not initialized. Call initialize() first.");
        return "";
    }

    try {
        // Helper function to check if file exists
        auto fileExists = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            return std::filesystem::exists(path);
#elif __has_include(<experimental/filesystem>)
            return std::experimental::filesystem::exists(path);
#else
            struct stat buffer;
            return (stat(path.c_str(), &buffer) == 0);
#endif
        };

        // Check if file exists
        if (!fileExists(filePath)) {
            LOGE("Audio file does not exist: %s", filePath.c_str());
            return "";
        }

        // Read audio file using cxx-api
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

bool SherpaOnnxWrapper::isInitialized() const {
    return pImpl->initialized;
}

void SherpaOnnxWrapper::release() {
    if (pImpl->initialized) {
        // OfflineRecognizer uses RAII - destruction happens automatically when optional is reset
        pImpl->recognizer.reset();
        pImpl->initialized = false;
        pImpl->modelDir.clear();
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

bool TtsWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    int32_t numThreads,
    bool debug
) {
    if (pImpl->initialized) {
        release();
    }

    if (modelDir.empty()) {
        LOGE("TTS: Model directory is empty");
        return false;
    }

    try {
        // Helper functions for file checking
        auto fileExists = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            return std::filesystem::exists(path);
#elif __has_include(<experimental/filesystem>)
            return std::experimental::filesystem::exists(path);
#else
            struct stat buffer;
            return (stat(path.c_str(), &buffer) == 0);
#endif
        };

        auto isDirectory = [](const std::string& path) -> bool {
#if __cplusplus >= 201703L && __has_include(<filesystem>)
            return std::filesystem::is_directory(path);
#elif __has_include(<experimental/filesystem>)
            return std::experimental::filesystem::is_directory(path);
#else
            struct stat buffer;
            if (stat(path.c_str(), &buffer) != 0) return false;
            return S_ISDIR(buffer.st_mode);
#endif
        };

        // Check if model directory exists
        if (!fileExists(modelDir) || !isDirectory(modelDir)) {
            LOGE("TTS: Model directory does not exist: %s", modelDir.c_str());
            return false;
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
                // Both use same structure, differentiate by checking filename patterns if needed
                // For now, default to kokoro
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
                return false;
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
                return false;
            }

            if (fileExists(tokensFile)) {
                config.model.vits.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found");
                return false;
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
                return false;
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
                return false;
            }

            if (fileExists(voicesFile)) {
                config.model.kokoro.voices = voicesFile;
            } else {
                LOGE("TTS: Kokoro voices.bin not found");
                return false;
            }

            if (fileExists(tokensFile)) {
                config.model.kokoro.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Kokoro model");
                return false;
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
                return false;
            }

            if (fileExists(voicesFile)) {
                config.model.kitten.voices = voicesFile;
            } else {
                LOGE("TTS: Kitten voices.bin not found");
                return false;
            }

            if (fileExists(tokensFile)) {
                config.model.kitten.tokens = tokensFile;
            } else {
                LOGE("TTS: tokens.txt not found for Kitten model");
                return false;
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
                return false;
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
            return false;
        }

        // Create TTS instance
        LOGI("TTS: Creating OfflineTts instance...");
        pImpl->tts = sherpa_onnx::cxx::OfflineTts::Create(config);
        
        if (!pImpl->tts.has_value()) {
            LOGE("TTS: Failed to create OfflineTts instance");
            return false;
        }

        pImpl->initialized = true;
        pImpl->modelDir = modelDir;
        
        LOGI("TTS: Initialization successful");
        LOGI("TTS: Sample rate: %d Hz", pImpl->tts.value().SampleRate());
        LOGI("TTS: Number of speakers: %d", pImpl->tts.value().NumSpeakers());

        return true;
    } catch (const std::exception& e) {
        LOGE("TTS: Exception during initialization: %s", e.what());
        return false;
    } catch (...) {
        LOGE("TTS: Unknown exception during initialization");
        return false;
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
