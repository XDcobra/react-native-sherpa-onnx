/**
 * Float32 little-endian mono PCM file (raw) to encoded output (mp3/flac/…),
 * sharing the same transcode pipeline as file-based convert (see body include).
 */
#include <android/log.h>
#include <jni.h>
#include <cstdio>
#include <string>
#include <sys/stat.h>
#include <vector>

#define LOG_TAG "AudioF32leConvert"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libswresample/swresample.h>
}
#endif

#include "audio_f32le_to_format_body.inc.cpp"

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertFloat32MonoFileToFormat(
    JNIEnv* env,
    jobject /* this */,
    jstring rawPath,
    jint pcmSampleRate,
    jstring outputPath,
    jstring formatHint,
    jint outputSampleRateHz) {
    if (rawPath == nullptr || outputPath == nullptr || formatHint == nullptr) {
        return env->NewStringUTF("rawPath, outputPath and formatHint must be non-null");
    }
    const char* raw = env->GetStringUTFChars(rawPath, nullptr);
    const char* out = env->GetStringUTFChars(outputPath, nullptr);
    const char* fmt = env->GetStringUTFChars(formatHint, nullptr);
    if (raw == nullptr || out == nullptr || fmt == nullptr) {
        if (raw) env->ReleaseStringUTFChars(rawPath, raw);
        if (out) env->ReleaseStringUTFChars(outputPath, out);
        if (fmt) env->ReleaseStringUTFChars(formatHint, fmt);
        return env->NewStringUTF("Failed to get path/format strings");
    }
    std::string err = convertF32leMonoFileToFormat(raw, (int)pcmSampleRate, out, fmt, (int)outputSampleRateHz);
    env->ReleaseStringUTFChars(rawPath, raw);
    env->ReleaseStringUTFChars(outputPath, out);
    env->ReleaseStringUTFChars(formatHint, fmt);
    return env->NewStringUTF(err.c_str());
}

}  // extern "C"
