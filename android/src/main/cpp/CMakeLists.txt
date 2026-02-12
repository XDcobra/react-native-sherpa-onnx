cmake_minimum_required(VERSION 3.22.1)

project("sherpaonnx")

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)



# Android specific settings
set(CMAKE_ANDROID_ARCH_ABI ${ANDROID_ABI})
set(CMAKE_SYSTEM_NAME Android)
set(CMAKE_SYSTEM_VERSION ${ANDROID_PLATFORM_LEVEL})

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

# Fixed location where Gradle extracts native libraries (populated by extractNativeLibs Gradle task)
# Use cmake_path for robust path handling (no double slashes)
set(EXTRACTED_LIBS_BASE "${PROJECT_ROOT}/build/extracted_native_libs/jni")
set(EXTRACTED_LIBS_DIR "${EXTRACTED_LIBS_BASE}/${ANDROID_ABI}")

# LAZY BINDING: Don't validate file existence at configure time
# This allows Gradle's extractNativeLibs task to run in parallel with CMake
# The libraries will be validated at link time instead

# Possible library paths with priority order
set(SHERPA_ONNX_LIB_PATHS
    "${EXTRACTED_LIBS_DIR}/libsherpa-onnx-cxx-api.so"
    "${EXTRACTED_LIBS_DIR}/libsherpa-onnx-c-api.so"
)

message(STATUS "Looking for sherpa-onnx libraries in: ${EXTRACTED_LIBS_DIR}")
message(STATUS "Note: Library extraction happens during Gradle build, validation is deferred to link time")

# Try to find library (will be validated at link time)
set(SHERPA_ONNX_LIB "")
foreach(lib_path ${SHERPA_ONNX_LIB_PATHS})
    if(NOT SHERPA_ONNX_LIB)
        get_filename_component(lib_name "${lib_path}" NAME_WE)
        # Strip leading "lib" to avoid find_library() searching for "liblib*.so"
        string(REGEX REPLACE "^lib" "" lib_name_without_prefix "${lib_name}")
        unset(found_lib CACHE)
        find_library(found_lib
            NAMES ${lib_name_without_prefix}
            PATHS "${EXTRACTED_LIBS_DIR}"
            NO_DEFAULT_PATH
        )
        if(found_lib)
            set(SHERPA_ONNX_LIB "${found_lib}")
            message(STATUS "Found sherpa-onnx library: ${SHERPA_ONNX_LIB}")
            break()
        endif()
        unset(found_lib CACHE)
    endif()
endforeach()

# If library not found by find_library, use lazy binding (trust it will be available at link time)
if(NOT SHERPA_ONNX_LIB)
    message(WARNING "sherpa-onnx library not found at CMake configure time")
    message(WARNING "This is normal for Gradle builds where extractNativeLibs runs in parallel")
    message(WARNING "Library must be available at link time in: ${EXTRACTED_LIBS_DIR}")
    # Use the expected CXX path as fallback - CMake will validate at link time
    set(SHERPA_ONNX_LIB "${EXTRACTED_LIBS_DIR}/libsherpa-onnx-cxx-api.so")
    message(STATUS "Using fallback library path (will be validated at link time): ${SHERPA_ONNX_LIB}")
endif()

# Source files
set(SOURCES
    jni/sherpa-onnx-stt-jni.cpp
    jni/sherpa-onnx-tts-jni.cpp
    jni/sherpa-onnx-archive-jni.cpp
    jni/sherpa-onnx-model-detect-helper.cpp
    jni/sherpa-onnx-model-detect-stt.cpp
    jni/sherpa-onnx-model-detect-tts.cpp
    jni/sherpa-onnx-stt-wrapper.cpp
    jni/sherpa-onnx-tts-wrapper.cpp
    jni/sherpa-onnx-archive-helper.cpp
    crypto/sha256.cpp
)

# Build libarchive from bundled source
# This is the robustest solution: no downloads, no extraction issues, deterministic builds
message(STATUS "Building libarchive from bundled source...")
add_subdirectory(libarchive)
message(STATUS "libarchive built successfully")

# Create shared library
add_library(sherpaonnx SHARED
    ${SOURCES}
)

# Try to find sherpa-onnx headers
# Priority order:
# 1. Local include directory (bundled in npm package) - preferred for published packages
# 2. Git submodule (for local development)
# The headers use "sherpa-onnx/c-api/..." includes, so we need to add
# the directory that contains "sherpa-onnx" as a subdirectory
set(SHERPA_ONNX_INCLUDE_DIRS "")
set(POSSIBLE_BASE_PATHS
    "${CMAKE_CURRENT_SOURCE_DIR}/include"  # Bundled headers in npm package
    "${PROJECT_ROOT}/android/src/main/cpp/include"  # Alternative path for bundled headers
    "${PROJECT_ROOT}/sherpa-onnx"  # Git submodule (for local development)
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../../sherpa-onnx"  # Alternative submodule path
)

set(HEADER_SOURCE_TYPE "")
foreach(BASE_PATH ${POSSIBLE_BASE_PATHS})
    if(EXISTS "${BASE_PATH}/sherpa-onnx/c-api/cxx-api.h")
        list(APPEND SHERPA_ONNX_INCLUDE_DIRS "${BASE_PATH}")
        
        # Determine header source type for logging
        if("${BASE_PATH}" MATCHES "include")
            set(HEADER_SOURCE_TYPE "bundled (npm package)")
        else()
            set(HEADER_SOURCE_TYPE "git submodule")
        endif()
        
        message(STATUS "Found sherpa-onnx headers from ${HEADER_SOURCE_TYPE} at: ${BASE_PATH}")
        # Also output as regular message to ensure visibility in Gradle logs
        message("-- Using sherpa-onnx headers from: ${HEADER_SOURCE_TYPE}")
        break()  # Found it, no need to check other paths
    endif()
endforeach()

if(SHERPA_ONNX_INCLUDE_DIRS STREQUAL "")
    message(FATAL_ERROR "sherpa-onnx headers not found.\n"
                        "Please ensure:\n"
                        "  1. Headers are copied by running: yarn copy-headers\n"
                        "  2. Or git submodule is initialized: git submodule update --init --recursive")
endif()

# Include directories (must be after add_library)
target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${SHERPA_ONNX_INCLUDE_DIRS}
)

# Also link onnxruntime (required dependency) - lazy binding for Gradle parallel extraction
set(ONNXRUNTIME_LIB "${EXTRACTED_LIBS_DIR}/libonnxruntime.so")
message(STATUS "Using onnxruntime from: ${ONNXRUNTIME_LIB}")

# Link libraries
target_link_libraries(sherpaonnx
    ${SHERPA_ONNX_LIB}
    ${ONNXRUNTIME_LIB}
    archive
    log
    android
)

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
