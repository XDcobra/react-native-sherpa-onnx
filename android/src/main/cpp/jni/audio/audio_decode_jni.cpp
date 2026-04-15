/**
 * JNI bridge for AudioDecodeSession — exposes decodeFile() to Kotlin.
 *
 * The Kotlin side calls nativeDecodeFileToChunks which runs the decode
 * on the calling thread (caller's coroutine dispatcher or background executor).
 */

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <cstring>
#include <string>
#include <vector>

#include "AudioDecodeSession.h"

#define LOG_TAG "AudioDecodeJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

/**
 * Decode an audio file to float32 mono PCM, collecting all chunks into a single array.
 * Returns a jobject with fields: samples (float[]), sourceSampleRate (int), sourceChannels (int).
 * On error throws a Java RuntimeException with DECODE_* error code prefix.
 */
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDecodeFileToBuffer(
    JNIEnv* env,
    jclass /* clazz */,
    jstring jPath,
        jint inputFd,
    jint targetSampleRate,
    jboolean forceMono,
    jint chunkSize,
    jlong cancelFlagPtr
) {
        const char* path = nullptr;
        if (jPath) {
            path = env->GetStringUTFChars(jPath, nullptr);
            if (!path) {
                    env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                                                 "DECODE_INTERNAL_ERROR: Failed to get path string");
                    return nullptr;
            }
        }

        if ((!path || path[0] == '\0') && inputFd < 0) {
            if (path && jPath) {
                env->ReleaseStringUTFChars(jPath, path);
            }
            env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                                         "DECODE_NOT_FOUND: Empty file path and invalid fd");
            return nullptr;
    }

    sherpa::AudioDecodeConfig config;
    config.targetSampleRate = (int)targetSampleRate;
    config.forceMono = (bool)forceMono;
    config.chunkSize = chunkSize > 0 ? (int)chunkSize : 8192;

    auto& cancelFlag = *reinterpret_cast<std::atomic<bool>*>(cancelFlagPtr);

    std::vector<float> allSamples;
    allSamples.reserve(config.chunkSize * 64); // pre-allocate ~500KB

    auto onChunk = [&allSamples](const float* samples, int count) {
        allSamples.insert(allSamples.end(), samples, samples + count);
    };

    try {
                auto result = sherpa::decodeFile(path, (int)inputFd, config, onChunk, nullptr, nullptr, cancelFlag);
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }

        // Create result object: HashMap with samples, sourceSampleRate, sourceChannels
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
        jmethodID hashMapPut = env->GetMethodID(hashMapClass, "put",
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

        jobject map = env->NewObject(hashMapClass, hashMapInit);
        auto putMapEntry = [env, map, hashMapPut](const char* key, jobject value) {
            jstring jKey = env->NewStringUTF(key);
            jobject previousValue = env->CallObjectMethod(map, hashMapPut, jKey, value);
            if (previousValue) {
                env->DeleteLocalRef(previousValue);
            }
            if (jKey) {
                env->DeleteLocalRef(jKey);
            }
        };

        // Samples array
        jfloatArray jSamples = env->NewFloatArray((jint)allSamples.size());
        if (jSamples && !allSamples.empty()) {
            env->SetFloatArrayRegion(jSamples, 0, (jint)allSamples.size(), allSamples.data());
        }
        putMapEntry("samples", jSamples);
        if (jSamples) {
            env->DeleteLocalRef(jSamples);
        }

        // Source sample rate
        jclass intClass = env->FindClass("java/lang/Integer");
        jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
        jobject sourceSampleRateValue =
            env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceSampleRate);
        putMapEntry("sourceSampleRate", sourceSampleRateValue);
        if (sourceSampleRateValue) {
            env->DeleteLocalRef(sourceSampleRateValue);
        }

        // Source channels
        jobject sourceChannelsValue =
            env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceChannels);
        putMapEntry("sourceChannels", sourceChannelsValue);
        if (sourceChannelsValue) {
            env->DeleteLocalRef(sourceChannelsValue);
        }

        // Total frames decoded
        jclass longClass = env->FindClass("java/lang/Long");
        jmethodID longValueOf = env->GetStaticMethodID(longClass, "valueOf", "(J)Ljava/lang/Long;");
        jobject totalFramesDecodedValue =
            env->CallStaticObjectMethod(longClass, longValueOf, (jlong)result.totalFramesDecoded);
        putMapEntry("totalFramesDecoded", totalFramesDecodedValue);
        if (totalFramesDecodedValue) {
            env->DeleteLocalRef(totalFramesDecodedValue);
        }
        if (intClass) {
            env->DeleteLocalRef(intClass);
        }
        if (longClass) {
            env->DeleteLocalRef(longClass);
        }
        if (hashMapClass) {
            env->DeleteLocalRef(hashMapClass);
        }

        return map;
    } catch (const std::runtime_error& e) {
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"), e.what());
        return nullptr;
    } catch (...) {
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                       "DECODE_INTERNAL_ERROR: Unknown error during decode");
        return nullptr;
    }
}

