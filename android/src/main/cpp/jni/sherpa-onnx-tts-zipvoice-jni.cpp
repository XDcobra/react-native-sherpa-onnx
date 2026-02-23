// JNI wrapper for Zipvoice TTS via the sherpa-onnx C-API.
// The Kotlin API (Tts.kt) does not expose OfflineTtsZipvoiceModelConfig,
// so we call the C-API directly from native code.

#include <jni.h>
#include <cstring>
#include <android/log.h>

#include "sherpa-onnx/c-api/c-api.h"

#define LOG_TAG "ZipvoiceTtsJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// Helper: get a non-null C string from a jstring (returns "" for null).
struct JStringGuard {
  JNIEnv* env;
  jstring jstr;
  const char* cstr;

  JStringGuard(JNIEnv* e, jstring s) : env(e), jstr(s), cstr(nullptr) {
    if (s) cstr = env->GetStringUTFChars(s, nullptr);
  }
  ~JStringGuard() {
    if (cstr) env->ReleaseStringUTFChars(jstr, cstr);
  }
  const char* get() const { return cstr ? cstr : ""; }
};

// Build a Java float[] + int pair as Object[] { float[], Integer } for returning generated audio.
jobjectArray buildAudioResult(JNIEnv* env, const float* samples, int32_t n, int32_t sampleRate) {
  jclass objClass = env->FindClass("java/lang/Object");
  if (!objClass) return nullptr;

  jobjectArray result = env->NewObjectArray(2, objClass, nullptr);
  if (!result) {
    env->DeleteLocalRef(objClass);
    return nullptr;
  }

  // Element 0: float[] samples
  jfloatArray jsamples = env->NewFloatArray(n);
  if (jsamples && n > 0) {
    env->SetFloatArrayRegion(jsamples, 0, n, samples);
  }
  env->SetObjectArrayElement(result, 0, jsamples);
  if (jsamples) env->DeleteLocalRef(jsamples);

  // Element 1: Integer sampleRate
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID intValueOf = env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject jrate = env->CallStaticObjectMethod(intClass, intValueOf, sampleRate);
  env->SetObjectArrayElement(result, 1, jrate);
  env->DeleteLocalRef(intClass);
  if (jrate) env->DeleteLocalRef(jrate);

  env->DeleteLocalRef(objClass);
  return result;
}

}  // namespace

