#include <jni.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <stdexcept>
#include <string>

#include "AudioDecodeSession.h"
#include "AudioVisualization.h"

namespace {

class VisualizationProgressBridge {
 public:
  VisualizationProgressBridge(JNIEnv *env, jobject callback) : env_(env) {
    jclass cls = env->GetObjectClass(callback);
    method_ = env->GetMethodID(
        cls,
        "onVisualizationProgress",
        "(Ljava/lang/String;DJJJJ)V");
    env->DeleteLocalRef(cls);
    if (!method_) {
      throw std::runtime_error(
          "VISUALIZATION_INTERNAL_ERROR: Progress callback missing "
          "onVisualizationProgress(String,double,long,long,long,long)");
    }
    global_ = env->NewGlobalRef(callback);
  }

  ~VisualizationProgressBridge() {
    if (global_ && env_) {
      env_->DeleteGlobalRef(global_);
    }
  }

  VisualizationProgressBridge(const VisualizationProgressBridge &) = delete;
  VisualizationProgressBridge &operator=(const VisualizationProgressBridge &) =
      delete;

  void emitDecode(int64_t framesDecoded, int64_t totalEstimate, int percent) {
    if (!global_ || !method_) {
      return;
    }
    if (percent == lastDecodePercent_) {
      return;
    }
    lastDecodePercent_ = percent;
    const double phasePercent =
        std::max(0.0, std::min(1.0, static_cast<double>(percent) / 100.0));
    jstring phase = env_->NewStringUTF("decode");
    env_->CallVoidMethod(
        global_,
        method_,
        phase,
        static_cast<jdouble>(phasePercent),
        static_cast<jlong>(framesDecoded),
        static_cast<jlong>(totalEstimate),
        static_cast<jlong>(0),
        static_cast<jlong>(0));
    env_->DeleteLocalRef(phase);
    if (env_->ExceptionCheck()) {
      env_->ExceptionClear();
    }
  }

  void emitAnalysis(int64_t stftDone, int64_t stftTotal) {
    if (!global_ || !method_) {
      return;
    }
    const int64_t denom = std::max<int64_t>(1, stftTotal);
    const int percent = static_cast<int>((stftDone * 100) / denom);
    if (percent == lastAnalysisPercent_) {
      return;
    }
    lastAnalysisPercent_ = percent;
    const double phasePercent =
        std::max(0.0, std::min(1.0, static_cast<double>(stftDone) / static_cast<double>(denom)));
    jstring phase = env_->NewStringUTF("analysis");
    env_->CallVoidMethod(
        global_,
        method_,
        phase,
        static_cast<jdouble>(phasePercent),
        static_cast<jlong>(0),
        static_cast<jlong>(0),
        static_cast<jlong>(stftDone),
        static_cast<jlong>(stftTotal));
    env_->DeleteLocalRef(phase);
    if (env_->ExceptionCheck()) {
      env_->ExceptionClear();
    }
  }

 private:
  JNIEnv *env_ = nullptr;
  jobject global_ = nullptr;
  jmethodID method_ = nullptr;
  int lastDecodePercent_ = -1;
  int lastAnalysisPercent_ = -1;
};

std::unique_ptr<VisualizationProgressBridge> makeProgressBridge(
    JNIEnv *env,
    jobject callback) {
  if (!callback) {
    return nullptr;
  }
  return std::make_unique<VisualizationProgressBridge>(env, callback);
}

struct JniVisualizationAccumulator {
  explicit JniVisualizationAccumulator(const sherpa::AudioVisualizationConfig &cfg)
      : accumulator(cfg) {}

