#ifndef SHERPA_ONNX_PUNCT_ENGINE_WRAPPER_H
#define SHERPA_ONNX_PUNCT_ENGINE_WRAPPER_H

#include <cstdint>
#include <memory>
#include <string>

namespace sherpaonnx {

struct PunctuationInitializeResult {
  bool success = false;
  std::string error;
};

struct PunctuationAddResult {
  bool success = false;
  std::string error;
  std::string text;
};

/**
 * Shared offline punctuation (CT-Transformer) via C API.
 * Paths resolved by JS/detect before init.
 */
class OfflinePunctuationWrapper {
 public:
  OfflinePunctuationWrapper();
  ~OfflinePunctuationWrapper();

  OfflinePunctuationWrapper(const OfflinePunctuationWrapper&) = delete;
  OfflinePunctuationWrapper& operator=(const OfflinePunctuationWrapper&) =
      delete;

  PunctuationInitializeResult initialize(const std::string& ctTransformerPath,
                                         int32_t numThreads = 1,
                                         const std::string& provider = "cpu",
                                         bool debug = false);

  PunctuationAddResult addPunctuation(const std::string& text);

  bool isInitialized() const;

  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

/**
 * Shared online punctuation (CNN-BiLSTM + BPE) via C API.
 * Paths resolved by JS/detect before init.
 */
class OnlinePunctuationWrapper {
 public:
  OnlinePunctuationWrapper();
  ~OnlinePunctuationWrapper();

  OnlinePunctuationWrapper(const OnlinePunctuationWrapper&) = delete;
  OnlinePunctuationWrapper& operator=(const OnlinePunctuationWrapper&) = delete;

  PunctuationInitializeResult initialize(const std::string& cnnBilstmPath,
                                         const std::string& bpeVocabPath,
                                         int32_t numThreads = 1,
                                         const std::string& provider = "cpu",
                                         bool debug = false);

  PunctuationAddResult addPunctuation(const std::string& text);

  bool isInitialized() const;

  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif
