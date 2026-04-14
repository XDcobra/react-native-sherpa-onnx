cmake_minimum_required(VERSION 3.22.1)

project("sherpaonnx")

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ANDROID_ABI MUST be set by Gradle - it should never be empty
if(NOT ANDROID_ABI)
    message(FATAL_ERROR "ANDROID_ABI not set. This is a normal error.\n\n"
                        "How to fix:\n"
                        "  1. Use: cd example && yarn android\n"
                        "     (This runs Gradle which sets ANDROID_ABI)\n\n"
                        "  2. Or if building manually with CMake, specify:\n"
                        "     cmake -B build -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 ...\n\n"
                        "Supported ABIs: arm64-v8a, armeabi-v7a, x86, x86_64")
endif()

# Set Windows path length limit
if(WIN32)
    set(CMAKE_OBJECT_PATH_MAX 500)
endif()

# Calculate path relative to project root: android/src/main/cpp -> android -> project root
get_filename_component(PROJECT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)

find_package(ReactAndroid CONFIG QUIET)

# Optional: disable FFmpeg (gradle.properties: sherpaOnnxDisableFfmpeg=true). See docs/disable-ffmpeg.md.
set(USE_FFMPEG ON)
if(SHERPA_ONNX_DISABLE_FFMPEG)
    set(USE_FFMPEG OFF)
    message(STATUS "FFmpeg disabled (SHERPA_ONNX_DISABLE_FFMPEG=ON). convertAudioToWav16k/convertAudioToFormat and decode (non-WAV) will return an error at runtime.")
endif()

if(USE_FFMPEG)
# FFmpeg: libs and headers from (1) third_party/ffmpeg_prebuilt/android (local build) or (2) jniLibs + cpp/include/ffmpeg (GitHub release zip).
# PROJECT_ROOT = android/; repo root = PROJECT_ROOT/..
set(FFMPEG_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/ffmpeg_prebuilt/android")
set(FFMPEG_PREBUILT_LIB "${FFMPEG_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(FFMPEG_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(FFMPEG_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/ffmpeg")
# Require a real header — an empty third_party/.../include/ dir must not win over Gradle-populated cpp/include/ffmpeg.
if(EXISTS "${FFMPEG_PREBUILT_BASE}/include/libavcodec/avcodec.h")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_PREBUILT_BASE}/include")
    message(STATUS "FFmpeg headers: prebuilts ${FFMPEG_INCLUDE_DIR}")
elseif(EXISTS "${FFMPEG_INCLUDE_CPP}/libavcodec/avcodec.h")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_INCLUDE_CPP}")
    message(STATUS "FFmpeg headers: module tree ${FFMPEG_INCLUDE_DIR}")
else()
    message(FATAL_ERROR "FFmpeg headers missing. Either:\n"
                        "  - Build: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.sh (creates android/include)\n"
                        "  - Or use a release that includes include/ (Gradle extracts to ${FFMPEG_INCLUDE_CPP})")
endif()
# Prebuilts may be either legacy layout android/<abi>/lib/ (build_ffmpeg.sh) or
# android/jni/<abi>/ (same as Gradle THIRD_PARTY in docs/PREBUILT_RESOLUTION.md).
set(FFMPEG_PREBUILT_JNI_ABI "${FFMPEG_PREBUILT_BASE}/jni/${ANDROID_ABI}")
if(EXISTS "${FFMPEG_PREBUILT_LIB}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_PREBUILT_LIB}")
    message(STATUS "FFmpeg libs: prebuilts ${FFMPEG_LIB_DIR}")
elseif(EXISTS "${FFMPEG_PREBUILT_JNI_ABI}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_PREBUILT_JNI_ABI}")
    message(STATUS "FFmpeg libs: prebuilts (jni/<abi>) ${FFMPEG_LIB_DIR}")
elseif(EXISTS "${FFMPEG_JNILIBS}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_JNILIBS}")
    message(STATUS "FFmpeg libs: jniLibs ${FFMPEG_LIB_DIR}")
else()
    message(FATAL_ERROR "FFmpeg libs missing for ABI ${ANDROID_ABI}. Run a Gradle Android build so prebuilts populate jniLibs, or add local .so under jniLibs / ffmpeg prebuilts paths.")
endif()
endif(USE_FFMPEG)

# Optional: disable libarchive (gradle.properties: sherpaOnnxDisableLibarchive=true). See docs/disable-libarchive.md.
set(USE_LIBARCHIVE ON)
if(SHERPA_ONNX_DISABLE_LIBARCHIVE)
    set(USE_LIBARCHIVE OFF)
    message(STATUS "libarchive disabled (SHERPA_ONNX_DISABLE_LIBARCHIVE=ON). extractTarBz2/cancelExtractTarBz2 will return an error at runtime.")
endif()