  sherpa::AudioVisualizationAccumulator accumulator;
  std::unique_ptr<VisualizationProgressBridge> progress;
};

void attachAnalysisProgress(JniVisualizationAccumulator *handle) {
  if (!handle || !handle->progress) {
    return;
  }
  auto *bridge = handle->progress.get();
  handle->accumulator.setAnalysisProgressCallback(
      [bridge](int64_t stftDone, int64_t stftTotal) {
        bridge->emitAnalysis(stftDone, stftTotal);
      });
}

sherpa::AudioVisualizationAggregateMode toAggregateMode(int aggregateMode) {
  return aggregateMode == 1
      ? sherpa::AudioVisualizationAggregateMode::MEAN
      : sherpa::AudioVisualizationAggregateMode::MAX_HOLD;
}

sherpa::AudioVisualizationConfig makeVisualizationConfig(
    int sampleRate,
    int barCount,
    double minHz,
    double maxHz,
    int fftSize,
    int hopSize,
  int aggregateMode,
  bool includeTimeline,
  int frameCount,
  double frameDurationMs,
  double maxAnalysisDurationMs,
  int levelsMaxStftFrames) {
  sherpa::AudioVisualizationConfig cfg;
  cfg.sampleRate = std::max(1, sampleRate);
  cfg.barCount = barCount;
  cfg.minHz = static_cast<float>(minHz);
  cfg.maxHz = static_cast<float>(maxHz);
  cfg.fftSize = fftSize;
  cfg.hopSize = hopSize;
  cfg.aggregateMode = toAggregateMode(aggregateMode);
  cfg.timeline.enabled =
    includeTimeline || frameCount > 0 || frameDurationMs > 0.0;
  cfg.timeline.frameCount = frameCount;
  cfg.timeline.frameDurationMs = frameDurationMs;
  cfg.timeline.maxAnalysisSamples =
    maxAnalysisDurationMs > 0.0
      ? static_cast<int64_t>(
        (cfg.sampleRate * maxAnalysisDurationMs) / 1000.0)
      : 0;
  cfg.levels.maxStftFrames =
    includeTimeline ? 0 : std::max(0, levelsMaxStftFrames);
  return cfg;
}

jobject profileToHashMap(
    JNIEnv *env,
  sherpa::AudioVisualizationProfile profile) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID hashMapPut = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject map = env->NewObject(hashMapClass, hashMapInit);

  auto putEntry = [&](const char *key, jobject value) {
    jstring jKey = env->NewStringUTF(key);
    jobject prev = env->CallObjectMethod(map, hashMapPut, jKey, value);
    if (prev) {
      env->DeleteLocalRef(prev);
    }
    env->DeleteLocalRef(jKey);
  };

  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID intValueOf = env->GetStaticMethodID(
      intClass,
      "valueOf",
      "(I)Ljava/lang/Integer;");

  jobject sampleRateValue = env->CallStaticObjectMethod(
      intClass,
      intValueOf,
      static_cast<jint>(profile.sampleRate));
  putEntry("sampleRate", sampleRateValue);
  env->DeleteLocalRef(sampleRateValue);

  jobject barCountValue = env->CallStaticObjectMethod(
      intClass,
      intValueOf,
      static_cast<jint>(profile.barCount));
  putEntry("barCount", barCountValue);
  env->DeleteLocalRef(barCountValue);

  jclass longClass = env->FindClass("java/lang/Long");
  jmethodID longValueOf = env->GetStaticMethodID(
      longClass,
      "valueOf",
      "(J)Ljava/lang/Long;");

  jobject durationValue = env->CallStaticObjectMethod(
      longClass,
      longValueOf,
      static_cast<jlong>(profile.durationMs));
  putEntry("durationMs", durationValue);
  env->DeleteLocalRef(durationValue);

  jobject frameCountValue = env->CallStaticObjectMethod(
      intClass,
      intValueOf,
      static_cast<jint>(profile.frameCount));
  putEntry("frameCount", frameCountValue);
  env->DeleteLocalRef(frameCountValue);

  jclass doubleClass = env->FindClass("java/lang/Double");
  jmethodID doubleValueOf = env->GetStaticMethodID(
      doubleClass,
      "valueOf",
      "(D)Ljava/lang/Double;");
  jobject frameDurationValue = env->CallStaticObjectMethod(
      doubleClass,
      doubleValueOf,
      static_cast<jdouble>(profile.frameDurationMs));
  putEntry("frameDurationMs", frameDurationValue);
  env->DeleteLocalRef(frameDurationValue);