extern "C" {

// Create a Zipvoice TTS instance via C-API. Returns the pointer as a jlong (0 on failure).
JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeCreate(
    JNIEnv* env, jobject /* this */,
    jstring j_tokens, jstring j_encoder, jstring j_decoder, jstring j_vocoder,
    jstring j_data_dir, jstring j_lexicon,
    jfloat feat_scale, jfloat t_shift, jfloat target_rms, jfloat guidance_scale,
    jint num_threads, jboolean debug,
    jstring j_rule_fsts, jstring j_rule_fars, jint max_num_sentences, jfloat silence_scale) {
  JStringGuard tokens(env, j_tokens);
  JStringGuard encoder(env, j_encoder);
  JStringGuard decoder(env, j_decoder);
  JStringGuard vocoder(env, j_vocoder);
  JStringGuard dataDir(env, j_data_dir);
  JStringGuard lexicon(env, j_lexicon);
  JStringGuard ruleFsts(env, j_rule_fsts);
  JStringGuard ruleFars(env, j_rule_fars);

  LOGI("nativeCreate: tokens=%s, encoder=%s, decoder=%s, vocoder=%s, dataDir=%s, lexicon=%s",
       tokens.get(), encoder.get(), decoder.get(), vocoder.get(), dataDir.get(), lexicon.get());
  LOGI("nativeCreate: featScale=%.3f, tShift=%.3f, targetRms=%.3f, guidanceScale=%.3f, threads=%d, debug=%d",
       feat_scale, t_shift, target_rms, guidance_scale, num_threads, debug);
  LOGI("nativeCreate: ruleFsts=%s, ruleFars=%s, maxNumSentences=%d, silenceScale=%.3f",
       ruleFsts.get(), ruleFars.get(), max_num_sentences, silence_scale);

  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof(config));

  config.model.zipvoice.tokens = tokens.get();
  config.model.zipvoice.encoder = encoder.get();
  config.model.zipvoice.decoder = decoder.get();
  config.model.zipvoice.vocoder = vocoder.get();
  config.model.zipvoice.data_dir = dataDir.get();
  config.model.zipvoice.lexicon = lexicon.get();
  config.model.zipvoice.feat_scale = feat_scale;
  config.model.zipvoice.t_shift = t_shift;
  config.model.zipvoice.target_rms = target_rms;
  config.model.zipvoice.guidance_scale = guidance_scale;

  config.model.num_threads = num_threads;
  config.model.debug = debug ? 1 : 0;
  config.model.provider = "cpu";

  config.rule_fsts = ruleFsts.get();
  config.rule_fars = ruleFars.get();
  config.max_num_sentences = max_num_sentences;
  config.silence_scale = silence_scale;

  const SherpaOnnxOfflineTts* tts = SherpaOnnxCreateOfflineTts(&config);
  if (!tts) {
    LOGE("nativeCreate: SherpaOnnxCreateOfflineTts returned null");
    return 0;
  }

  LOGI("nativeCreate: success, sampleRate=%d, numSpeakers=%d",
       SherpaOnnxOfflineTtsSampleRate(tts), SherpaOnnxOfflineTtsNumSpeakers(tts));

  return reinterpret_cast<jlong>(tts);
}

// Destroy a Zipvoice TTS instance.
JNIEXPORT void JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeDestroy(
    JNIEnv* /* env */, jobject /* this */, jlong ptr) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  if (tts) {
    SherpaOnnxDestroyOfflineTts(tts);
    LOGI("nativeDestroy: released");
  }
}

// Get the sample rate of the Zipvoice TTS model.
JNIEXPORT jint JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeGetSampleRate(
    JNIEnv* /* env */, jobject /* this */, jlong ptr) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  return tts ? SherpaOnnxOfflineTtsSampleRate(tts) : 0;
}

// Get the number of speakers of the Zipvoice TTS model.
JNIEXPORT jint JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeGetNumSpeakers(
    JNIEnv* /* env */, jobject /* this */, jlong ptr) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  return tts ? SherpaOnnxOfflineTtsNumSpeakers(tts) : 0;
}

// Generate audio (non-zero-shot). Returns Object[] { float[], Integer }.
JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeGenerate(
    JNIEnv* env, jobject /* this */,
    jlong ptr, jstring j_text, jint sid, jfloat speed) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  if (!tts) {
    LOGE("nativeGenerate: tts pointer is null");
    return nullptr;
  }

  JStringGuard text(env, j_text);
  LOGI("nativeGenerate: text=%s, sid=%d, speed=%.2f", text.get(), sid, speed);

  const SherpaOnnxGeneratedAudio* audio =
      SherpaOnnxOfflineTtsGenerate(tts, text.get(), sid, speed);
  if (!audio) {
    LOGE("nativeGenerate: SherpaOnnxOfflineTtsGenerate returned null");
    return nullptr;
  }

  LOGI("nativeGenerate: got %d samples at %d Hz", audio->n, audio->sample_rate);
  jobjectArray result = buildAudioResult(env, audio->samples, audio->n, audio->sample_rate);

  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  return result;
}

