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

# FFmpeg: libs and headers from (1) third_party/ffmpeg_prebuilt/android (local build) or (2) jniLibs + cpp/include/ffmpeg (GitHub release zip).
# PROJECT_ROOT = android/; repo root = PROJECT_ROOT/..
set(FFMPEG_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/ffmpeg_prebuilt/android")
set(FFMPEG_PREBUILT_LIB "${FFMPEG_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(FFMPEG_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(FFMPEG_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/ffmpeg")
if(EXISTS "${FFMPEG_PREBUILT_BASE}/include")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_PREBUILT_BASE}/include")
    message(STATUS "FFmpeg headers: prebuilts ${FFMPEG_INCLUDE_DIR}")
elseif(EXISTS "${FFMPEG_INCLUDE_CPP}")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_INCLUDE_CPP}")
    message(STATUS "FFmpeg headers: jniLibs/release ${FFMPEG_INCLUDE_DIR}")
else()
    message(FATAL_ERROR "FFmpeg headers missing. Either:\n"
                        "  - Build: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.sh (creates android/include)\n"
                        "  - Or use a release that includes include/ (Gradle extracts to ${FFMPEG_INCLUDE_CPP})")
endif()
if(EXISTS "${FFMPEG_PREBUILT_LIB}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_PREBUILT_LIB}")
    message(STATUS "FFmpeg libs: prebuilts ${FFMPEG_LIB_DIR}")
elseif(EXISTS "${FFMPEG_JNILIBS}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_JNILIBS}")
    message(STATUS "FFmpeg libs: jniLibs ${FFMPEG_LIB_DIR}")
else()
    message(FATAL_ERROR "FFmpeg libs missing for ABI ${ANDROID_ABI}. Run third_party/ffmpeg_prebuilt/copy_prebuilts_to_sdk.js or ensure ANDROID_RELEASE_TAG release is downloaded.")
endif()

# Source files by domain (see docs/NATIVE_NAMING_CONVENTION.md). Move .cpp into subdirs; .h go alongside for include path.
set(SOURCES
    jni/module/sherpa-onnx-module-jni.cpp
    jni/archive/sherpa-onnx-archive-helper.cpp
    jni/archive/sherpa-onnx-archive-jni.cpp
    jni/model_detect/sherpa-onnx-model-detect-helper.cpp
    jni/model_detect/sherpa-onnx-model-detect-stt.cpp
    jni/model_detect/sherpa-onnx-model-detect-tts.cpp
    jni/model_detect/sherpa-onnx-detect-jni-common.cpp
    jni/model_detect/sherpa-onnx-stt-wrapper.cpp
    jni/model_detect/sherpa-onnx-tts-wrapper.cpp
    jni/audio/sherpa-onnx-audio-convert-jni.cpp
    jni/tts/sherpa-onnx-tts-zipvoice-jni.cpp
    crypto/sha256.cpp
)

# libarchive: (1) prebuilt from third_party/libarchive_prebuilt or jniLibs + cpp/include/libarchive (Maven/GitHub), or (2) build from source.
set(LIBARCHIVE_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/libarchive_prebuilt/android")
set(LIBARCHIVE_PREBUILT_LIB "${LIBARCHIVE_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LIBARCHIVE_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LIBARCHIVE_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/libarchive")
set(USE_LIBARCHIVE_PREBUILT OFF)
if(EXISTS "${LIBARCHIVE_PREBUILT_LIB}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_PREBUILT_LIB}")
    if(EXISTS "${LIBARCHIVE_PREBUILT_BASE}/include")
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

# Create shared library
add_library(sherpaonnx SHARED
    ${SOURCES}
)

# sherpa-onnx C-API: link by directory + library name only (no IMPORTED target).
# The .so and headers land in jniLibs and cpp/include/sherpa-onnx via:
#   (1) local third_party build, (2) Maven AAR extraction (libs + c-api headers), or (3) GitHub release zip (last resort).
# If we used IMPORTED here, AGP would also copy .so from CMake → duplicate in mergeNativeLibs.
set(SHERPA_ONNX_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/sherpa-onnx-prebuilt/android")
set(SHERPA_ONNX_ABI_LIB "${SHERPA_ONNX_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(SHERPA_C_API_LIB_DIR "")
if(EXISTS "${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${SHERPA_ONNX_ABI_LIB}")
    message(STATUS "sherpa-onnx C-API (link only): ${SHERPA_C_API_LIB_DIR}")
elseif(EXISTS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
    message(STATUS "sherpa-onnx C-API (link only, jniLibs): ${SHERPA_C_API_LIB_DIR}")
else()
    message(WARNING "sherpa-onnx C-API not found. Zipvoice TTS will not be available. "
                    "Build prebuilts: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh")
endif()

# Include directories (must be after add_library). Subdirs so #include "sherpa-onnx-*.h" resolves after move.
target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/module
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/archive
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/audio
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/tts
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${FFMPEG_INCLUDE_DIR}
)
if(USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${LIBARCHIVE_INCLUDE_DIR})
endif()
target_compile_definitions(sherpaonnx PRIVATE HAVE_FFMPEG=1)

# Link libraries (Kotlin API from AAR handles STT/TTS; C-API only for Zipvoice)
target_link_directories(sherpaonnx PRIVATE ${FFMPEG_LIB_DIR})
if(USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LIBARCHIVE_LIB_DIR})
endif()
if(SHERPA_C_API_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${SHERPA_C_API_LIB_DIR})
    target_link_libraries(sherpaonnx PRIVATE sherpa-onnx-c-api)
endif()
target_link_libraries(sherpaonnx
    PRIVATE
    archive
    avcodec
    avformat
    avutil
    avfilter
    swresample
    log
    android
)

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