  if (profile.frameCount > 0 && !profile.frames.empty()) {
    std::string transferId =
        sherpa::storeVisualizationFramesForTransfer(std::move(profile.frames));
    if (!transferId.empty()) {
      jstring jTransferId = env->NewStringUTF(transferId.c_str());
      putEntry("framesTransferId", jTransferId);
      env->DeleteLocalRef(jTransferId);
    }
  }

  jfloatArray levelsArray = env->NewFloatArray(
      static_cast<jsize>(profile.levels.size()));
  if (levelsArray && !profile.levels.empty()) {
    env->SetFloatArrayRegion(
        levelsArray,
        0,
        static_cast<jsize>(profile.levels.size()),
        profile.levels.data());
  }
  putEntry("levels", levelsArray);
  if (levelsArray) {
    env->DeleteLocalRef(levelsArray);
  }

  env->DeleteLocalRef(intClass);
  env->DeleteLocalRef(longClass);
  env->DeleteLocalRef(doubleClass);
  env->DeleteLocalRef(hashMapClass);

  return map;
}

JniVisualizationAccumulator *fromPtr(jlong ptr) {
  return reinterpret_cast<JniVisualizationAccumulator *>(ptr);
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeCreateVisualizationAccumulator(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jint sampleRate,
    jint barCount,
    jdouble minHz,
    jdouble maxHz,
    jint fftSize,
    jint hopSize,
    jint aggregateMode,
    jboolean includeTimeline,
    jint frameCount,
    jdouble frameDurationMs,
    jdouble maxAnalysisDurationMs,
    jint levelsMaxStftFrames) {
  auto cfg = makeVisualizationConfig(
      static_cast<int>(sampleRate),
      static_cast<int>(barCount),
      static_cast<double>(minHz),
      static_cast<double>(maxHz),
      static_cast<int>(fftSize),
      static_cast<int>(hopSize),
      static_cast<int>(aggregateMode),
      static_cast<bool>(includeTimeline),
      static_cast<int>(frameCount),
      static_cast<double>(frameDurationMs),
      static_cast<double>(maxAnalysisDurationMs),
      static_cast<int>(levelsMaxStftFrames));

  auto *handle = new JniVisualizationAccumulator(cfg);
  return reinterpret_cast<jlong>(handle);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSetVisualizationExpectedTotalSamples(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jlong accumulatorPtr,
    jlong totalSamples) {
  auto *handle = fromPtr(accumulatorPtr);
  if (!handle) {
    return;
  }
  handle->accumulator.setExpectedTotalSamples(static_cast<int64_t>(totalSamples));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeAttachVisualizationProgressCallback(
    JNIEnv *env,
    jclass /* clazz */,
    jlong accumulatorPtr,
    jobject progressCallback) {
  auto *handle = fromPtr(accumulatorPtr);
  if (!handle) {
    return;
  }
  handle->progress = makeProgressBridge(env, progressCallback);
  attachAnalysisProgress(handle);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeFeedVisualizationAccumulator(
    JNIEnv *env,
    jclass /* clazz */,
    jlong accumulatorPtr,
    jfloatArray samples,
    jint sampleCount) {
  auto *handle = fromPtr(accumulatorPtr);
  if (!handle) {
    env->ThrowNew(
        env->FindClass("java/lang/RuntimeException"),
        "VISUALIZATION_INTERNAL_ERROR: Invalid accumulator pointer");
    return;
  }

  if (!samples || sampleCount <= 0) {
    return;
  }

  const jsize arrayLength = env->GetArrayLength(samples);
  const int count = std::min(static_cast<int>(arrayLength), static_cast<int>(sampleCount));
  if (count <= 0) {
    return;
  }

  jboolean isCopy = JNI_FALSE;
  jfloat *values = env->GetFloatArrayElements(samples, &isCopy);
  if (!values) {
    env->ThrowNew(
        env->FindClass("java/lang/RuntimeException"),
        "VISUALIZATION_INTERNAL_ERROR: Failed to access sample array");
    return;
  }

  handle->accumulator.feed(values, count);
  env->ReleaseFloatArrayElements(samples, values, JNI_ABORT);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeIsVisualizationAnalysisCapReached(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jlong accumulatorPtr) {
  auto *handle = fromPtr(accumulatorPtr);
  if (!handle) {
    return JNI_FALSE;
  }
  return handle->accumulator.isAnalysisCapReached() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeFinishVisualizationAccumulator(
    JNIEnv *env,
    jclass /* clazz */,
    jlong accumulatorPtr) {
  auto *handle = fromPtr(accumulatorPtr);
  if (!handle) {
    env->ThrowNew(
        env->FindClass("java/lang/RuntimeException"),
        "VISUALIZATION_INTERNAL_ERROR: Invalid accumulator pointer");
    return nullptr;
  }

  auto profile = handle->accumulator.finish();
  return profileToHashMap(env, profile);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeReleaseVisualizationAccumulator(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jlong accumulatorPtr) {
  auto *handle = fromPtr(accumulatorPtr);
  delete handle;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeComputeVisualizationProfileFromFile(
    JNIEnv *env,
    jclass /* clazz */,
    jstring jPath,
    jint inputFd,
    jint targetSampleRate,
    jboolean forceMono,
    jint chunkSize,
    jboolean allowDemuxerAutoProbe,
    jint barCount,
    jdouble minHz,
    jdouble maxHz,
    jint fftSize,
    jint hopSize,
    jint aggregateMode,
    jboolean includeTimeline,
    jint frameCount,
    jdouble frameDurationMs,
    jdouble maxAnalysisDurationMs,
    jint levelsMaxStftFrames,
    jobject progressCallback) {
  const char *path = nullptr;
  if (jPath) {
    path = env->GetStringUTFChars(jPath, nullptr);
    if (!path) {
      env->ThrowNew(
          env->FindClass("java/lang/RuntimeException"),
          "VISUALIZATION_INTERNAL_ERROR: Failed to access path");
      return nullptr;
    }
  }

  if ((!path || path[0] == '\0') && inputFd < 0) {
    if (path && jPath) {
      env->ReleaseStringUTFChars(jPath, path);
    }
    env->ThrowNew(
        env->FindClass("java/lang/RuntimeException"),
        "VISUALIZATION_INVALID_INPUT: Empty file path and invalid fd");
    return nullptr;
  }

  int64_t probedDurationMs = -1;
  try {
    const auto probeResult =
        sherpa::probeFileDuration(path, static_cast<int>(inputFd));
    probedDurationMs = probeResult.durationMs;
  } catch (...) {
    probedDurationMs = -1;
  }

  sherpa::AudioDecodeConfig decodeConfig;
  decodeConfig.targetSampleRate = static_cast<int>(targetSampleRate);
  decodeConfig.forceMono = static_cast<bool>(forceMono);
  decodeConfig.chunkSize = chunkSize > 0 ? static_cast<int>(chunkSize) : 8192;
  decodeConfig.allowDemuxerAutoProbe = static_cast<bool>(allowDemuxerAutoProbe);

  std::atomic<bool> cancelFlag(false);
  std::unique_ptr<sherpa::AudioVisualizationAccumulator> accumulator;
  int outputSampleRate = targetSampleRate > 0 ? static_cast<int>(targetSampleRate) : 16000;
  auto progressBridge = makeProgressBridge(env, progressCallback);

  auto onStreamInfo = [&](int sourceSampleRate, int /* sourceChannels */) {
    outputSampleRate = targetSampleRate > 0 ? static_cast<int>(targetSampleRate) : sourceSampleRate;
    auto cfg = makeVisualizationConfig(
        outputSampleRate,
        static_cast<int>(barCount),
        static_cast<double>(minHz),
        static_cast<double>(maxHz),
        static_cast<int>(fftSize),
        static_cast<int>(hopSize),
      static_cast<int>(aggregateMode),
      static_cast<bool>(includeTimeline),
      static_cast<int>(frameCount),
      static_cast<double>(frameDurationMs),
      static_cast<double>(maxAnalysisDurationMs),
      static_cast<int>(levelsMaxStftFrames));
    accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
    if (probedDurationMs > 0 && !includeTimeline) {
      const int64_t expectedSamples =
          (probedDurationMs * static_cast<int64_t>(outputSampleRate)) / 1000;
      accumulator->setExpectedTotalSamples(expectedSamples);
    }
    if (progressBridge) {
      auto *bridge = progressBridge.get();
      accumulator->setAnalysisProgressCallback(
          [bridge](int64_t stftDone, int64_t stftTotal) {
            bridge->emitAnalysis(stftDone, stftTotal);
          });
    }
  };

  auto onChunk = [&](const float *samples, int frameCount) {
    if (!accumulator) {
      auto cfg = makeVisualizationConfig(
          outputSampleRate,
          static_cast<int>(barCount),
          static_cast<double>(minHz),
          static_cast<double>(maxHz),
          static_cast<int>(fftSize),
          static_cast<int>(hopSize),
          static_cast<int>(aggregateMode),
          static_cast<bool>(includeTimeline),
          static_cast<int>(frameCount),
          static_cast<double>(frameDurationMs),
          static_cast<double>(maxAnalysisDurationMs),
          static_cast<int>(levelsMaxStftFrames));
      accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
      if (probedDurationMs > 0 && !includeTimeline) {
        const int64_t expectedSamples =
            (probedDurationMs * static_cast<int64_t>(outputSampleRate)) / 1000;
        accumulator->setExpectedTotalSamples(expectedSamples);
      }
      if (progressBridge) {
        auto *bridge = progressBridge.get();
        accumulator->setAnalysisProgressCallback(
            [bridge](int64_t stftDone, int64_t stftTotal) {
              bridge->emitAnalysis(stftDone, stftTotal);
            });
      }
    }
    accumulator->feed(samples, frameCount);
    if (accumulator->isAnalysisCapReached()) {
      cancelFlag.store(true, std::memory_order_relaxed);
    }
  };

  sherpa::DecodeProgressCallback onDecodeProgress = nullptr;
  if (progressBridge) {
    auto *bridge = progressBridge.get();
    onDecodeProgress = [bridge](int64_t framesDecoded, int64_t totalEstimate, int percent) {
      bridge->emitDecode(framesDecoded, totalEstimate, percent);
    };
  }

  try {
    auto decodeResult = sherpa::decodeFile(
        path,
        static_cast<int>(inputFd),
        decodeConfig,
        onChunk,
        onDecodeProgress,
        onStreamInfo,
        cancelFlag);

    if (!accumulator) {
      outputSampleRate =
          targetSampleRate > 0 ? static_cast<int>(targetSampleRate) : decodeResult.sourceSampleRate;
      auto cfg = makeVisualizationConfig(
          outputSampleRate,
          static_cast<int>(barCount),
          static_cast<double>(minHz),
          static_cast<double>(maxHz),
          static_cast<int>(fftSize),
          static_cast<int>(hopSize),
          static_cast<int>(aggregateMode),
          static_cast<bool>(includeTimeline),
          static_cast<int>(frameCount),
          static_cast<double>(frameDurationMs),
          static_cast<double>(maxAnalysisDurationMs),
          static_cast<int>(levelsMaxStftFrames));
      accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
    }

    auto profile = accumulator->finish();

    if (path && jPath) {
      env->ReleaseStringUTFChars(jPath, path);
    }

    return profileToHashMap(env, profile);
  } catch (const std::runtime_error &e) {
    if (path && jPath) {
      env->ReleaseStringUTFChars(jPath, path);
    }
    env->ThrowNew(env->FindClass("java/lang/RuntimeException"), e.what());
    return nullptr;
  } catch (...) {
    if (path && jPath) {
      env->ReleaseStringUTFChars(jPath, path);
    }
    env->ThrowNew(
        env->FindClass("java/lang/RuntimeException"),
        "VISUALIZATION_INTERNAL_ERROR: Unknown error during file visualization");
    return nullptr;
  }
}

}  // extern "C"
