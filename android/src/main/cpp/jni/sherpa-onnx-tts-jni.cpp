// Include standard library headers first to avoid conflicts with jni.h
#include <atomic>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

// Then include JNI headers
#include <android/log.h>
#include <jni.h>

// TTS wrapper
#include "sherpa-onnx-tts-wrapper.h"

#define LOG_TAG "SherpaOnnxJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

using namespace sherpaonnx;

namespace {
std::vector<std::string> SplitTtsTokens(const std::string &text) {
    std::vector<std::string> tokens;
    std::istringstream iss(text);
    std::string token;
    while (iss >> token) {
        tokens.push_back(token);
    }
    if (tokens.empty() && !text.empty()) {
        tokens.push_back(text);
    }
    return tokens;
}
}

// Global TTS wrapper instance
static std::unique_ptr<TtsWrapper> g_tts_wrapper = nullptr;
static std::atomic<bool> g_tts_stream_cancelled{false};

extern "C" {

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
            LOGE("TTS JNI: Failed to get modelDir string from JNI");
            return nullptr;
        }

        const char *modelTypeStr = env->GetStringUTFChars(modelType, nullptr);
        if (modelTypeStr == nullptr) {
            LOGE("TTS JNI: Failed to get modelType string from JNI");
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
            // Create HashMap for each model with type and modelDir
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
            LOGE("TTS JNI: Exception while putting detectedModels field");
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
            LOGE("TTS JNI: Not initialized. Call initialize() first.");
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
            LOGE("TTS JNI: Generation returned empty result");
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
            LOGE("TTS JNI: Failed to create HashMap object");
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

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGenerateWithTimestamps(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jint sid,
    jfloat speed) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initialize() first.");
            return nullptr;
        }

        const char *textStr = env->GetStringUTFChars(text, nullptr);
        if (textStr == nullptr) {
            LOGE("TTS JNI: Failed to get text string");
            return nullptr;
        }

        std::string textValue(textStr);
        auto result = g_tts_wrapper->generate(
            textValue,
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
        );

        env->ReleaseStringUTFChars(text, textStr);

        if (result.samples.empty() || result.sampleRate == 0) {
            LOGE("TTS JNI: Generation returned empty result");
            return nullptr;
        }

        jclass hashMapClass = env->FindClass("java/util/HashMap");
        if (hashMapClass == nullptr) {
            LOGE("TTS JNI: Failed to find HashMap class");
            return nullptr;
        }

        jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
        jmethodID hashMapPut = env->GetMethodID(
            hashMapClass,
            "put",
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;"
        );
        if (hashMapInit == nullptr || hashMapPut == nullptr) {
            LOGE("TTS JNI: Failed to get HashMap methods");
            return nullptr;
        }

        jobject hashMap = env->NewObject(hashMapClass, hashMapInit);
        if (hashMap == nullptr) {
            LOGE("TTS JNI: Failed to create HashMap object");
            return nullptr;
        }

        jfloatArray samplesArray = env->NewFloatArray(result.samples.size());
        if (samplesArray == nullptr) {
            LOGE("TTS JNI: Failed to create float array");
            return nullptr;
        }
        env->SetFloatArrayRegion(samplesArray, 0, result.samples.size(), result.samples.data());

        jstring samplesKey = env->NewStringUTF("samples");
        env->CallObjectMethod(hashMap, hashMapPut, samplesKey, samplesArray);
        env->DeleteLocalRef(samplesKey);
        env->DeleteLocalRef(samplesArray);

        jclass integerClass = env->FindClass("java/lang/Integer");
        jmethodID integerInit = env->GetMethodID(integerClass, "<init>", "(I)V");
        jobject sampleRateObj = env->NewObject(integerClass, integerInit, result.sampleRate);

        jstring sampleRateKey = env->NewStringUTF("sampleRate");
        env->CallObjectMethod(hashMap, hashMapPut, sampleRateKey, sampleRateObj);
        env->DeleteLocalRef(sampleRateKey);
        env->DeleteLocalRef(sampleRateObj);

        jclass arrayListClass = env->FindClass("java/util/ArrayList");
        jmethodID arrayListInit = env->GetMethodID(arrayListClass, "<init>", "()V");
        jmethodID arrayListAdd = env->GetMethodID(arrayListClass, "add", "(Ljava/lang/Object;)Z");

        jobject subtitlesList = env->NewObject(arrayListClass, arrayListInit);
        auto tokens = SplitTtsTokens(textValue);
        if (!tokens.empty()) {
            const double totalSeconds = static_cast<double>(result.samples.size()) /
                                        static_cast<double>(result.sampleRate);
            const double perToken = totalSeconds / static_cast<double>(tokens.size());

            jclass doubleClass = env->FindClass("java/lang/Double");
            jmethodID doubleInit = env->GetMethodID(doubleClass, "<init>", "(D)V");

            for (size_t i = 0; i < tokens.size(); ++i) {
                double start = perToken * static_cast<double>(i);
                double end = perToken * static_cast<double>(i + 1);

                jobject subtitleMap = env->NewObject(hashMapClass, hashMapInit);
                jstring textKey = env->NewStringUTF("text");
                jstring textValueKey = env->NewStringUTF(tokens[i].c_str());
                env->CallObjectMethod(subtitleMap, hashMapPut, textKey, textValueKey);
                env->DeleteLocalRef(textKey);
                env->DeleteLocalRef(textValueKey);

                jstring startKey = env->NewStringUTF("start");
                jobject startObj = env->NewObject(doubleClass, doubleInit, start);
                env->CallObjectMethod(subtitleMap, hashMapPut, startKey, startObj);
                env->DeleteLocalRef(startKey);
                env->DeleteLocalRef(startObj);

                jstring endKey = env->NewStringUTF("end");
                jobject endObj = env->NewObject(doubleClass, doubleInit, end);
                env->CallObjectMethod(subtitleMap, hashMapPut, endKey, endObj);
                env->DeleteLocalRef(endKey);
                env->DeleteLocalRef(endObj);

                env->CallBooleanMethod(subtitlesList, arrayListAdd, subtitleMap);
                env->DeleteLocalRef(subtitleMap);
            }
        }

        jstring subtitlesKey = env->NewStringUTF("subtitles");
        env->CallObjectMethod(hashMap, hashMapPut, subtitlesKey, subtitlesList);
        env->DeleteLocalRef(subtitlesKey);
        env->DeleteLocalRef(subtitlesList);

        jclass booleanClass = env->FindClass("java/lang/Boolean");
        jmethodID booleanInit = env->GetMethodID(booleanClass, "<init>", "(Z)V");
        jobject estimatedObj = env->NewObject(booleanClass, booleanInit, JNI_TRUE);
        jstring estimatedKey = env->NewStringUTF("estimated");
        env->CallObjectMethod(hashMap, hashMapPut, estimatedKey, estimatedObj);
        env->DeleteLocalRef(estimatedKey);
        env->DeleteLocalRef(estimatedObj);

        return hashMap;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeGenerateTtsWithTimestamps: %s", e.what());
        return nullptr;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeGenerateTtsWithTimestamps");
        return nullptr;
    }
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGenerateStream(
    JNIEnv *env,
    jobject /* this */,
    jstring text,
    jint sid,
    jfloat speed) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initialize() first.");
            return JNI_FALSE;
        }

        const char *textStr = env->GetStringUTFChars(text, nullptr);
        if (textStr == nullptr) {
            LOGE("TTS JNI: Failed to get text string");
            return JNI_FALSE;
        }

        g_tts_stream_cancelled.store(false);

        jclass moduleClass = env->FindClass("com/sherpaonnx/SherpaOnnxModule");
        if (moduleClass == nullptr) {
            LOGE("TTS JNI: Failed to find SherpaOnnxModule class");
            env->ReleaseStringUTFChars(text, textStr);
            return JNI_FALSE;
        }

        jmethodID onChunk = env->GetStaticMethodID(
            moduleClass,
            "onTtsStreamChunk",
            "([FIFZ)V"
        );
        jmethodID onError = env->GetStaticMethodID(
            moduleClass,
            "onTtsStreamError",
            "(Ljava/lang/String;)V"
        );

        if (onChunk == nullptr) {
            LOGE("TTS JNI: Failed to get onTtsStreamChunk method");
            env->ReleaseStringUTFChars(text, textStr);
            env->DeleteLocalRef(moduleClass);
            return JNI_FALSE;
        }

        const int32_t sampleRate = g_tts_wrapper->getSampleRate();
        bool ok = g_tts_wrapper->generateStream(
            std::string(textStr),
            static_cast<int32_t>(sid),
            static_cast<float>(speed),
            [env, moduleClass, onChunk, sampleRate](
                const float *samples,
                int32_t numSamples,
                float progress
            ) -> int32_t {
                if (g_tts_stream_cancelled.load()) {
                    return 0;
                }

                jfloatArray floatArray = env->NewFloatArray(numSamples);
                if (floatArray == nullptr) {
                    return 0;
                }
                env->SetFloatArrayRegion(floatArray, 0, numSamples, samples);

                env->CallStaticVoidMethod(moduleClass, onChunk, floatArray, sampleRate, progress, JNI_FALSE);
                env->DeleteLocalRef(floatArray);
                return 1;
            }
        );

        env->ReleaseStringUTFChars(text, textStr);
        env->DeleteLocalRef(moduleClass);

        if (!ok && !g_tts_stream_cancelled.load()) {
            if (onError != nullptr) {
                jstring errorMsg = env->NewStringUTF("TTS: Streaming generation failed");
                env->CallStaticVoidMethod(moduleClass, onError, errorMsg);
                env->DeleteLocalRef(errorMsg);
            }
        }

        return ok ? JNI_TRUE : JNI_FALSE;
    } catch (const std::exception &e) {
        LOGE("TTS JNI: Exception in nativeTtsGenerateStream: %s", e.what());
        return JNI_FALSE;
    } catch (...) {
        LOGE("TTS JNI: Unknown exception in nativeTtsGenerateStream");
        return JNI_FALSE;
    }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsCancelStream(
    JNIEnv * /* env */,
    jobject /* this */) {
    g_tts_stream_cancelled.store(true);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeTtsGetSampleRate(
    JNIEnv * /* env */,
    jobject /* this */) {
    try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            LOGE("TTS JNI: Not initialized. Call initialize() first.");
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
            LOGE("TTS JNI: Not initialized. Call initialize() first.");
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
            g_tts_wrapper.reset();
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
            LOGE("TTS JNI: samples or filePath is null");
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
