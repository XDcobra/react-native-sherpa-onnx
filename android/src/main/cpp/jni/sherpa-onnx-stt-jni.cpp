// Include standard library headers first to avoid conflicts with jni.h
#include <memory>
#include <optional>
#include <string>

// Then include JNI headers
#include <android/log.h>
#include <jni.h>

// STT wrapper
#include "sherpa-onnx-stt-wrapper.h"

#define LOG_TAG "SherpaOnnxJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

using namespace sherpaonnx;

// Global wrapper instance
static std::unique_ptr<SttWrapper> g_stt_wrapper = nullptr;

extern "C" {

JNIEXPORT jobject JNICALL
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
            return nullptr;
        }

        const char *modelTypeStr = env->GetStringUTFChars(modelType, nullptr);
        if (modelTypeStr == nullptr) {
            LOGE("Failed to get modelType string from JNI");
            env->ReleaseStringUTFChars(modelDir, modelDirStr);
            return nullptr;
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

        SttInitializeResult result = g_stt_wrapper->initialize(modelDirPath, preferInt8Opt, modelTypeOpt);
        env->ReleaseStringUTFChars(modelDir, modelDirStr);
        env->ReleaseStringUTFChars(modelType, modelTypeStr);

        LOGI("STT JNI: Initialization result: success=%d, detected models=%zu", result.success, result.detectedModels.size());
        if (!result.success) {
            LOGE("STT JNI: Native initialization failed for: %s", modelDirPath.c_str());
        } else {
            LOGI("STT JNI: Successfully initialized model at: %s", modelDirPath.c_str());
        }

        // Create HashMap to return
        LOGI("STT JNI: Creating HashMap for result");
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        if (hashMapClass == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to find HashMap class");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            return nullptr;
        }

        jmethodID hashMapConstructor = env->GetMethodID(hashMapClass, "<init>", "()V");
        if (hashMapConstructor == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to get HashMap constructor");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jmethodID putMethod = env->GetMethodID(hashMapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        if (putMethod == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to get HashMap put method");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jobject hashMap = env->NewObject(hashMapClass, hashMapConstructor);
        if (hashMap == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to create HashMap object");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        // Put success boolean
        LOGI("STT JNI: Adding success field to HashMap");
        jclass booleanClass = env->FindClass("java/lang/Boolean");
        if (booleanClass == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to find Boolean class");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jmethodID booleanConstructor = env->GetMethodID(booleanClass, "<init>", "(Z)V");
        if (booleanConstructor == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to get Boolean constructor");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(booleanClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jobject successObj = env->NewObject(booleanClass, booleanConstructor, result.success ? JNI_TRUE : JNI_FALSE);
        jstring successKey = env->NewStringUTF("success");
        env->CallObjectMethod(hashMap, putMethod, successKey, successObj);
        if (env->ExceptionCheck()) {
            LOGE("STT JNI: Exception while putting success field");
            env->ExceptionDescribe();
            env->ExceptionClear();
            env->DeleteLocalRef(successKey);
            env->DeleteLocalRef(successObj);
            env->DeleteLocalRef(booleanClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }
        env->DeleteLocalRef(successKey);
        env->DeleteLocalRef(successObj);
        env->DeleteLocalRef(booleanClass);

        // Put detectedModels array
        LOGI("STT JNI: Adding detectedModels array (%zu models)", result.detectedModels.size());
        jclass arrayListClass = env->FindClass("java/util/ArrayList");
        if (arrayListClass == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to find ArrayList class");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jmethodID arrayListConstructor = env->GetMethodID(arrayListClass, "<init>", "()V");
        if (arrayListConstructor == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to get ArrayList constructor");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(arrayListClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jmethodID addMethod = env->GetMethodID(arrayListClass, "add", "(Ljava/lang/Object;)Z");
        if (addMethod == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to get ArrayList add method");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(arrayListClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        jobject detectedModelsList = env->NewObject(arrayListClass, arrayListConstructor);
        if (detectedModelsList == nullptr || env->ExceptionCheck()) {
            LOGE("STT JNI: Failed to create ArrayList object");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(arrayListClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }

        for (const auto& model : result.detectedModels) {
            // Create HashMap for each model with type and modelDir
            jobject modelMap = env->NewObject(hashMapClass, hashMapConstructor);
            if (modelMap == nullptr || env->ExceptionCheck()) {
                LOGE("STT JNI: Failed to create model HashMap");
                if (env->ExceptionCheck()) {
                    env->ExceptionDescribe();
                    env->ExceptionClear();
                }
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }

            jstring typeKey = env->NewStringUTF("type");
            jstring typeValue = env->NewStringUTF(model.type.c_str());
            env->CallObjectMethod(modelMap, putMethod, typeKey, typeValue);
            env->DeleteLocalRef(typeKey);
            env->DeleteLocalRef(typeValue);

            jstring dirKey = env->NewStringUTF("modelDir");
            jstring dirValue = env->NewStringUTF(model.modelDir.c_str());
            env->CallObjectMethod(modelMap, putMethod, dirKey, dirValue);
            env->DeleteLocalRef(dirKey);
            env->DeleteLocalRef(dirValue);

            env->CallBooleanMethod(detectedModelsList, addMethod, modelMap);
            env->DeleteLocalRef(modelMap);
        }

        jstring detectedModelsKey = env->NewStringUTF("detectedModels");
        env->CallObjectMethod(hashMap, putMethod, detectedModelsKey, detectedModelsList);
        if (env->ExceptionCheck()) {
            LOGE("STT JNI: Exception while putting detectedModels field");
            env->ExceptionDescribe();
            env->ExceptionClear();
            env->DeleteLocalRef(detectedModelsKey);
            env->DeleteLocalRef(detectedModelsList);
            env->DeleteLocalRef(arrayListClass);
            env->DeleteLocalRef(hashMap);
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }
        env->DeleteLocalRef(detectedModelsKey);
        env->DeleteLocalRef(detectedModelsList);
        env->DeleteLocalRef(arrayListClass);
        env->DeleteLocalRef(hashMapClass);

        LOGI("STT JNI: Successfully created result HashMap, returning to Java");
        return hashMap;
    } catch (const std::exception &e) {
        LOGE("Exception in nativeInitialize: %s", e.what());
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
        }
        return nullptr;
    } catch (...) {
        LOGE("Unknown exception in nativeInitialize");
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
        }
        return nullptr;
    }
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSttTranscribe(
    JNIEnv *env,
    jobject /* this */,
    jstring filePath) {
    try {
        if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
            LOGE("STT JNI: Not initialized. Call initialize() first.");
            return env->NewStringUTF("");
        }

        const char *filePathStr = env->GetStringUTFChars(filePath, nullptr);
        if (filePathStr == nullptr) {
            LOGE("STT JNI: Failed to get filePath string");
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
            g_stt_wrapper.reset();
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
