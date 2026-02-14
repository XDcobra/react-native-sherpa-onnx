// JNI for converting arbitrary audio files to WAV 16 kHz mono 16-bit PCM (sherpa-onnx input format).
// When HAVE_FFMPEG is defined (CMake), FFmpeg prebuilts are linked and conversion is available.
// When not defined, nativeConvertAudioToWav16k returns failure with "FFmpeg not available".

#include <android/log.h>
#include <jni.h>
#include <string>

#define LOG_TAG "AudioConvertJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}
#include <cstdio>
#include <vector>
#endif

// Returns empty string on success, or error message on failure.
static std::string convertToWav16kMono(const char* inputPath, const char* outputPath) {
#ifdef HAVE_FFMPEG
    (void)inputPath;
    (void)outputPath;
    // TODO: implement full conversion: avformat_open_input -> find stream -> decode -> swr (16k mono s16) -> write WAV
    return "Not implemented yet (FFmpeg linked)";
#else
    (void)inputPath;
    (void)outputPath;
    return "FFmpeg not available. Build prebuilts with third_party/ffmpeg_prebuilt/build_ffmpeg.ps1 or build_ffmpeg.sh.";
#endif
}

extern "C" {

// Called from Kotlin: SherpaOnnxModule.nativeConvertAudioToWav16k(inputPath, outputPath) -> Boolean
// or from a dedicated helper that returns an error string. We use a single JNI that returns a boolean
// and optionally pass back an error message via a separate call or out parameter.
// For simplicity we expose one method that returns a jstring: empty = success, non-empty = error message.
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
    std::string err = convertToWav16kMono(input, output);
    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    return env->NewStringUTF(err.c_str());
}

}  // extern "C"
