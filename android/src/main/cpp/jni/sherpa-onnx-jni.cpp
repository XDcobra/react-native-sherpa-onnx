// Include standard library headers first to avoid conflicts with jni.h
#include <string>
#include <memory>
#include <optional>

// Then include JNI headers
#include <jni.h>
#include <android/log.h>

// Finally include our wrapper
#include "sherpa-onnx-wrapper.h"

#define LOG_TAG "SherpaOnnxJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

using namespace sherpaonnx;

// Global wrapper instance
static std::unique_ptr<SttWrapper> g_stt_wrapper = nullptr;

// Global TTS wrapper instance
static std::unique_ptr<TtsWrapper> g_tts_wrapper = nullptr;

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSttInitialize(
    JNIEnv *env,
    jobject /* this */,
    jstring modelDir,
    jboolean preferInt8,
    jboolean hasPreferInt8,
    jstring modelType) {
    try {
        if (g_stt_wrapper == nullptr) {
            g_stt_wrapper = std::make_unique<SttWrapper>();
        }

        const char *modelDirStr = env->GetStringUTFChars(modelDir, nullptr);
        if (modelDirStr == nullptr) {
            LOGE("Failed to get modelDir string from JNI");
            return JNI_FALSE;
        }

        const char *modelTypeStr = env->GetStringUTFChars(modelType, nullptr);
        if (modelTypeStr == nullptr) {
            LOGE("Failed to get modelType string from JNI");
            env->ReleaseStringUTFChars(modelDir, modelDirStr);
            return JNI_FALSE;
        }

        std::string modelDirPath(modelDirStr);
        std::string modelTypePath(modelTypeStr);
        
        // Convert Java boolean to C++ optional<bool>
        std::optional<bool> preferInt8Opt;
        if (hasPreferInt8 == JNI_TRUE) {
            preferInt8Opt = (preferInt8 == JNI_TRUE);
        }
        
        // Convert model type string to optional
        std::optional<std::string> modelTypeOpt;
        if (modelTypePath != "auto" && !modelTypePath.empty()) {
            modelTypeOpt = modelTypePath;
        }
        
        bool result = g_stt_wrapper->initialize(modelDirPath, preferInt8Opt, modelTypeOpt);
        env->ReleaseStringUTFChars(modelDir, modelDirStr);
        env->ReleaseStringUTFChars(modelType, modelTypeStr);

        if (!result) {
            LOGE("Native initialization failed for: %s", modelDirPath.c_str());
        }
        return result ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("Exception in nativeInitialize: %s", e.what());
        return JNI_FALSE;
    } catch (...) {
        LOGE("Unknown exception in nativeInitialize");
        return JNI_FALSE;
    }
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSttTranscribe(
    JNIEnv *env,
    jobject /* this */,
    jstring filePath) {
    try {
        if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
            LOGE("Not initialized. Call initialize() first.");
            return env->NewStringUTF("");
        }

        const char *filePathStr = env->GetStringUTFChars(filePath, nullptr);
        if (filePathStr == nullptr) {
            LOGE("Failed to get filePath string");
            return env->NewStringUTF("");
        }

        std::string result = g_stt_wrapper->transcribeFile(std::string(filePathStr));
        env->ReleaseStringUTFChars(filePath, filePathStr);

        return env->NewStringUTF(result.c_str());
    } catch (const std::exception &e) {
        LOGE("Exception in nativeTranscribeFile: %s", e.what());
        return env->NewStringUTF("");
    }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSttRelease(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_stt_wrapper != nullptr) {
            g_stt_wrapper->release();
        }
    } catch (const std::exception &e) {
        LOGE("Exception in nativeRelease: %s", e.what());
    }
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTestSherpaInit(
    JNIEnv *env,
    jobject /* this */) {
    return env->NewStringUTF("Sherpa ONNX loaded!");
}

