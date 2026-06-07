#ifndef SHERPA_ONNX_DETECT_JNI_COMMON_H
#define SHERPA_ONNX_DETECT_JNI_COMMON_H

#include <jni.h>
#include <string>
#include <vector>

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-validate-custom-types.h"

#include <map>

namespace sherpaonnx {

// Helpers for building Java HashMap/ArrayList from C++ detect results.
// Used by sherpa-onnx-stt-wrapper and sherpa-onnx-tts-wrapper.
bool PutString(JNIEnv* env, jobject map, jmethodID putId, const char* key, const std::string& value);
bool PutBoolean(JNIEnv* env, jobject map, jmethodID putId, const char* key, bool value);
jobject BuildDetectedModelsList(JNIEnv* env, const std::vector<DetectedModel>& models);
/** Build a Java ArrayList<String> from a vector of strings. Returns null on failure. */
jobject BuildStringList(JNIEnv* env, const std::vector<std::string>& strings);
/** Build a Java HashMap<String,String> from a C++ string map (skips empty values). */
jobject BuildStringStringMap(
    JNIEnv* env,
    const std::map<std::string, std::string>& strings);
/** Build ArrayList<HashMap> with {id, path} for lexicon languages. Returns null on failure. */
jobject BuildLexiconLanguagesList(
    JNIEnv* env,
    const std::vector<model_detect::LexiconCandidate>& languages);

/** Read a Java HashMap<String,String> into a C++ string map (skips null/empty values). */
std::map<std::string, std::string> JavaHashMapToStringMap(JNIEnv* env, jobject map);

jobject BuildCustomValidationResultMap(
    JNIEnv* env,
    const CustomModelValidationResult& result
);

jobject BuildCustomPathRequirementsMap(
    JNIEnv* env,
    const CustomModelPathRequirements& requirements
);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_DETECT_JNI_COMMON_H