/**
 * Streaming decode: calls back into Java per-chunk for live buffer ingest.
 * The onChunk callback receives float[] and the frame count.
 * Does NOT collect all samples — delivers chunks as they are decoded.
 *
 * @param jChunkCallback - Java object implementing functional interface with
 *                         void onChunk(float[] samples, int frameCount)
 * @param jProgressCallback - Java object implementing functional interface with
 *                            void onProgress(long framesDecoded, long totalEstimate, int percent, int srcRate, int srcChannels)
 *                            May be null.
 */
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDecodeFileStreaming(
    JNIEnv* env,
    jclass /* clazz */,
    jstring jPath,
    jint inputFd,
    jint targetSampleRate,
    jboolean forceMono,
    jint chunkSize,
    jlong cancelFlagPtr,
    jobject jChunkCallback,
    jobject jProgressCallback
) {
    if (!jChunkCallback) {
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                       "DECODE_INTERNAL_ERROR: Null chunk callback");
        return nullptr;
    }

    const char* path = nullptr;
    if (jPath) {
      path = env->GetStringUTFChars(jPath, nullptr);
      if (!path) {
          env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                         "DECODE_INTERNAL_ERROR: Failed to get path string");
          return nullptr;
      }
    }

    if ((!path || path[0] == '\0') && inputFd < 0) {
      if (path && jPath) {
        env->ReleaseStringUTFChars(jPath, path);
      }
      env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                     "DECODE_NOT_FOUND: Empty file path and invalid fd");
      return nullptr;
    }

    sherpa::AudioDecodeConfig config;
    config.targetSampleRate = (int)targetSampleRate;
    config.forceMono = (bool)forceMono;
    config.chunkSize = chunkSize > 0 ? (int)chunkSize : 8192;

    auto& cancelFlag = *reinterpret_cast<std::atomic<bool>*>(cancelFlagPtr);

    // Get callback method IDs
    jclass chunkCbClass = env->GetObjectClass(jChunkCallback);
    jmethodID onChunkMethod = env->GetMethodID(chunkCbClass, "onChunk", "([FI)V");
    if (!onChunkMethod) {
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                       "DECODE_INTERNAL_ERROR: Chunk callback missing onChunk method");
        return nullptr;
    }

    jmethodID onProgressMethod = nullptr;
    if (jProgressCallback) {
        jclass progressCbClass = env->GetObjectClass(jProgressCallback);
        onProgressMethod = env->GetMethodID(progressCbClass, "onProgress", "(JJIII)V");
    }

    // Create global refs for callbacks (they're used across JNI calls during decode loop)
    jobject chunkCbGlobal = env->NewGlobalRef(jChunkCallback);
    jobject progressCbGlobal = jProgressCallback ? env->NewGlobalRef(jProgressCallback) : nullptr;

    auto onChunk = [env, chunkCbGlobal, onChunkMethod](const float* samples, int count) {
        jfloatArray arr = env->NewFloatArray(count);
        if (arr) {
            env->SetFloatArrayRegion(arr, 0, count, samples);
            env->CallVoidMethod(chunkCbGlobal, onChunkMethod, arr, (jint)count);
            env->DeleteLocalRef(arr);
        }
    };

    sherpa::DecodeProgressCallback onProgress = nullptr;
    sherpa::DecodeStreamInfoCallback onStreamInfo = nullptr;
    int srcSampleRate = 0;
    int srcChannels = 0;
    if (progressCbGlobal && onProgressMethod) {
        onStreamInfo = [&srcSampleRate, &srcChannels](int sr, int ch) {
            srcSampleRate = sr;
            srcChannels = ch;
        };
        onProgress = [env, progressCbGlobal, onProgressMethod, &srcSampleRate, &srcChannels](
            int64_t framesDecoded, int64_t totalEstimate, int percent) {
            env->CallVoidMethod(progressCbGlobal, onProgressMethod,
                (jlong)framesDecoded, (jlong)totalEstimate, (jint)percent,
                (jint)srcSampleRate, (jint)srcChannels);
        };
    }

    try {
                auto result = sherpa::decodeFile(path, (int)inputFd, config, onChunk, onProgress, onStreamInfo, cancelFlag);
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->DeleteGlobalRef(chunkCbGlobal);
        if (progressCbGlobal) env->DeleteGlobalRef(progressCbGlobal);

        // Build result HashMap
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
        jmethodID hashMapPut = env->GetMethodID(hashMapClass, "put",
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        jobject map = env->NewObject(hashMapClass, hashMapInit);
        auto putMapEntry = [env, map, hashMapPut](const char* key, jobject value) {
            jstring jKey = env->NewStringUTF(key);
            jobject previousValue = env->CallObjectMethod(map, hashMapPut, jKey, value);
            if (previousValue) {
                env->DeleteLocalRef(previousValue);
            }
            if (jKey) {
                env->DeleteLocalRef(jKey);
            }
        };

        jclass intClass = env->FindClass("java/lang/Integer");
        jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
        jclass longClass = env->FindClass("java/lang/Long");
        jmethodID longValueOf = env->GetStaticMethodID(longClass, "valueOf", "(J)Ljava/lang/Long;");

        jobject sourceSampleRateValue =
            env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceSampleRate);
        putMapEntry("sourceSampleRate", sourceSampleRateValue);
        if (sourceSampleRateValue) {
            env->DeleteLocalRef(sourceSampleRateValue);
        }

        jobject sourceChannelsValue =
            env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceChannels);
        putMapEntry("sourceChannels", sourceChannelsValue);
        if (sourceChannelsValue) {
            env->DeleteLocalRef(sourceChannelsValue);
        }

        jobject totalFramesDecodedValue =
            env->CallStaticObjectMethod(longClass, longValueOf, (jlong)result.totalFramesDecoded);
        putMapEntry("totalFramesDecoded", totalFramesDecodedValue);
        if (totalFramesDecodedValue) {
            env->DeleteLocalRef(totalFramesDecodedValue);
        }
        if (intClass) {
            env->DeleteLocalRef(intClass);
        }
        if (longClass) {
            env->DeleteLocalRef(longClass);
        }
        if (hashMapClass) {
            env->DeleteLocalRef(hashMapClass);
        }

        return map;
    } catch (const std::runtime_error& e) {
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->DeleteGlobalRef(chunkCbGlobal);
        if (progressCbGlobal) env->DeleteGlobalRef(progressCbGlobal);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"), e.what());
        return nullptr;
    } catch (...) {
                if (path && jPath) {
                    env->ReleaseStringUTFChars(jPath, path);
                }
        env->DeleteGlobalRef(chunkCbGlobal);
        if (progressCbGlobal) env->DeleteGlobalRef(progressCbGlobal);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                       "DECODE_INTERNAL_ERROR: Unknown error during streaming decode");
        return nullptr;
    }
}

// ==================== Cancel Flag Lifecycle ====================

/**
 * Allocate a native std::atomic<bool> for cancel coordination.
 * Returns the pointer as jlong.
 */
JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeAllocateCancelFlag(
    JNIEnv* /* env */,
    jclass /* clazz */
) {
    auto* flag = new std::atomic<bool>(false);
    return reinterpret_cast<jlong>(flag);
}

/**
 * Set the cancel flag to the given value.
 */
JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeSetCancelFlag(
    JNIEnv* /* env */,
    jclass /* clazz */,
    jlong ptr,
    jboolean value
) {
    if (ptr != 0) {
        reinterpret_cast<std::atomic<bool>*>(ptr)->store((bool)value);
    }
}

/**
 * Free a previously allocated cancel flag.
 */
JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeFreeCancelFlag(
    JNIEnv* /* env */,
    jclass /* clazz */,
    jlong ptr
) {
    if (ptr != 0) {
        delete reinterpret_cast<std::atomic<bool>*>(ptr);
    }
}

} // extern "C"
