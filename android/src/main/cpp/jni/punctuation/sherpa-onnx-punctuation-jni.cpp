#include "sherpa-onnx-punct-engine-wrapper.h"
#include "sherpa-onnx-detect-jni-common.h"
#include "TextRegistry.h"

#include <android/log.h>
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#define PUNCT_JNI_TAG "SherpaOnnx:punctuation"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, PUNCT_JNI_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, PUNCT_JNI_TAG, __VA_ARGS__)

namespace {

std::mutex g_offline_mutex;
std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::OfflinePunctuationWrapper>>
    g_offline;

std::mutex g_online_mutex;
std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::OnlinePunctuationWrapper>>
    g_online;

std::string CopyRequiredJstring(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID mapPut = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!mapInit || !mapPut) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, mapInit);
  env->DeleteLocalRef(mapClass);
  if (!map) return nullptr;
  *outPut = mapPut;
  return map;
}

std::shared_ptr<sherpaonnx::OfflinePunctuationWrapper> LookupOffline(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_offline_mutex);
  auto it = g_offline.find(id);
  if (it == g_offline.end()) return nullptr;
  return it->second;
}

std::shared_ptr<sherpaonnx::OnlinePunctuationWrapper> LookupOnline(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_online_mutex);
  auto it = g_online.find(id);
  if (it == g_online.end()) return nullptr;
  return it->second;
}

}  // namespace

extern "C" {

/** C ABI used by shared SegEngine (matches iOS punctuation bridge). */
bool sherpaonnx_punct_offline_add_punctuation_if_exists(const std::string &instanceId,
                                                        const std::string &text,
                                                        std::string *outText) {
  auto inst = LookupOffline(instanceId);
  if (!inst) return false;
  const auto result = inst->addPunctuation(text);
  if (!result.success) return false;
  if (outText) *outText = result.text;
  return true;
}

bool sherpaonnx_punct_online_add_punctuation_if_exists(const std::string &instanceId,
                                                       const std::string &text,
                                                       std::string *outText) {
  auto inst = LookupOnline(instanceId);
  if (!inst) return false;
  const auto result = inst->addPunctuation(text);
  if (!result.success) return false;
  if (outText) *outText = result.text;
  return true;
}

bool sherpaonnx_punct_offline_has_instance(const std::string &instanceId) {
  return LookupOffline(instanceId) != nullptr;
}

bool sherpaonnx_punct_online_has_instance(const std::string &instanceId) {
  return LookupOnline(instanceId) != nullptr;
}

// --- Offline (SherpaOnnxPunctuationHelper) ---

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeInitializeOffline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring ctPath,
    jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string ct = CopyRequiredJstring(env, ctPath);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::PunctuationInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_offline_mutex);
    g_offline.erase(id);
    auto inst = std::make_shared<sherpaonnx::OfflinePunctuationWrapper>();
    result = inst->initialize(ct, numThreads > 0 ? numThreads : 1,
                              prov.empty() ? "cpu" : prov, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOffline failed id=%s: %s", id.c_str(),
           result.error.c_str());
    } else {
      g_offline[id] = std::move(inst);
      LOGI("nativeInitializeOffline ok id=%s", id.c_str());
    }
  }

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeAddPunctuationOffline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring text) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string in = CopyRequiredJstring(env, text);
  auto inst = LookupOffline(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Offline punctuation instance not found");
    return map;
  }

  const auto result = inst->addPunctuation(in);
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "text", result.text);
  return map;
}