# Source files by domain (see docs/NATIVE_NAMING_CONVENTION.md). model_detect: subdirs common/stt/tts/enhancement/alignment; flat #includes via multiple include paths below.
set(SOURCES
    alignment/sherpa_onnx_ctc_alignment.cpp
    alignment/sherpa_onnx_alignment_engine.cpp
    jni/alignment/sherpa-onnx-alignment-jni.cpp
    jni/module/sherpa-onnx-module-jni.cpp
    jni/archive/sherpa-onnx-archive-helper.cpp
    jni/archive/sherpa-onnx-archive-jni.cpp
    jni/model_detect/common/sherpa-onnx-model-detect-helper.cpp
    jni/model_detect/common/sherpa-onnx-detect-jni-common.cpp
    jni/model_detect/common/sherpa-onnx-catalog-metadata.cpp
    jni/model_detect/stt/sherpa-onnx-stt-catalog-metadata.cpp
    jni/model_detect/stt/sherpa-onnx-model-detect-stt.cpp
    jni/model_detect/stt/sherpa-onnx-validate-stt.cpp
    jni/model_detect/stt/sherpa-onnx-stt-wrapper.cpp
    jni/model_detect/tts/sherpa-onnx-tts-catalog-metadata.cpp
    jni/model_detect/tts/sherpa-onnx-model-detect-tts.cpp
    jni/model_detect/tts/sherpa-onnx-validate-tts.cpp
    jni/model_detect/tts/sherpa-onnx-tts-wrapper.cpp
    jni/model_detect/enhancement/sherpa-onnx-enhancement-catalog-metadata.cpp
    jni/model_detect/enhancement/sherpa-onnx-model-detect-enhancement.cpp
    jni/model_detect/enhancement/sherpa-onnx-validate-enhancement.cpp
    jni/model_detect/enhancement/sherpa-onnx-enhancement-wrapper.cpp
    jni/model_detect/alignment/sherpa-onnx-model-detect-alignment.cpp
    jni/model_detect/alignment/sherpa-onnx-validate-alignment.cpp
    jni/model_detect/alignment/sherpa-onnx-alignment-wrapper.cpp
    jni/audiobuffer/SherpaOnnxJSI.cpp
    jni/audiobuffer/SherpaOnnxJSIInstall.cpp
    jni/audio/sherpa-onnx-audio-convert-jni.cpp
    jni/audio/audio_convert_file.cpp
    jni/audio/audio_pcm_to_format.cpp
    jni/audio/audio_f32le_to_format.cpp
    crypto/sha256.cpp
)