// Generate audio with callback for streaming. Returns Object[] { float[], Integer } for the
// final concatenated audio. The callback is invoked per chunk.
JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeGenerateWithCallback(
    JNIEnv* env, jobject thiz,
    jlong ptr, jstring j_text, jint sid, jfloat speed) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  if (!tts) {
    LOGE("nativeGenerateWithCallback: tts pointer is null");
    return nullptr;
  }

  JStringGuard text(env, j_text);

  // We use the progress callback variant to get chunks.
  // The JNI environment and `thiz` are stored in a struct passed through void* arg.
  struct CallbackCtx {
    JNIEnv* env;
    jobject thiz;
    jmethodID onChunkId;
    bool cancelled;
  };

  jclass cls = env->GetObjectClass(thiz);
  jmethodID onChunkId = env->GetMethodID(cls, "onNativeChunk", "([FI)Z");
  env->DeleteLocalRef(cls);
  if (!onChunkId) {
    LOGE("nativeGenerateWithCallback: onNativeChunk method not found");
    return nullptr;
  }

  CallbackCtx ctx{env, thiz, onChunkId, false};

  auto callback = [](const float* samples, int32_t n, float /* progress */, void* arg) -> int32_t {
    auto* c = static_cast<CallbackCtx*>(arg);
    if (c->cancelled) return 0;

    jfloatArray chunk = c->env->NewFloatArray(n);
    if (chunk && n > 0) {
      c->env->SetFloatArrayRegion(chunk, 0, n, samples);
    }

    // Call Java: boolean onNativeChunk(float[] samples, int n)
    jboolean cont = c->env->CallBooleanMethod(c->thiz, c->onChunkId, chunk, n);
    if (chunk) c->env->DeleteLocalRef(chunk);

    if (!cont) {
      c->cancelled = true;
      return 0;
    }
    return 1;
  };

  const SherpaOnnxGeneratedAudio* audio =
      SherpaOnnxOfflineTtsGenerateWithProgressCallbackWithArg(
          tts, text.get(), sid, speed, callback, &ctx);

  if (!audio) {
    LOGE("nativeGenerateWithCallback: generate returned null");
    return nullptr;
  }

  jobjectArray result = buildAudioResult(env, audio->samples, audio->n, audio->sample_rate);
  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  return result;
}

// Zero-shot voice cloning with Zipvoice. Returns Object[] { float[], Integer }.
JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_ZipvoiceTtsWrapper_nativeGenerateWithZipvoice(
    JNIEnv* env, jobject /* this */,
    jlong ptr, jstring j_text, jstring j_prompt_text,
    jfloatArray j_prompt_samples, jint prompt_sr,
    jfloat speed, jint num_steps) {
  auto* tts = reinterpret_cast<const SherpaOnnxOfflineTts*>(ptr);
  if (!tts) {
    LOGE("nativeGenerateWithZipvoice: tts pointer is null");
    return nullptr;
  }

  JStringGuard text(env, j_text);
  JStringGuard promptText(env, j_prompt_text);

  jfloat* promptSamples = nullptr;
  jint nPrompt = 0;
  if (j_prompt_samples) {
    nPrompt = env->GetArrayLength(j_prompt_samples);
    promptSamples = env->GetFloatArrayElements(j_prompt_samples, nullptr);
  }

  LOGI("nativeGenerateWithZipvoice: text=%s, promptLen=%d, promptSr=%d, speed=%.2f, steps=%d",
       text.get(), nPrompt, prompt_sr, speed, num_steps);

  const SherpaOnnxGeneratedAudio* audio =
      SherpaOnnxOfflineTtsGenerateWithZipvoice(
          tts, text.get(), promptText.get(),
          promptSamples, nPrompt, prompt_sr,
          speed, num_steps);

  if (promptSamples) {
    env->ReleaseFloatArrayElements(j_prompt_samples, promptSamples, JNI_ABORT);
  }

  if (!audio) {
    LOGE("nativeGenerateWithZipvoice: returned null");
    return nullptr;
  }

  LOGI("nativeGenerateWithZipvoice: got %d samples at %d Hz", audio->n, audio->sample_rate);
  jobjectArray result = buildAudioResult(env, audio->samples, audio->n, audio->sample_rate);

  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  return result;
}

}  // extern "C"
