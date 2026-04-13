/**
 * sherpa-onnx-audio-convert-jni.cpp — JNI bindings for audio conversion.
 */
#include <jni.h>
#include <string>
#include "audio_convert_file.h"

#define LOG_TAG "AudioConvertJNI"
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertAudioToFormat(
    JNIEnv* env,
    jobject /* this */,
    jstring inputPath,
    jstring outputPath,
    jstring formatHint,
    jint outputSampleRateHz) {
    if (inputPath == nullptr || outputPath == nullptr || formatHint == nullptr) {
        return env->NewStringUTF("inputPath, outputPath and formatHint must be non-null");
    }
    const char* input = env->GetStringUTFChars(inputPath, nullptr);
    const char* output = env->GetStringUTFChars(outputPath, nullptr);
    const char* fmt = env->GetStringUTFChars(formatHint, nullptr);
    if (input == nullptr || output == nullptr || fmt == nullptr) {
        if (input) env->ReleaseStringUTFChars(inputPath, input);
        if (output) env->ReleaseStringUTFChars(outputPath, output);
        if (fmt) env->ReleaseStringUTFChars(formatHint, fmt);
        return env->NewStringUTF("Failed to get path/format strings");
    }

    std::string err = sherpa_audio_convert_to_format(input, output, fmt, (int)outputSampleRateHz);

    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    env->ReleaseStringUTFChars(formatHint, fmt);

    return env->NewStringUTF(err.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertPcmToFormat(
    JNIEnv* env,
    jobject /* this */,
    jfloatArray samples,
    jint sampleRate,
    jint channelCount,
    jstring outputPath,
    jstring format,
    jint outputSampleRateHz) {
    if (samples == nullptr || outputPath == nullptr || format == nullptr) {
        return env->NewStringUTF("samples, outputPath and format must be non-null");
    }
    jfloat* samplesPtr = env->GetFloatArrayElements(samples, nullptr);
    jint numSamples = env->GetArrayLength(samples);
    const char* outPath = env->GetStringUTFChars(outputPath, nullptr);
    const char* fmt = env->GetStringUTFChars(format, nullptr);
    if (samplesPtr == nullptr || outPath == nullptr || fmt == nullptr) {
        if (samplesPtr) env->ReleaseFloatArrayElements(samples, samplesPtr, JNI_ABORT);
        if (outPath) env->ReleaseStringUTFChars(outputPath, outPath);
        if (fmt) env->ReleaseStringUTFChars(format, fmt);
        return env->NewStringUTF("Failed to get JNI elements");
    }

    std::string err = sherpa_audio_convert_pcm_to_format(
        samplesPtr, numSamples, sampleRate, channelCount, outPath, fmt, outputSampleRateHz);

    env->ReleaseFloatArrayElements(samples, samplesPtr, JNI_ABORT);
    env->ReleaseStringUTFChars(outputPath, outPath);
    env->ReleaseStringUTFChars(format, fmt);
    return env->NewStringUTF(err.c_str());
}

}  // extern "C"