if(USE_LIBARCHIVE)
# libarchive: (1) prebuilt from third_party/libarchive_prebuilt or jniLibs + cpp/include/libarchive (Maven/GitHub), or (2) build from source.
set(LIBARCHIVE_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/libarchive_prebuilt/android")
set(LIBARCHIVE_PREBUILT_LIB "${LIBARCHIVE_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LIBARCHIVE_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LIBARCHIVE_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/libarchive")
set(USE_LIBARCHIVE_PREBUILT OFF)
set(LIBARCHIVE_PREBUILT_JNI_ABI "${LIBARCHIVE_PREBUILT_BASE}/jni/${ANDROID_ABI}")
if(EXISTS "${LIBARCHIVE_PREBUILT_LIB}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_PREBUILT_LIB}")
    if(EXISTS "${LIBARCHIVE_PREBUILT_BASE}/include/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_PREBUILT_BASE}/include")
    elseif(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
elseif(EXISTS "${LIBARCHIVE_PREBUILT_JNI_ABI}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_PREBUILT_JNI_ABI}")
    if(EXISTS "${LIBARCHIVE_PREBUILT_BASE}/include/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_PREBUILT_BASE}/include")
    elseif(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
elseif(EXISTS "${LIBARCHIVE_JNILIBS}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_JNILIBS}")
    if(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
endif()
if(USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_INCLUDE_DIR)
    message(STATUS "libarchive: using prebuilt (libs: ${LIBARCHIVE_LIB_DIR}, include: ${LIBARCHIVE_INCLUDE_DIR})")
else()
    message(STATUS "Building libarchive from bundled source...")
    add_subdirectory(${PROJECT_ROOT}/../third_party/libarchive ${CMAKE_BINARY_DIR}/libarchive)
    message(STATUS "libarchive built successfully")
endif()
endif(USE_LIBARCHIVE)

# Create shared library
add_library(sherpaonnx SHARED
    ${SOURCES}
)

# sherpa-onnx C-API: link by directory + library name only (no IMPORTED target).
# The .so and headers land in jniLibs and cpp/include/sherpa-onnx via:
#   (1) local third_party build, (2) Maven AAR extraction (libs + c-api headers), or (3) GitHub release zip (last resort).
# If we used IMPORTED here, AGP would also copy .so from CMake --> duplicate in mergeNativeLibs.
set(SHERPA_ONNX_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/sherpa-onnx-prebuilt/android")
set(SHERPA_ONNX_ABI_LIB "${SHERPA_ONNX_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(SHERPA_ONNX_JNI_ABI "${SHERPA_ONNX_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(SHERPA_C_API_LIB_DIR "")
if(EXISTS "${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${SHERPA_ONNX_ABI_LIB}")
    message(STATUS "sherpa-onnx C-API (link only): ${SHERPA_C_API_LIB_DIR}")
elseif(EXISTS "${SHERPA_ONNX_JNI_ABI}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${SHERPA_ONNX_JNI_ABI}")
    message(STATUS "sherpa-onnx C-API (link only, third_party jni/<abi>): ${SHERPA_C_API_LIB_DIR}")
elseif(EXISTS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
    message(STATUS "sherpa-onnx C-API (link only, jniLibs): ${SHERPA_C_API_LIB_DIR}")
else()
    message(WARNING "sherpa-onnx C-API not found. Prebuilt sherpa native libs may be incomplete. "
                    "Build prebuilts: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh")
endif()

# ONNX Runtime C API headers for CTC alignment (same layout: <root>/onnxruntime/core/session/onnxruntime_c_api.h):
# (1) Monorepo third_party/onnxruntime/include (local dev / full ORT checkout)
# (2) android/src/main/cpp/include after Gradle copies headers/ or include/ from the onnxruntime AAR or third_party bundle
set(ORT_INCLUDE_MONO "${PROJECT_ROOT}/../third_party/onnxruntime/include")
set(ORT_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include")
if(EXISTS "${ORT_INCLUDE_MONO}/onnxruntime/core/session/onnxruntime_c_api.h")
    set(ORT_INCLUDE_DIR "${ORT_INCLUDE_MONO}")
    message(STATUS "ONNX Runtime C API headers (CTC alignment, monorepo): ${ORT_INCLUDE_DIR}")
elseif(EXISTS "${ORT_INCLUDE_CPP}/onnxruntime/core/session/onnxruntime_c_api.h")
    set(ORT_INCLUDE_DIR "${ORT_INCLUDE_CPP}")
    message(STATUS "ONNX Runtime C API headers (CTC alignment, AAR/cpp/include): ${ORT_INCLUDE_DIR}")
else()
    message(FATAL_ERROR "ONNX Runtime C API headers not found. Expected onnxruntime/core/session/onnxruntime_c_api.h under:\n"
                        "  - ${ORT_INCLUDE_MONO} (third_party/onnxruntime submodule), or\n"
                        "  - ${ORT_INCLUDE_CPP} (run Android Gradle so prebuilt-download copies headers from onnxruntime AAR).")
endif()

set(ORT_JNILIB_DIR "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
if(EXISTS "${ORT_JNILIB_DIR}/libonnxruntime.so")
    message(STATUS "Linking libonnxruntime for CTC alignment: ${ORT_JNILIB_DIR}")
else()
    message(FATAL_ERROR "libonnxruntime.so not found for ${ANDROID_ABI} at ${ORT_JNILIB_DIR}. "
                        "Gradle should populate jniLibs from the onnxruntime bundle.")
endif()

target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/alignment
    ${ORT_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/module
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/archive
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/common
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/stt
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/tts
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/enhancement
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/alignment
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/audio
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
if(USE_FFMPEG)
    target_include_directories(sherpaonnx PRIVATE ${FFMPEG_INCLUDE_DIR})
endif()
if(USE_LIBARCHIVE AND USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${LIBARCHIVE_INCLUDE_DIR})
endif()
# When USE_FFMPEG=OFF, do NOT define HAVE_FFMPEG at all. Then #ifdef HAVE_FFMPEG is false
# in C++ and the stub (#else) branches are used — no FFmpeg headers needed.
if(USE_FFMPEG)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_FFMPEG=1)
endif()
# When USE_LIBARCHIVE=OFF, do NOT define HAVE_LIBARCHIVE; extractTarBz2 stubs return an error.
if(USE_LIBARCHIVE)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_LIBARCHIVE=1)
endif()

# Link libraries (Kotlin API from AAR handles STT/TTS incl. Zipvoice)
if(USE_FFMPEG)
    target_link_directories(sherpaonnx PRIVATE ${FFMPEG_LIB_DIR})
endif()
if(USE_LIBARCHIVE AND USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LIBARCHIVE_LIB_DIR})
endif()
if(SHERPA_C_API_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${SHERPA_C_API_LIB_DIR})
    target_link_libraries(sherpaonnx PRIVATE sherpa-onnx-c-api)
endif()
target_link_directories(sherpaonnx PRIVATE ${ORT_JNILIB_DIR})
target_link_libraries(sherpaonnx PRIVATE onnxruntime)
if(TARGET ReactAndroid::jsi)
    target_link_libraries(sherpaonnx PRIVATE ReactAndroid::jsi)
elseif(TARGET jsi)
    target_link_libraries(sherpaonnx PRIVATE jsi)
else()
    message(WARNING "JSI target not found (ReactAndroid::jsi/jsi). Building without explicit JSI linkage.")
endif()
# Link archive only when USE_LIBARCHIVE (otherwise libsherpaonnx.so would depend on libarchive.so at load time).
if(USE_FFMPEG)
    target_link_libraries(sherpaonnx
        PRIVATE
        avcodec
        avformat
        avutil
        avfilter
        swresample
    )
endif()
if(USE_LIBARCHIVE)
    target_link_libraries(sherpaonnx PRIVATE archive)
endif()
target_link_libraries(sherpaonnx PRIVATE log android)

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
