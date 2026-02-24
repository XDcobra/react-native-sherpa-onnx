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

# FFmpeg: libs and headers from (1) third_party/ffmpeg_prebuilt/android (local build) or (2) jniLibs + cpp/include/ffmpeg (release zip).
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

# Source files (Archive, FFmpeg, model detection, Zipvoice C-API JNI; STT/TTS use Kotlin API)
set(SOURCES
    jni/sherpa-onnx-module-jni.cpp
    jni/sherpa-onnx-archive-jni.cpp
    jni/sherpa-onnx-audio-convert-jni.cpp
    jni/sherpa-onnx-model-detect-helper.cpp
    jni/sherpa-onnx-model-detect-stt.cpp
    jni/sherpa-onnx-model-detect-tts.cpp
    jni/sherpa-onnx-tts-zipvoice-jni.cpp
    jni/sherpa-onnx-archive-helper.cpp
    crypto/sha256.cpp
)

# Build libarchive from bundled source (shared by Android and iOS)
# PROJECT_ROOT is android/; third_party is at repo root (one level above PROJECT_ROOT)
message(STATUS "Building libarchive from bundled source...")
add_subdirectory(${PROJECT_ROOT}/../third_party/libarchive ${CMAKE_BINARY_DIR}/libarchive)
message(STATUS "libarchive built successfully")

# Create shared library
add_library(sherpaonnx SHARED
    ${SOURCES}
)

# sherpa-onnx C-API shared library (from prebuilts or jniLibs). Used by Zipvoice TTS JNI wrapper.
set(SHERPA_ONNX_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/sherpa-onnx-prebuilt/android")
set(SHERPA_ONNX_ABI_LIB "${SHERPA_ONNX_PREBUILT_BASE}/${ANDROID_ABI}/lib")
if(EXISTS "${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so")
    add_library(sherpa-onnx-c-api SHARED IMPORTED)
    set_target_properties(sherpa-onnx-c-api PROPERTIES
        IMPORTED_LOCATION "${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so"
    )
    message(STATUS "sherpa-onnx C-API found: ${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so")
else()
    set(JNILIBS_C_API "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}/libsherpa-onnx-c-api.so")
    if(EXISTS "${JNILIBS_C_API}")
        add_library(sherpa-onnx-c-api SHARED IMPORTED)
        set_target_properties(sherpa-onnx-c-api PROPERTIES
            IMPORTED_LOCATION "${JNILIBS_C_API}"
        )
        message(STATUS "sherpa-onnx C-API found (jniLibs): ${JNILIBS_C_API}")
    else()
        message(WARNING "sherpa-onnx C-API not found. Zipvoice TTS will not be available. "
                        "Build prebuilts: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh")
    endif()
endif()

# Include directories (must be after add_library)
target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${FFMPEG_INCLUDE_DIR}
)
target_compile_definitions(sherpaonnx PRIVATE HAVE_FFMPEG=1)

# Link libraries (Kotlin API from AAR handles STT/TTS; C-API only for Zipvoice)
target_link_libraries(sherpaonnx
    archive
    avcodec
    avformat
    avutil
    avfilter
    swresample
    log
    android
    $<TARGET_NAME_IF_EXISTS:sherpa-onnx-c-api>
)
target_link_directories(sherpaonnx PRIVATE ${FFMPEG_LIB_DIR})

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
