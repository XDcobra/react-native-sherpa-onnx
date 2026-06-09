/**
 * sherpa-onnx-unified-detect-wrapper.cpp
 *
 * Converts UnifiedModelDetectResult to Java HashMap for native unified detect JNI.
 */
#include "sherpa-onnx-unified-detect-wrapper.h"

#include "sherpa-onnx-detect-jni-common.h"

namespace sherpaonnx {

jobject UnifiedDetectResultToJava(JNIEnv* env, const UnifiedModelDetectResult& result) {
    jclass mapClass = env->FindClass("java/util/HashMap");
    if (!mapClass) return nullptr;
    jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "()V");
    jmethodID mapPut = env->GetMethodID(
        mapClass,
        "put",
        "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    if (!mapInit || !mapPut) {
        env->DeleteLocalRef(mapClass);
        return nullptr;
    }
    jobject map = env->NewObject(mapClass, mapInit);
    env->DeleteLocalRef(mapClass);
    if (!map) return nullptr;

    PutBoolean(env, map, mapPut, "matched", result.matched);
    PutBoolean(env, map, mapPut, "success", result.success);
    PutBoolean(env, map, mapPut, "isStreaming", result.isStreaming);
    PutBoolean(
        env,
        map,
        mapPut,
        "isHardwareSpecificUnsupported",
        result.isHardwareSpecificUnsupported);

    if (!result.category.empty()) {
        PutString(env, map, mapPut, "category", result.category);
    }
    if (!result.modelType.empty()) {
        PutString(env, map, mapPut, "modelType", result.modelType);
    }
    if (!result.error.empty()) {
        PutString(env, map, mapPut, "error", result.error);
    }
    if (!result.quantization.empty()) {
        PutString(env, map, mapPut, "quantization", result.quantization);
    }
    if (!result.sizeTier.empty()) {
        PutString(env, map, mapPut, "sizeTier", result.sizeTier);
    }

    jobject detectedList = BuildDetectedModelsList(env, result.detectedModels);
    if (detectedList) {
        jstring keyDetected = env->NewStringUTF("detectedModels");
        env->CallObjectMethod(map, mapPut, keyDetected, detectedList);
        env->DeleteLocalRef(keyDetected);
        env->DeleteLocalRef(detectedList);
    }

    jobject languagesList = BuildPublicLanguageRowList(env, result.languages);
    if (languagesList) {
        jstring keyLang = env->NewStringUTF("languages");
        env->CallObjectMethod(map, mapPut, keyLang, languagesList);
        env->DeleteLocalRef(keyLang);
        env->DeleteLocalRef(languagesList);
    }

    jobject detectionSourcesList = BuildStringList(env, result.detectionSources);
    if (detectionSourcesList) {
        jstring keySources = env->NewStringUTF("detectionSources");
        env->CallObjectMethod(map, mapPut, keySources, detectionSourcesList);
        env->DeleteLocalRef(keySources);
        env->DeleteLocalRef(detectionSourcesList);
    }

    jobject pathsMap = BuildStringStringMap(env, result.paths);
    if (pathsMap) {
        jstring keyPaths = env->NewStringUTF("paths");
        env->CallObjectMethod(map, mapPut, keyPaths, pathsMap);
        env->DeleteLocalRef(keyPaths);
        env->DeleteLocalRef(pathsMap);
    }

    return map;
}

}  // namespace sherpaonnx
