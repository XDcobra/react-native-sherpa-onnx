/**
 * JNI bridge for AudioDecodeSession — exposes decodeFile() to Kotlin.
 *
 * The Kotlin side calls nativeDecodeFileToChunks which runs the decode
 * on the calling thread (caller's coroutine dispatcher or background executor).
 */

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <cerrno>
#include <cstdio>
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
 * Streaming decode directly to a raw float32 file on disk.
 * Avoids all large heap allocations — chunks are fwrite'd as they arrive.
 *
 * Returns a HashMap with:
 *   "outputPath"       (String)  — absolute path to the written .f32 file
 *   "numSamples"       (Long)    — total float32 sample count
 *   "sourceSampleRate" (Integer) — source file sample rate
 *   "sourceChannels"   (Integer) — source file channel count
 *
 * On error throws a Java RuntimeException with DECODE_* error code prefix.
 */
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDecodeFileToMmapFile(
    JNIEnv* env,
    jclass /* clazz */,
    jstring jPath,
    jint inputFd,
    jint targetSampleRate,
    jboolean forceMono,
    jint chunkSize,
    jlong cancelFlagPtr,
    jstring jOutputPath,
    jobject jProgressCallback
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
    const char* outputPath = nullptr;
    if (jOutputPath) {
        outputPath = env->GetStringUTFChars(jOutputPath, nullptr);
    }
    if (!outputPath || outputPath[0] == '\0') {
        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        if (outputPath && jOutputPath) env->ReleaseStringUTFChars(jOutputPath, outputPath);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                      "DECODE_INTERNAL_ERROR: Missing output path for mmap decode");
        return nullptr;
    }

    if ((!path || path[0] == '\0') && inputFd < 0) {
        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        env->ReleaseStringUTFChars(jOutputPath, outputPath);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                      "DECODE_NOT_FOUND: Empty file path and invalid fd");
        return nullptr;
    }

    sherpa::AudioDecodeConfig config;
    config.targetSampleRate = (int)targetSampleRate;
    config.forceMono = (bool)forceMono;
    config.chunkSize = chunkSize > 0 ? (int)chunkSize : 8192;

    auto& cancelFlag = *reinterpret_cast<std::atomic<bool>*>(cancelFlagPtr);

    jmethodID onProgressMethod = nullptr;
    jobject progressCbGlobal = nullptr;
    if (jProgressCallback) {
        jclass progressCbClass = env->GetObjectClass(jProgressCallback);
        if (progressCbClass) {
            onProgressMethod = env->GetMethodID(progressCbClass, "onProgress", "(JJIII)V");
            env->DeleteLocalRef(progressCbClass);
        }
        if (!onProgressMethod) {
            if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
            env->ReleaseStringUTFChars(jOutputPath, outputPath);
            env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                          "DECODE_INTERNAL_ERROR: Progress callback missing onProgress(JJIII)V");
            return nullptr;
        }
        progressCbGlobal = env->NewGlobalRef(jProgressCallback);
    }

    int srcSampleRateForProgress = 0;
    int srcChannelsForProgress = 0;
    sherpa::DecodeProgressCallback onProgressCb = nullptr;
    sherpa::DecodeStreamInfoCallback onStreamInfoCb = nullptr;
    if (progressCbGlobal && onProgressMethod) {
        onStreamInfoCb = [&srcSampleRateForProgress, &srcChannelsForProgress](int sr, int ch) {
            srcSampleRateForProgress = sr;
            srcChannelsForProgress = ch;
        };
        onProgressCb = [env, progressCbGlobal, onProgressMethod, &srcSampleRateForProgress,
                          &srcChannelsForProgress, &cancelFlag](int64_t framesDecoded,
                                                                 int64_t totalEstimate, int percent) {
            env->CallVoidMethod(progressCbGlobal, onProgressMethod, (jlong)framesDecoded,
                                (jlong)totalEstimate, (jint)percent, (jint)srcSampleRateForProgress,
                                (jint)srcChannelsForProgress);
            if (env->ExceptionCheck()) {
                cancelFlag.store(true);
                env->ExceptionClear();
            }
        };
    }

    // Open output file for streaming writes
    std::string outPathStr(outputPath);
    FILE* outFile = fopen(outPathStr.c_str(), "wb");
    if (!outFile) {
        int err = errno;
        if (progressCbGlobal) {
            env->DeleteGlobalRef(progressCbGlobal);
        }
        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        env->ReleaseStringUTFChars(jOutputPath, outputPath);
        std::string msg = "DECODE_INTERNAL_ERROR: Cannot open output file: " + std::string(strerror(err));
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"), msg.c_str());
        return nullptr;
    }

    int64_t totalSamplesWritten = 0;
    bool writeError = false;

    auto onChunk = [&](const float* samples, int count) {
        if (writeError) return;
        size_t written = fwrite(samples, sizeof(float), (size_t)count, outFile);
        if ((int)written != count) {
            writeError = true;
        } else {
            totalSamplesWritten += count;
        }
    };

    try {
        auto result = sherpa::decodeFile(path, (int)inputFd, config, onChunk, onProgressCb,
                                         onStreamInfoCb, cancelFlag);
        fclose(outFile);
        outFile = nullptr;

        if (progressCbGlobal) {
            env->DeleteGlobalRef(progressCbGlobal);
            progressCbGlobal = nullptr;
        }

        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        env->ReleaseStringUTFChars(jOutputPath, outputPath);

        if (writeError) {
            remove(outPathStr.c_str());
            env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                          "DECODE_INTERNAL_ERROR: Write error during streaming decode");
            return nullptr;
        }

        // Build result HashMap
        jclass hashMapClass = env->FindClass("java/util/HashMap");
        jmethodID hashMapInit = env->GetMethodID(hashMapClass, "<init>", "()V");
        jmethodID hashMapPut = env->GetMethodID(hashMapClass, "put",
            "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        jobject map = env->NewObject(hashMapClass, hashMapInit);
        auto putEntry = [env, map, hashMapPut](const char* key, jobject value) {
            jstring jKey = env->NewStringUTF(key);
            jobject prev = env->CallObjectMethod(map, hashMapPut, jKey, value);
            if (prev) env->DeleteLocalRef(prev);
            env->DeleteLocalRef(jKey);
        };

        jstring jOutPath = env->NewStringUTF(outPathStr.c_str());
        putEntry("outputPath", jOutPath);
        env->DeleteLocalRef(jOutPath);

        jclass longClass = env->FindClass("java/lang/Long");
        jmethodID longValueOf = env->GetStaticMethodID(longClass, "valueOf", "(J)Ljava/lang/Long;");
        jobject numSamplesVal = env->CallStaticObjectMethod(longClass, longValueOf, (jlong)totalSamplesWritten);
        putEntry("numSamples", numSamplesVal);
        env->DeleteLocalRef(numSamplesVal);
        env->DeleteLocalRef(longClass);

        jclass intClass = env->FindClass("java/lang/Integer");
        jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
        jobject srcSr = env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceSampleRate);
        putEntry("sourceSampleRate", srcSr);
        env->DeleteLocalRef(srcSr);
        jobject srcCh = env->CallStaticObjectMethod(intClass, intValueOf, (jint)result.sourceChannels);
        putEntry("sourceChannels", srcCh);
        env->DeleteLocalRef(srcCh);
        env->DeleteLocalRef(intClass);
        env->DeleteLocalRef(hashMapClass);

        return map;
    } catch (const std::runtime_error& e) {
        if (progressCbGlobal) {
            env->DeleteGlobalRef(progressCbGlobal);
        }
        if (outFile) fclose(outFile);
        remove(outPathStr.c_str());
        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        env->ReleaseStringUTFChars(jOutputPath, outputPath);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"), e.what());
        return nullptr;
    } catch (...) {
        if (progressCbGlobal) {
            env->DeleteGlobalRef(progressCbGlobal);
        }
        if (outFile) fclose(outFile);
        remove(outPathStr.c_str());
        if (path && jPath) env->ReleaseStringUTFChars(jPath, path);
        env->ReleaseStringUTFChars(jOutputPath, outputPath);
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                       "DECODE_INTERNAL_ERROR: Unknown error during streaming mmap decode");
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

    auto onChunk = [env, chunkCbGlobal, onChunkMethod, &cancelFlag](const float* samples, int count) {
        jfloatArray arr = env->NewFloatArray(count);
        if (!arr) {
            return;
        }
        env->SetFloatArrayRegion(arr, 0, count, samples);
        env->CallVoidMethod(chunkCbGlobal, onChunkMethod, arr, (jint)count);
        env->DeleteLocalRef(arr);
        // If Java threw (e.g. live buffer finalized mid-ingest), clear pending exception
        // before the next JNI call — otherwise CheckJNI aborts. Stop decode via cancelFlag.
        if (env->ExceptionCheck()) {
            cancelFlag.store(true);
            env->ExceptionClear();
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
        onProgress = [env, progressCbGlobal, onProgressMethod, &srcSampleRate, &srcChannels,
                      &cancelFlag](int64_t framesDecoded, int64_t totalEstimate, int percent) {
            env->CallVoidMethod(progressCbGlobal, onProgressMethod,
                (jlong)framesDecoded, (jlong)totalEstimate, (jint)percent,
                (jint)srcSampleRate, (jint)srcChannels);
            if (env->ExceptionCheck()) {
                cancelFlag.store(true);
                env->ExceptionClear();
            }
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

/**
 * Probe audio file duration from container metadata (no decode).
 * Returns long[2]: { durationMs, isExact (1 or 0) }.
 */
JNIEXPORT jlongArray JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeProbeFileDuration(
    JNIEnv* env,
    jclass /* clazz */,
    jstring jPath,
    jint inputFd
) {
    const char* path = nullptr;
    if (jPath) {
        path = env->GetStringUTFChars(jPath, nullptr);
        if (!path) {
            env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                          "PROBE_INTERNAL_ERROR: Failed to get path string");
            return nullptr;
        }
    }

    if ((!path || path[0] == '\0') && inputFd < 0) {
        if (path && jPath) {
            env->ReleaseStringUTFChars(jPath, path);
        }
        env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                      "PROBE_NOT_FOUND: Empty file path and invalid fd");
        return nullptr;
    }

    try {
        auto result = sherpa::probeFileDuration(path, (int)inputFd);
        if (path && jPath) {
            env->ReleaseStringUTFChars(jPath, path);
        }

        jlongArray arr = env->NewLongArray(2);
        if (!arr) {
            env->ThrowNew(env->FindClass("java/lang/RuntimeException"),
                          "PROBE_INTERNAL_ERROR: Failed to allocate result array");
            return nullptr;
        }
        jlong values[2] = {result.durationMs, result.isExact ? 1L : 0L};
        env->SetLongArrayRegion(arr, 0, 2, values);
        return arr;
    } catch (const std::exception& e) {
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
                      "PROBE_INTERNAL_ERROR: Unknown error during duration probe");
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
