/**
 * sherpa-onnx-audio-convert-jni.cpp — JNI stubs for file-based audio conversion/decode.
 */
#include <jni.h>
#include <string>
#include <vector>
#include "audio_convert_file.h"

#define LOG_TAG "AudioConvertJNI"
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertAudioToWav16k(
    JNIEnv* env,
    jobject /* this */,
    jstring inputPath,
    jstring outputPath) {
    if (inputPath == nullptr || outputPath == nullptr) {
        return env->NewStringUTF("inputPath and outputPath must be non-null");
    }
    const char* input = env->GetStringUTFChars(inputPath, nullptr);
    const char* output = env->GetStringUTFChars(outputPath, nullptr);
    if (input == nullptr || output == nullptr) {
        if (input) env->ReleaseStringUTFChars(inputPath, input);
        if (output) env->ReleaseStringUTFChars(outputPath, output);
        return env->NewStringUTF("Failed to get path strings");
    }
    std::string err = sherpa_audio_convert_to_wav16k_mono(input, output);
    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    return env->NewStringUTF(err.c_str());
}

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

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeDecodeAudioFileToFloatSamples(JNIEnv* env,
                                                                       jobject /* this */,
                                                                       jstring inputPath,
                                                                       jint targetSampleRateHz) {
    jclass objectClass = env->FindClass("java/lang/Object");
    if (!objectClass) {
        return nullptr;
    }

    auto makeError = [&](const char* msg) -> jobjectArray {
        jobjectArray ret = env->NewObjectArray(1, objectClass, nullptr);
        if (!ret) return nullptr;
        jstring jmsg = env->NewStringUTF(msg);
        env->SetObjectArrayElement(ret, 0, jmsg);
        env->DeleteLocalRef(jmsg);
        return ret;
    };

    if (inputPath == nullptr) {
        return makeError("inputPath must be non-null");
    }
    const char* input = env->GetStringUTFChars(inputPath, nullptr);
    if (input == nullptr) {
        return makeError("Failed to get path string");
    }

    std::vector<float> samples;
    int sampleRate = 0;
    std::string err = sherpa_audio_decode_file_to_float_mono(input, (int)targetSampleRateHz, &samples, &sampleRate);
    env->ReleaseStringUTFChars(inputPath, input);

    if (!err.empty()) {
        return makeError(err.c_str());
    }

    jfloatArray jfloats = env->NewFloatArray((jsize)samples.size());
    if (!jfloats) {
        return makeError("Failed to allocate float array");
    }
    if (!samples.empty()) {
        env->SetFloatArrayRegion(jfloats, 0, (jsize)samples.size(), samples.data());
    }

    jobjectArray ret = env->NewObjectArray(2, objectClass, nullptr);
    if (!ret) {
        env->DeleteLocalRef(jfloats);
        return makeError("Failed to allocate result array");
    }
    env->SetObjectArrayElement(ret, 0, jfloats);

    jclass intCls = env->FindClass("java/lang/Integer");
    jmethodID intCtor = env->GetMethodID(intCls, "<init>", "(I)V");
    jobject jrate = env->NewObject(intCls, intCtor, sampleRate);
    env->SetObjectArrayElement(ret, 1, jrate);

    env->DeleteLocalRef(jfloats);
    env->DeleteLocalRef(jrate);
    env->DeleteLocalRef(intCls);
    return ret;
}

}  // extern "C"