// ==================== TTS JNI Methods ====================

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsInitialize(
    JNIEnv *env,
    jobject /* this */,
    jstring modelDir,
    jstring modelType,
    jint numThreads,
    jboolean debug) {
    try {
        if (g_tts_wrapper == nullptr) {
            g_tts_wrapper = std::make_unique<TtsWrapper>();
        }

        const char *modelDirStr = env->GetStringUTFChars(modelDir, nullptr);
        if (modelDirStr == nullptr) {
            LOGE("TTS JNI: Failed to get modelDir string");
            return JNI_FALSE;
        }

        const char *modelTypeStr = env->GetStringUTFChars(modelType, nullptr);
        if (modelTypeStr == nullptr) {
            LOGE("TTS JNI: Failed to get modelType string");
            env->ReleaseStringUTFChars(modelDir, modelDirStr);
            return JNI_FALSE;
        }

        std::string modelDirPath(modelDirStr);
        std::string modelTypePath(modelTypeStr);
        
        bool result = g_tts_wrapper->initialize(
            modelDirPath,
            modelTypePath,
            static_cast<int32_t>(numThreads),
            debug == JNI_TRUE
        );
        
        env->ReleaseStringUTFChars(modelDir, modelDirStr);
        env->ReleaseStringUTFChars(modelType, modelTypeStr);

        if (!result) {
            LOGE("TTS JNI: Native initialization failed for: %s", modelDirPath.c_str());
        }
        
        return result ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeInitializeTts: %s", e.what());
        return JNI_FALSE;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeInitializeTts");
        return JNI_FALSE;
    }
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGenerate(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jint sid,
    jfloat speed) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initializeTts() first.");
            return nullptr;
        }

        const char *textStr = env->GetStringUTFChars(text, nullptr);
        if (textStr == nullptr) {
            LOGE("TTS JNI: Failed to get text string");
            return nullptr;
        }

        auto result = g_tts_wrapper->generate(
            std::string(textStr),
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
        );
        
        env->ReleaseStringUTFChars(text, textStr);

        if (result.samples.empty() || result.sampleRate == 0) {
            LOGE("TTS JNI: Generation failed or returned empty result");
            return nullptr;
        }

        // Create Java HashMap for result
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        if (hashMapClass == nullptr) {
            LOGE("TTS JNI: Failed to find HashMap class");
            return nullptr;
        }

        jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
        jmethodID hashMapPut = env->GetMethodID(hashMapClass, "put", 
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        
        if (hashMapInit == nullptr || hashMapPut == nullptr) {
            LOGE("TTS JNI: Failed to get HashMap methods");
            return nullptr;
        }

        jobject hashMap = env->NewObject(hashMapClass, hashMapInit);
        if (hashMap == nullptr) {
            LOGE("TTS JNI: Failed to create HashMap");
            return nullptr;
        }

        // Convert samples to Java float array
        jfloatArray samplesArray = env->NewFloatArray(result.samples.size());
        if (samplesArray == nullptr) {
            LOGE("TTS JNI: Failed to create float array");
            return nullptr;
        }
        
        env->SetFloatArrayRegion(samplesArray, 0, result.samples.size(), result.samples.data());

        // Put samples in map
        jstring samplesKey = env->NewStringUTF("samples");
        env->CallObjectMethod(hashMap, hashMapPut, samplesKey, samplesArray);
        env->DeleteLocalRef(samplesKey);
        env->DeleteLocalRef(samplesArray);

        // Put sampleRate in map
        jclass integerClass = env->FindClass("java/lang/Integer");
        jmethodID integerInit = env->GetMethodID(integerClass, "<init>", "(I)V");
        jobject sampleRateObj = env->NewObject(integerClass, integerInit, result.sampleRate);
        
        jstring sampleRateKey = env->NewStringUTF("sampleRate");
        env->CallObjectMethod(hashMap, hashMapPut, sampleRateKey, sampleRateObj);
        env->DeleteLocalRef(sampleRateKey);
        env->DeleteLocalRef(sampleRateObj);

        return hashMap;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeGenerateTts: %s", e.what());
        return nullptr;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeGenerateTts");
        return nullptr;
    }
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGetSampleRate(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initializeTts() first.");
            return 0;
        }
        return g_tts_wrapper->getSampleRate();
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeGetTtsSampleRate: %s", e.what());
        return 0;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeGetTtsSampleRate");
        return 0;
    }
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGetNumSpeakers(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initializeTts() first.");
            return 0;
        }
        return g_tts_wrapper->getNumSpeakers();
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeGetTtsNumSpeakers: %s", e.what());
        return 0;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeGetTtsNumSpeakers");
        return 0;
    }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsRelease(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_tts_wrapper != nullptr) {
            g_tts_wrapper->release();
        }
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeReleaseTts: %s", e.what());
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeReleaseTts");
    }
}

} // extern "C"
