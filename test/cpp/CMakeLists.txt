# Host-side test for STT model detection. Uses path-only fixtures; no Android.
cmake_minimum_required(VERSION 3.16)
project(sherpa-onnx-model-detect-test LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)

# Production sources (same logic as Android; no __ANDROID__ so LOGI/LOGE are no-ops)
set(MODEL_DETECT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni/model_detect")
set(JNI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni")

set(PRODUCTION_SOURCES
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-helper.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-stt.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-tts.cpp"
)

add_executable(model_detect_test
  model_detect_test.cpp
  model_detect_test_utils.cpp
)

target_sources(model_detect_test PRIVATE ${PRODUCTION_SOURCES})

target_include_directories(model_detect_test PRIVATE
  "${MODEL_DETECT_DIR}"
  "${JNI_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}"
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

# Run from repo root so "test/fixtures" resolves; or set env TEST_FIXTURES_DIR

# Allow running from repo root: add test command that sets CWD
include(CTest)
enable_testing()
add_test(NAME model_detect_test COMMAND $<TARGET_FILE:model_detect_test>)
set_tests_properties(model_detect_test PROPERTIES
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
)
