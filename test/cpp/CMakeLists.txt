# Host-side C++ tests (Linux/macOS CI): no Android NDK.
# Layout: model_detect/ — host tests; production sources under android/.../jni/model_detect/{common,stt,tts,enhancement,vad}/; audio_conversion/ — FFmpeg (same sources as Android).
cmake_minimum_required(VERSION 3.16)
project(sherpa-onnx-host-cpp-tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)

set(MODEL_DETECT_TEST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/model_detect")
set(AUDIO_CONVERSION_TEST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/audio_conversion")

# Production sources (same logic as Android; no __ANDROID__ so LOGI/LOGE are no-ops)
set(MODEL_DETECT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni/model_detect")
set(JNI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni")

set(PRODUCTION_SOURCES
  "${MODEL_DETECT_DIR}/common/sherpa-onnx-model-detect-helper.cpp"
  "${MODEL_DETECT_DIR}/common/sherpa-onnx-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/common/sherpa-onnx-ort-guard-utils.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-stt-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-model-detect-stt.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-stt-online-guard.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-stt-online-guard-transducer.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-stt-online-guard-paraformer.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-stt-online-guard-ctc.cpp"
  "${MODEL_DETECT_DIR}/tts/sherpa-onnx-tts-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/tts/sherpa-onnx-model-detect-tts.cpp"
  "${MODEL_DETECT_DIR}/enhancement/sherpa-onnx-enhancement-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/enhancement/sherpa-onnx-enhancement-online-guard.cpp"
  "${MODEL_DETECT_DIR}/enhancement/sherpa-onnx-model-detect-enhancement.cpp"
  "${MODEL_DETECT_DIR}/punctuation/sherpa-onnx-punctuation-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/punctuation/sherpa-onnx-punctuation-online-guard.cpp"
  "${MODEL_DETECT_DIR}/punctuation/sherpa-onnx-model-detect-punctuation.cpp"
  "${MODEL_DETECT_DIR}/punctuation/sherpa-onnx-validate-punctuation.cpp"
  "${MODEL_DETECT_DIR}/vad/sherpa-onnx-vad-catalog-metadata.cpp"
  "${MODEL_DETECT_DIR}/vad/sherpa-onnx-model-detect-vad.cpp"
  "${MODEL_DETECT_DIR}/stt/sherpa-onnx-validate-stt.cpp"
  "${MODEL_DETECT_DIR}/tts/sherpa-onnx-validate-tts.cpp"
  "${MODEL_DETECT_DIR}/enhancement/sherpa-onnx-validate-enhancement.cpp"
  "${MODEL_DETECT_DIR}/vad/sherpa-onnx-validate-vad.cpp"
)

add_executable(model_detect_test
  "${MODEL_DETECT_TEST_DIR}/model_detect_test.cpp"
  "${MODEL_DETECT_TEST_DIR}/model_detect_test_utils.cpp"
  "${MODEL_DETECT_TEST_DIR}/tts_catalog_hints_test.cpp"
)

target_sources(model_detect_test PRIVATE ${PRODUCTION_SOURCES})

target_include_directories(model_detect_test PRIVATE
  "${MODEL_DETECT_DIR}/common"
  "${MODEL_DETECT_DIR}/stt"
  "${MODEL_DETECT_DIR}/tts"
  "${MODEL_DETECT_DIR}/enhancement"
  "${MODEL_DETECT_DIR}/punctuation"
  "${MODEL_DETECT_DIR}/vad"
  "${MODEL_DETECT_DIR}/alignment"
  "${JNI_DIR}"
  "${MODEL_DETECT_TEST_DIR}"
)

find_package(GTest QUIET)
if(GTest_FOUND)
  target_link_libraries(model_detect_test PRIVATE GTest::gtest GTest::gtest_main)
else()
  include(FetchContent)
  FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.14.0
  )
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
  target_link_libraries(model_detect_test PRIVATE gtest gtest_main)
  target_include_directories(model_detect_test PRIVATE ${gtest_SOURCE_DIR}/include ${gtest_SOURCE_DIR})
endif()

# --- Host audio tests (same android/src/.../jni/audio/*.cpp as Android; Linux + system libav) ---
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
  pkg_check_modules(LIBAV IMPORTED_TARGET libavcodec libavformat libavutil libswresample)
endif()

if(TARGET PkgConfig::LIBAV)
  set(AUDIO_JNI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni/audio")
  if(GTest_FOUND)
    set(AUDIO_GTEST_LIBS GTest::gtest GTest::gtest_main)
  else()
    set(AUDIO_GTEST_LIBS gtest gtest_main)
  endif()

  add_executable(audio_f32le_to_format_host_test "${AUDIO_CONVERSION_TEST_DIR}/audio_f32le_host_test.cpp")
  target_include_directories(audio_f32le_to_format_host_test PRIVATE "${AUDIO_CONVERSION_TEST_DIR}")
  target_compile_definitions(audio_f32le_to_format_host_test PRIVATE HAVE_FFMPEG=1)
  target_link_libraries(audio_f32le_to_format_host_test PRIVATE PkgConfig::LIBAV ${AUDIO_GTEST_LIBS})
else()
  message(STATUS "libav not found via pkg-config; skipping audio host tests (install libavcodec-dev libavformat-dev libavutil-dev libswresample-dev)")
endif()

# Run from repo root so "test/fixtures" resolves; or set env TEST_FIXTURES_DIR

include(CTest)
enable_testing()
add_test(NAME model_detect_test COMMAND $<TARGET_FILE:model_detect_test>)
set_tests_properties(model_detect_test PROPERTIES
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
)

if(TARGET audio_f32le_to_format_host_test)
  add_test(NAME audio_f32le_to_format_host_test COMMAND $<TARGET_FILE:audio_f32le_to_format_host_test>)
  set_tests_properties(audio_f32le_to_format_host_test PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
  )
endif()

# --- CTC alignment + ORT smoke (downloads ONNX Runtime host build for Linux/macOS) ---
# Default ORT semver: third_party/onnxruntime_prebuilt/VERSIONS (ONNXRUNTIME_VERSION) — same pin as Android QNN prebuilts.
# Official Microsoft release zips use v${VER}/onnxruntime-{platform}-${VER}.tgz; override with -DSHERPA_ONNX_HOST_ORT_VERSION= or SHERPA_ONNX_HOST_ORT_ROOT=.
set(_SHERPA_ORT_VERSIONS_FILE "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/onnxruntime_prebuilt/VERSIONS")
set(_SHERPA_ORT_VER_FROM_VERSIONS "")
if(EXISTS "${_SHERPA_ORT_VERSIONS_FILE}")
  file(STRINGS "${_SHERPA_ORT_VERSIONS_FILE}" _sherpa_ort_vlines ENCODING UTF-8)
  foreach(_sherpa_ort_ln IN LISTS _sherpa_ort_vlines)
    string(STRIP "${_sherpa_ort_ln}" _sherpa_ort_ln)
    if(_sherpa_ort_ln MATCHES "^ONNXRUNTIME_VERSION=(.+)$")
      string(STRIP "${CMAKE_MATCH_1}" _SHERPA_ORT_VER_FROM_VERSIONS)
      break()
    endif()
  endforeach()
endif()
if(_SHERPA_ORT_VER_FROM_VERSIONS STREQUAL "")
  message(FATAL_ERROR "Could not read ONNXRUNTIME_VERSION from ${_SHERPA_ORT_VERSIONS_FILE} (required for host CTC tests).")
endif()
set(SHERPA_ONNX_HOST_ORT_VERSION "${_SHERPA_ORT_VER_FROM_VERSIONS}" CACHE STRING
  "Host CTC ORT download version (default from third_party/onnxruntime_prebuilt/VERSIONS). After bumping VERSIONS, run cmake with -USHERPA_ONNX_HOST_ORT_VERSION or delete CMakeCache to pick up the new default.")
set(SHERPA_ONNX_HOST_ORT_ROOT "" CACHE PATH "Optional: pre-extracted ONNX Runtime root (include/ + lib/)")

set(_ORT_HOST_INCLUDE "")
set(_ORT_HOST_LIBDIR "")
set(_ORT_PKG "")

if(SHERPA_ONNX_HOST_ORT_ROOT AND EXISTS "${SHERPA_ONNX_HOST_ORT_ROOT}/include/onnxruntime_c_api.h")
  set(_ORT_HOST_INCLUDE "${SHERPA_ONNX_HOST_ORT_ROOT}/include")
  set(_ORT_HOST_LIBDIR "${SHERPA_ONNX_HOST_ORT_ROOT}/lib")
  message(STATUS "CTC host tests: using ORT from SHERPA_ONNX_HOST_ORT_ROOT=${SHERPA_ONNX_HOST_ORT_ROOT}")
elseif(SHERPA_ONNX_HOST_ORT_ROOT AND EXISTS "${SHERPA_ONNX_HOST_ORT_ROOT}/include/onnxruntime/core/session/onnxruntime_c_api.h")
  set(_ORT_HOST_INCLUDE "${SHERPA_ONNX_HOST_ORT_ROOT}/include")
  set(_ORT_HOST_LIBDIR "${SHERPA_ONNX_HOST_ORT_ROOT}/lib")
  message(STATUS "CTC host tests: using ORT (nested headers) from SHERPA_ONNX_HOST_ORT_ROOT=${SHERPA_ONNX_HOST_ORT_ROOT}")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(_ORT_PKG "onnxruntime-linux-x64")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
    set(_ORT_PKG "onnxruntime-osx-arm64")
  else()
    set(_ORT_PKG "onnxruntime-osx-x86_64")
  endif()
endif()

if(NOT _ORT_HOST_INCLUDE AND _ORT_PKG)
  set(_ORT_TGZ_NAME "${_ORT_PKG}-${SHERPA_ONNX_HOST_ORT_VERSION}.tgz")
  set(_ORT_TGZ "${CMAKE_BINARY_DIR}/${_ORT_TGZ_NAME}")
  set(_ORT_ROOT "${CMAKE_BINARY_DIR}/${_ORT_PKG}-${SHERPA_ONNX_HOST_ORT_VERSION}")
  set(_ORT_URL "https://github.com/microsoft/onnxruntime/releases/download/v${SHERPA_ONNX_HOST_ORT_VERSION}/${_ORT_TGZ_NAME}")
  if(NOT EXISTS "${_ORT_ROOT}/include/onnxruntime_c_api.h")
    message(STATUS "Downloading ONNX Runtime ${_ORT_TGZ_NAME} for CTC host tests...")
    file(DOWNLOAD "${_ORT_URL}" "${_ORT_TGZ}" TLS_VERIFY ON SHOW_PROGRESS)
    execute_process(
      COMMAND ${CMAKE_COMMAND} -E tar xf "${_ORT_TGZ}"
      WORKING_DIRECTORY "${CMAKE_BINARY_DIR}"
      RESULT_VARIABLE _ORT_UNTAR
    )
    if(NOT _ORT_UNTAR EQUAL 0 OR NOT EXISTS "${_ORT_ROOT}/include/onnxruntime_c_api.h")
      message(FATAL_ERROR "Failed to download or extract ONNX Runtime from ${_ORT_URL}")
    endif()
  endif()
  set(_ORT_HOST_INCLUDE "${_ORT_ROOT}/include")
  set(_ORT_HOST_LIBDIR "${_ORT_ROOT}/lib")
endif()

if(_ORT_HOST_INCLUDE AND _ORT_HOST_LIBDIR)
  # Host ORT zips ship include/onnxruntime_c_api.h; full source tree uses onnxruntime/core/session/onnxruntime_c_api.h.
  set(_ORT_API_WRAPPER "${CMAKE_BINARY_DIR}/sherpa_onnx_ort_api_wrapper")
  file(MAKE_DIRECTORY "${_ORT_API_WRAPPER}/onnxruntime/core/session")
  if(EXISTS "${_ORT_HOST_INCLUDE}/onnxruntime/core/session/onnxruntime_c_api.h")
    file(WRITE "${_ORT_API_WRAPPER}/onnxruntime/core/session/onnxruntime_c_api.h"
      "#pragma once\n#include \"${_ORT_HOST_INCLUDE}/onnxruntime/core/session/onnxruntime_c_api.h\"\n")
  else()
    file(WRITE "${_ORT_API_WRAPPER}/onnxruntime/core/session/onnxruntime_c_api.h"
      "#pragma once\n#include \"${_ORT_HOST_INCLUDE}/onnxruntime_c_api.h\"\n")
  endif()

  set(ALIGNMENT_CPP "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/alignment/sherpa_onnx_ctc_alignment.cpp")
  add_executable(ctc_alignment_host_test
    "${CMAKE_CURRENT_SOURCE_DIR}/alignment/ctc_alignment_host_test.cpp"
    "${ALIGNMENT_CPP}"
  )
  target_include_directories(ctc_alignment_host_test PRIVATE
    "${_ORT_API_WRAPPER}"
    "${_ORT_HOST_INCLUDE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/alignment"
  )
  target_link_directories(ctc_alignment_host_test PRIVATE "${_ORT_HOST_LIBDIR}")
  target_link_libraries(ctc_alignment_host_test PRIVATE onnxruntime)
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_libraries(ctc_alignment_host_test PRIVATE dl pthread)
  endif()
  set_target_properties(ctc_alignment_host_test PROPERTIES
    BUILD_RPATH "${_ORT_HOST_LIBDIR}"
    INSTALL_RPATH "${_ORT_HOST_LIBDIR}"
  )
  if(TARGET GTest::gtest)
    target_link_libraries(ctc_alignment_host_test PRIVATE GTest::gtest GTest::gtest_main)
  else()
    target_link_libraries(ctc_alignment_host_test PRIVATE gtest gtest_main)
  endif()

  add_test(NAME ctc_alignment_host_test COMMAND $<TARGET_FILE:ctc_alignment_host_test>)
  set_tests_properties(ctc_alignment_host_test PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
  )
  message(STATUS "CTC alignment host test enabled (ORT lib: ${_ORT_HOST_LIBDIR})")
else()
  message(STATUS "CTC alignment host test skipped (set SHERPA_ONNX_HOST_ORT_ROOT or use Linux/macOS)")
endif()
