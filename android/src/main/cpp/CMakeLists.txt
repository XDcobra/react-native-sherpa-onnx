cmake_minimum_required(VERSION 3.22.1)

project("sherpaonnx")

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Android specific settings
set(CMAKE_ANDROID_ARCH_ABI ${ANDROID_ABI})
set(CMAKE_SYSTEM_NAME Android)
set(CMAKE_SYSTEM_VERSION ${ANDROID_PLATFORM_LEVEL})

# Set Windows path length limit
if(WIN32)
    set(CMAKE_OBJECT_PATH_MAX 500)
endif()

# Calculate path relative to project root: android/src/main/cpp -> android -> project root
get_filename_component(PROJECT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)

# Fixed location where Gradle extracts native libraries
set(EXTRACTED_LIBS_DIR "${PROJECT_ROOT}/build/extracted_native_libs/jni/${ANDROID_ABI}")

# Try to find library directly by path (most reliable)
set(SHERPA_ONNX_LIB_CXX "${EXTRACTED_LIBS_DIR}/libsherpa-onnx-cxx-api.so")
set(SHERPA_ONNX_LIB_C "${EXTRACTED_LIBS_DIR}/libsherpa-onnx-c-api.so")

if(EXISTS "${SHERPA_ONNX_LIB_CXX}")
    set(SHERPA_ONNX_LIB "${SHERPA_ONNX_LIB_CXX}")
    message(STATUS "Found sherpa-onnx library (cxx-api): ${SHERPA_ONNX_LIB}")
elseif(EXISTS "${SHERPA_ONNX_LIB_C}")
    set(SHERPA_ONNX_LIB "${SHERPA_ONNX_LIB_C}")
    message(STATUS "Found sherpa-onnx library (c-api): ${SHERPA_ONNX_LIB}")
else()
    # Fallback: use find_library
    find_library(SHERPA_ONNX_LIB
        NAMES sherpa-onnx-cxx-api libsherpa-onnx-cxx-api sherpa-onnx-c-api libsherpa-onnx-c-api
        PATHS ${EXTRACTED_LIBS_DIR}
        NO_DEFAULT_PATH
    )
    
    if(NOT SHERPA_ONNX_LIB)
        message(FATAL_ERROR "sherpa-onnx library not found in ${EXTRACTED_LIBS_DIR}\n"
                            "Expected files:\n"
                            "  - ${SHERPA_ONNX_LIB_CXX}\n"
                            "  - ${SHERPA_ONNX_LIB_C}\n"
                            "Please ensure extractNativeLibs task ran successfully.")
    endif()
endif()

# Source files
set(SOURCES
    jni/sherpa-onnx-stt-jni.cpp
    jni/sherpa-onnx-tts-jni.cpp
    jni/sherpa-onnx-model-detect-helper.cpp
    jni/sherpa-onnx-model-detect-stt.cpp
    jni/sherpa-onnx-model-detect-tts.cpp
    jni/sherpa-onnx-stt-wrapper.cpp
    jni/sherpa-onnx-tts-wrapper.cpp
)

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

# Also link onnxruntime (required dependency)
set(ONNXRUNTIME_LIB "${EXTRACTED_LIBS_DIR}/libonnxruntime.so")

# Link libraries
target_link_libraries(sherpaonnx
    ${SHERPA_ONNX_LIB}
    ${ONNXRUNTIME_LIB}
    log
    android
)

# Compiler flags
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
)
