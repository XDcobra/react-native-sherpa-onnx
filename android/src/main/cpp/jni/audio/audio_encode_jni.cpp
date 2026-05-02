/**
 * audio_encode_jni.cpp — JNI bridge for AudioEncodeSession.
 *
 * Exposes create/feedChunk/finish/release as static methods called from
 * SherpaOnnxModule.kt companion object.
 */
#include <jni.h>
#include <string>
#include <atomic>

#include "AudioEncodeSession.h"

/** Last error from AudioEncodeSession::create (for diagnostics when create returns 0). */
static thread_local std::string g_lastEncodeSessionCreateError;

#define LOG_TAG "AudioEncodeJNI"
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

/**
 * Create an AudioEncodeSession. Returns the session pointer as jlong (0 on error).
 * cancelFlagPtr must point to a valid std::atomic<bool> that outlives the session.
 */
JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionCreate(
    JNIEnv* env,
    jclass /* clazz */,
    jstring outputPath,
    jstring format,
    jint inputSampleRate,
    jint inputChannelCount,
    jint outputSampleRateHz,
    jint bitrate,
    jint quality,
    jlong totalFramesEstimate,
    jlong cancelFlagPtr)
{
    g_lastEncodeSessionCreateError.clear();

    if (!outputPath || !format) {
        LOGE("nativeEncodeSessionCreate: null outputPath or format");
        g_lastEncodeSessionCreateError = "null outputPath or format";
        return 0;
    }

    const char* outPathC = env->GetStringUTFChars(outputPath, nullptr);
    const char* fmtC = env->GetStringUTFChars(format, nullptr);
    if (!outPathC || !fmtC) {
        g_lastEncodeSessionCreateError = "GetStringUTFChars failed";
        if (outPathC) env->ReleaseStringUTFChars(outputPath, outPathC);
        if (fmtC) env->ReleaseStringUTFChars(format, fmtC);
        return 0;
    }

    sherpa::AudioEncodeConfig config{};
    config.outputPath = outPathC;
    config.formatHint = fmtC;
    config.inputSampleRate = (int)inputSampleRate;
    config.inputChannelCount = (int)inputChannelCount;
    config.outputSampleRateHz = (int)outputSampleRateHz;
    config.bitrate = (int)bitrate;
    config.quality = (int)quality;

    auto* cancelFlag = reinterpret_cast<std::atomic<bool>*>(cancelFlagPtr);

    std::string errorOut;
    auto session = sherpa::AudioEncodeSession::create(
        config,
        (int64_t)totalFramesEstimate,
        nullptr, // progress callback managed at Kotlin level
        *cancelFlag,
        errorOut
    );

    env->ReleaseStringUTFChars(outputPath, outPathC);
    env->ReleaseStringUTFChars(format, fmtC);

    if (!session) {
        g_lastEncodeSessionCreateError = errorOut;
        LOGE("nativeEncodeSessionCreate failed: %s", errorOut.c_str());
        return 0;
    }

    return reinterpret_cast<jlong>(session.release());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionLastCreateError(
    JNIEnv* env,
    jclass /* clazz */)
{
    return env->NewStringUTF(g_lastEncodeSessionCreateError.c_str());
}

/**
 * Feed a chunk of float32 samples. Returns empty string on success.
 */
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionFeedChunk(
    JNIEnv* env,
    jclass /* clazz */,
    jlong sessionPtr,
    jfloatArray samples,
    jint frameCount)
{
    if (!sessionPtr || !samples) {
        return env->NewStringUTF("ENCODE_INVALID_SESSION: null session or samples");
    }

    auto* session = reinterpret_cast<sherpa::AudioEncodeSession*>(sessionPtr);
    jfloat* ptr = env->GetFloatArrayElements(samples, nullptr);
    if (!ptr) {
        return env->NewStringUTF("ENCODE_JNI_ERROR: Failed to get float array");
    }

    std::string err = session->feedChunk(ptr, (int)frameCount);

    env->ReleaseFloatArrayElements(samples, ptr, JNI_ABORT);
    return env->NewStringUTF(err.c_str());
}

/**
 * Flush encoder and close output file.
 */
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionFinish(
    JNIEnv* env,
    jclass /* clazz */,
    jlong sessionPtr)
{
    if (!sessionPtr) {
        return env->NewStringUTF("ENCODE_INVALID_SESSION: null session");
    }

    auto* session = reinterpret_cast<sherpa::AudioEncodeSession*>(sessionPtr);
    std::string err = session->finish();
    return env->NewStringUTF(err.c_str());
}

/**
 * Release the session. Idempotent.
 */
JNIEXPORT void JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeEncodeSessionRelease(
    JNIEnv* /* env */,
    jclass /* clazz */,
    jlong sessionPtr)
{
    if (sessionPtr) {
        delete reinterpret_cast<sherpa::AudioEncodeSession*>(sessionPtr);
    }
}

}  // extern "C"
