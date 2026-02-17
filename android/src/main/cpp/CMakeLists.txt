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

# FFmpeg prebuilts (required). third_party/ffmpeg_prebuilt/android from repo root.
# PROJECT_ROOT = android/; repo root = PROJECT_ROOT/..
set(FFMPEG_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/ffmpeg_prebuilt/android")
set(FFMPEG_ABI_LIB "${FFMPEG_PREBUILT_BASE}/${ANDROID_ABI}/lib")
if(NOT EXISTS "${FFMPEG_PREBUILT_BASE}/include")
    message(FATAL_ERROR "FFmpeg prebuilts missing: ${FFMPEG_PREBUILT_BASE}/include not found.\n"
                        "Build them with: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.ps1 (Windows) or ./build_ffmpeg.sh (Linux/macOS)")
endif()
if(NOT EXISTS "${FFMPEG_ABI_LIB}")
    message(FATAL_ERROR "FFmpeg prebuilts missing for ABI ${ANDROID_ABI}: ${FFMPEG_ABI_LIB} not found.\n"
                        "Build for all ABIs with: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.ps1 or ./build_ffmpeg.sh")
endif()
message(STATUS "FFmpeg prebuilts found: ${FFMPEG_PREBUILT_BASE}")

# Source files (Archive, FFmpeg, model detection only; STT/TTS use Kotlin API)
set(SOURCES
    jni/sherpa-onnx-module-jni.cpp
    jni/sherpa-onnx-archive-jni.cpp
    jni/sherpa-onnx-audio-convert-jni.cpp
    jni/sherpa-onnx-model-detect-helper.cpp
    jni/sherpa-onnx-model-detect-stt.cpp
    jni/sherpa-onnx-model-detect-tts.cpp
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

# Include directories (must be after add_library); no sherpa-onnx headers (STT/TTS use Kotlin API)
target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${FFMPEG_PREBUILT_BASE}/include
)
target_compile_definitions(sherpaonnx PRIVATE HAVE_FFMPEG=1)

# Link libraries (no sherpa-onnx/onnxruntime; STT/TTS use Kotlin API from AAR)
target_link_libraries(sherpaonnx
    archive
    avcodec
    avformat
    avutil
    avfilter
    swresample
    log
    android
)
target_link_directories(sherpaonnx PRIVATE ${FFMPEG_ABI_LIB})

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