namespace {

std::string JavaToLowercaseUtf8(JNIEnv* env, const std::string& utf8) {
  if (utf8.empty() || env == nullptr) return utf8;
  jbyteArray bytes = env->NewByteArray(static_cast<jsize>(utf8.size()));
  if (!bytes) return utf8;
  env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(utf8.size()),
                          reinterpret_cast<const jbyte*>(utf8.data()));
  jclass charsetClass = env->FindClass("java/nio/charset/StandardCharsets");
  jclass stringClass = env->FindClass("java/lang/String");
  if (!charsetClass || !stringClass) {
    env->DeleteLocalRef(bytes);
    return utf8;
  }
  jfieldID utf8Field =
      env->GetStaticFieldID(charsetClass, "UTF_8", "Ljava/nio/charset/Charset;");
  jmethodID ctor =
      env->GetMethodID(stringClass, "<init>", "([BLjava/nio/charset/Charset;)V");
  jmethodID toLower =
      env->GetMethodID(stringClass, "toLowerCase", "()Ljava/lang/String;");
  jmethodID getBytes =
      env->GetMethodID(stringClass, "getBytes", "(Ljava/nio/charset/Charset;)[B");
  if (!utf8Field || !ctor || !toLower || !getBytes) {
    env->DeleteLocalRef(bytes);
    return utf8;
  }
  jobject charset = env->GetStaticObjectField(charsetClass, utf8Field);
  jobject jstr = env->NewObject(stringClass, ctor, bytes, charset);
  env->DeleteLocalRef(bytes);
  if (!jstr) return utf8;
  jobject lower = env->CallObjectMethod(jstr, toLower);
  env->DeleteLocalRef(jstr);
  if (!lower) return utf8;
  auto lowerBytes =
      static_cast<jbyteArray>(env->CallObjectMethod(lower, getBytes, charset));
  env->DeleteLocalRef(lower);
  if (!lowerBytes) return utf8;
  const jsize n = env->GetArrayLength(lowerBytes);
  std::string out(static_cast<size_t>(n), '\0');
  if (n > 0) {
    env->GetByteArrayRegion(lowerBytes, 0, n, reinterpret_cast<jbyte*>(&out[0]));
  }
  env->DeleteLocalRef(lowerBytes);
  return out;
}

}  // namespace

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeAddPunctuationOfflineFromBuffer(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring textInBufferId,
    jstring textInputNormalization) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string bufferId = CopyRequiredJstring(env, textInBufferId);
  const std::string mode = CopyRequiredJstring(env, textInputNormalization);
  auto inst = LookupOffline(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Offline punctuation instance not found");
    return map;
  }

  TxtOfflineTextView view;
  std::string errCode;
  std::string errMsg;
  if (!txt_acquire_offline_text_view(bufferId, /*allowEmpty=*/false, &view, &errCode, &errMsg)) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          errMsg.empty() ? "Offline text buffer not found" : errMsg);
    return map;
  }

  std::string plain(view.data, view.bytes);
  if (mode != "none") {
    plain = JavaToLowercaseUtf8(env, plain);
  }
  const auto result = inst->addPunctuation(plain);
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "text", result.text);
  sherpaonnx::PutString(env, map, mapPut, "lang", view.lang ? view.lang : "");
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeHasOfflineInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  return LookupOffline(id) != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeUnloadOffline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::OfflinePunctuationWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_offline_mutex);
    auto it = g_offline.find(id);
    if (it != g_offline.end()) {
      removed = std::move(it->second);
      g_offline.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnloadOffline id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxPunctuationHelper_nativeShutdownAllOffline(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string,
                     std::shared_ptr<sherpaonnx::OfflinePunctuationWrapper>>
      all;
  {
    std::lock_guard<std::mutex> lock(g_offline_mutex);
    all.swap(g_offline);
  }
  for (auto& kv : all) {
    if (kv.second) kv.second->release();
  }
  LOGI("nativeShutdownAllOffline count=%zu", all.size());
}

// --- Online (SherpaOnnxOnlinePunctuationHelper) ---

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxOnlinePunctuationHelper_nativeInitializeOnline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring cnnPath,
    jstring bpePath, jint numThreads, jstring provider, jboolean debug) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string cnn = CopyRequiredJstring(env, cnnPath);
  const std::string bpe = CopyRequiredJstring(env, bpePath);
  const std::string prov = CopyRequiredJstring(env, provider);

  sherpaonnx::PunctuationInitializeResult result;
  {
    std::lock_guard<std::mutex> lock(g_online_mutex);
    g_online.erase(id);
    auto inst = std::make_shared<sherpaonnx::OnlinePunctuationWrapper>();
    result = inst->initialize(cnn, bpe, numThreads > 0 ? numThreads : 1,
                              prov.empty() ? "cpu" : prov, debug == JNI_TRUE);
    if (!result.success) {
      LOGE("nativeInitializeOnline failed id=%s: %s", id.c_str(),
           result.error.c_str());
    } else {
      g_online[id] = std::move(inst);
      LOGI("nativeInitializeOnline ok id=%s", id.c_str());
    }
  }

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxOnlinePunctuationHelper_nativeAddPunctuationOnline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId, jstring text) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  const std::string in = CopyRequiredJstring(env, text);
  auto inst = LookupOnline(id);

  jmethodID mapPut = nullptr;
  jobject map = NewHashMap(env, &mapPut);
  if (!map) return nullptr;

  if (!inst) {
    sherpaonnx::PutBoolean(env, map, mapPut, "success", false);
    sherpaonnx::PutString(env, map, mapPut, "error",
                          "Online punctuation instance not found");
    return map;
  }

  const auto result = inst->addPunctuation(in);
  sherpaonnx::PutBoolean(env, map, mapPut, "success", result.success);
  sherpaonnx::PutString(env, map, mapPut, "error", result.error);
  sherpaonnx::PutString(env, map, mapPut, "text", result.text);
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxOnlinePunctuationHelper_nativeHasOnlineInstance(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  return LookupOnline(id) != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxOnlinePunctuationHelper_nativeUnloadOnline(
    JNIEnv* env, jclass /* clazz */, jstring instanceId) {
  const std::string id = CopyRequiredJstring(env, instanceId);
  std::shared_ptr<sherpaonnx::OnlinePunctuationWrapper> removed;
  {
    std::lock_guard<std::mutex> lock(g_online_mutex);
    auto it = g_online.find(id);
    if (it != g_online.end()) {
      removed = std::move(it->second);
      g_online.erase(it);
    }
  }
  if (removed) {
    removed->release();
    LOGI("nativeUnloadOnline id=%s", id.c_str());
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_punctuation_facade_SherpaOnnxOnlinePunctuationHelper_nativeShutdownAllOnline(
    JNIEnv* /* env */, jclass /* clazz */) {
  std::unordered_map<std::string,
                     std::shared_ptr<sherpaonnx::OnlinePunctuationWrapper>>
      all;
  {
    std::lock_guard<std::mutex> lock(g_online_mutex);
    all.swap(g_online);
  }
  for (auto& kv : all) {
    if (kv.second) kv.second->release();
  }
  LOGI("nativeShutdownAllOnline count=%zu", all.size());
}

}  // extern "C"
