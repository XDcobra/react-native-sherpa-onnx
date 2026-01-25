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
static std::unique_ptr<SherpaOnnxWrapper> g_wrapper = nullptr;

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeInitialize(
    JNIEnv *env,
    jobject /* this */,
    jstring modelDir,
    jboolean preferInt8,
    jboolean hasPreferInt8,
    jstring modelType) {
    try {
        if (g_wrapper == nullptr) {
            g_wrapper = std::make_unique<SherpaOnnxWrapper>();
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
        
        bool result = g_wrapper->initialize(modelDirPath, preferInt8Opt, modelTypeOpt);
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
Java_com_sherpaonnx_SherpaOnnxModule_nativeTranscribeFile(
    JNIEnv *env,
    jobject /* this */,
    jstring filePath) {
    try {
        if (g_wrapper == nullptr || !g_wrapper->isInitialized()) {
            LOGE("Not initialized. Call initialize() first.");
            return env->NewStringUTF("");
        }

        const char *filePathStr = env->GetStringUTFChars(filePath, nullptr);
        if (filePathStr == nullptr) {
            LOGE("Failed to get filePath string");
            return env->NewStringUTF("");
        }

        std::string result = g_wrapper->transcribeFile(std::string(filePathStr));
        env->ReleaseStringUTFChars(filePath, filePathStr);

        return env->NewStringUTF(result.c_str());
    } catch (const std::exception &e) {
        LOGE("Exception in nativeTranscribeFile: %s", e.what());
        return env->NewStringUTF("");
    }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeRelease(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_wrapper != nullptr) {
            g_wrapper->release();
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

} // extern "C"
