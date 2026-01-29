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
            if (env->ExceptionCheck()) {
                LOGE("STT JNI: Exception while adding 'type' field");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(typeKey);
                env->DeleteLocalRef(typeValue);
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(typeKey);
            env->DeleteLocalRef(typeValue);
            
            jstring modelDirKey = env->NewStringUTF("modelDir");
            jstring modelDirValue = env->NewStringUTF(model.modelDir.c_str());
            env->CallObjectMethod(modelMap, putMethod, modelDirKey, modelDirValue);
            if (env->ExceptionCheck()) {
                LOGE("STT JNI: Exception while adding 'modelDir' field");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(modelDirKey);
                env->DeleteLocalRef(modelDirValue);
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(modelDirKey);
            env->DeleteLocalRef(modelDirValue);
            
            env->CallBooleanMethod(detectedModelsList, addMethod, modelMap);
            if (env->ExceptionCheck()) {
                LOGE("STT JNI: Exception while adding model to ArrayList");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(modelMap);
        }
        jstring detectedModelsKey = env->NewStringUTF("detectedModels");
        env->CallObjectMethod(hashMap, putMethod, detectedModelsKey, detectedModelsList);
        if (env->ExceptionCheck()) {
            LOGE("STT JNI: Exception while putting detectedModels array");
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

JNIEXPORT jobject JNICALL
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
            return nullptr;
        }

        const char *modelTypeStr = env->GetStringUTFChars(modelType, nullptr);
        if (modelTypeStr == nullptr) {
            LOGE("TTS JNI: Failed to get modelType string");
            env->ReleaseStringUTFChars(modelDir, modelDirStr);
            return nullptr;
        }

        std::string modelDirPath(modelDirStr);
        std::string modelTypePath(modelTypeStr);
        
        TtsInitializeResult result = g_tts_wrapper->initialize(
            modelDirPath,
            modelTypePath,
            static_cast<int32_t>(numThreads),
            debug == JNI_TRUE
        );
        
        env->ReleaseStringUTFChars(modelDir, modelDirStr);
        env->ReleaseStringUTFChars(modelType, modelTypeStr);

        LOGI("TTS JNI: Initialization result: success=%d, detected models=%zu", result.success, result.detectedModels.size());
        if (!result.success) {
            LOGE("TTS JNI: Native initialization failed for: %s", modelDirPath.c_str());
        } else {
            LOGI("TTS JNI: Successfully initialized model at: %s", modelDirPath.c_str());
        }
        
        // Create HashMap to return (same structure as STT)
        LOGI("TTS JNI: Creating HashMap for result");
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        if (hashMapClass == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to find HashMap class");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            return nullptr;
        }
        
        jmethodID hashMapConstructor = env->GetMethodID(hashMapClass, "<init>", "()V");
        if (hashMapConstructor == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to get HashMap constructor");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }
        
        jmethodID putMethod = env->GetMethodID(hashMapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        if (putMethod == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to get HashMap put method");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }
        
        jobject hashMap = env->NewObject(hashMapClass, hashMapConstructor);
        if (hashMap == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to create HashMap object");
            if (env->ExceptionCheck()) {
                env->ExceptionDescribe();
                env->ExceptionClear();
            }
            env->DeleteLocalRef(hashMapClass);
            return nullptr;
        }
        
        // Put success boolean
        LOGI("TTS JNI: Adding success field to HashMap");
        jclass booleanClass = env->FindClass("java/lang/Boolean");
        if (booleanClass == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to find Boolean class");
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
            LOGE("TTS JNI: Failed to get Boolean constructor");
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
            LOGE("TTS JNI: Exception while putting success field");
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
        LOGI("TTS JNI: Adding detectedModels array (%zu models)", result.detectedModels.size());
        jclass arrayListClass = env->FindClass("java/util/ArrayList");
        if (arrayListClass == nullptr || env->ExceptionCheck()) {
            LOGE("TTS JNI: Failed to find ArrayList class");
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
            LOGE("TTS JNI: Failed to get ArrayList constructor");
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
            LOGE("TTS JNI: Failed to get ArrayList add method");
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
            LOGE("TTS JNI: Failed to create ArrayList object");
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
            // Create HashMap for each detected model
            jobject modelMap = env->NewObject(hashMapClass, hashMapConstructor);
            if (modelMap == nullptr || env->ExceptionCheck()) {
                LOGE("TTS JNI: Failed to create model HashMap");
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
            if (env->ExceptionCheck()) {
                LOGE("TTS JNI: Exception while adding 'type' field");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(typeKey);
                env->DeleteLocalRef(typeValue);
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(typeKey);
            env->DeleteLocalRef(typeValue);
            
            jstring modelDirKey = env->NewStringUTF("modelDir");
            jstring modelDirValue = env->NewStringUTF(model.modelDir.c_str());
            env->CallObjectMethod(modelMap, putMethod, modelDirKey, modelDirValue);
            if (env->ExceptionCheck()) {
                LOGE("TTS JNI: Exception while adding 'modelDir' field");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(modelDirKey);
                env->DeleteLocalRef(modelDirValue);
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(modelDirKey);
            env->DeleteLocalRef(modelDirValue);
            
            env->CallBooleanMethod(detectedModelsList, addMethod, modelMap);
            if (env->ExceptionCheck()) {
                LOGE("TTS JNI: Exception while adding model to ArrayList");
                env->ExceptionDescribe();
                env->ExceptionClear();
                env->DeleteLocalRef(modelMap);
                env->DeleteLocalRef(detectedModelsList);
                env->DeleteLocalRef(arrayListClass);
                env->DeleteLocalRef(hashMap);
                env->DeleteLocalRef(hashMapClass);
                return nullptr;
            }
            env->DeleteLocalRef(modelMap);
        }
        jstring detectedModelsKey = env->NewStringUTF("detectedModels");
        env->CallObjectMethod(hashMap, putMethod, detectedModelsKey, detectedModelsList);
        if (env->ExceptionCheck()) {
            LOGE("TTS JNI: Exception while putting detectedModels array");
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
        
        LOGI("TTS JNI: Successfully created result HashMap, returning to Java");
        return hashMap;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeInitializeTts: %s", e.what());
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
        }
        return nullptr;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeInitializeTts");
        if (env->ExceptionCheck()) {
            env->ExceptionDescribe();
            env->ExceptionClear();
        }
        return nullptr;
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

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsSaveToWavFile(
    JNIEnv *env,
    jobject /* this */,
    jfloatArray samples,
    jint sampleRate,
    jstring filePath) {
    try {
        if (samples == nullptr || filePath == nullptr) {
            LOGE("TTS JNI: Invalid arguments to nativeTtsSaveToWavFile");
            return JNI_FALSE;
        }

        // Convert jfloatArray to std::vector<float>
        jsize len = env->GetArrayLength(samples);
        std::vector<float> samplesVec(len);
        env->GetFloatArrayRegion(samples, 0, len, samplesVec.data());

        // Convert jstring to std::string
        const char *filePathCStr = env->GetStringUTFChars(filePath, nullptr);
        std::string filePathStr(filePathCStr);
        env->ReleaseStringUTFChars(filePath, filePathCStr);

        // Call the static method
        bool success = sherpaonnx::TtsWrapper::saveToWavFile(
            samplesVec,
            static_cast<int32_t>(sampleRate),
            filePathStr
        );

        return success ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeTtsSaveToWavFile: %s", e.what());
        return JNI_FALSE;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeTtsSaveToWavFile");
        return JNI_FALSE;
    }
}

} // extern "C"
