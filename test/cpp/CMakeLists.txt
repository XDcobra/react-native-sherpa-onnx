# Host-side C++ tests (Linux/macOS CI): no Android NDK.
# Layout: model_detect/ — STT/TTS model detection; audio_conversion/ — FFmpeg audio convert (same sources as Android).
cmake_minimum_required(VERSION 3.16)
project(sherpa-onnx-host-cpp-tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)

set(MODEL_DETECT_TEST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/model_detect")
set(AUDIO_CONVERSION_TEST_DIR "${CMAKE_CURRENT_SOURCE_DIR}/audio_conversion")

# Production sources (same logic as Android; no __ANDROID__ so LOGI/LOGE are no-ops)
set(MODEL_DETECT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni/model_detect")
set(JNI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../android/src/main/cpp/jni")

set(PRODUCTION_SOURCES
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-helper.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-stt.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-tts.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-tts-catalog-hints.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-model-detect-enhancement.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-validate-stt.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-validate-tts.cpp"
  "${MODEL_DETECT_DIR}/sherpa-onnx-validate-enhancement.cpp"
)

add_executable(model_detect_test
  "${MODEL_DETECT_TEST_DIR}/model_detect_test.cpp"
  "${MODEL_DETECT_TEST_DIR}/model_detect_test_utils.cpp"
  "${MODEL_DETECT_TEST_DIR}/tts_catalog_hints_test.cpp"
)

target_sources(model_detect_test PRIVATE ${PRODUCTION_SOURCES})

target_include_directories(model_detect_test PRIVATE
  "${MODEL_DETECT_DIR}"
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

  add_executable(audio_convert_file_host_test "${AUDIO_CONVERSION_TEST_DIR}/audio_convert_file_test.cpp")
  target_sources(audio_convert_file_host_test PRIVATE "${AUDIO_JNI_DIR}/audio_convert_file.cpp")
  target_include_directories(audio_convert_file_host_test PRIVATE "${AUDIO_JNI_DIR}" "${AUDIO_CONVERSION_TEST_DIR}")
  target_compile_definitions(audio_convert_file_host_test PRIVATE HAVE_FFMPEG=1)
  target_link_libraries(audio_convert_file_host_test PRIVATE PkgConfig::LIBAV ${AUDIO_GTEST_LIBS})

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

if(TARGET audio_convert_file_host_test)
  add_test(NAME audio_convert_file_host_test COMMAND $<TARGET_FILE:audio_convert_file_host_test>)
  set_tests_properties(audio_convert_file_host_test PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
  )
endif()
if(TARGET audio_f32le_to_format_host_test)
  add_test(NAME audio_f32le_to_format_host_test COMMAND $<TARGET_FILE:audio_f32le_to_format_host_test>)
  set_tests_properties(audio_f32le_to_format_host_test PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../.."
  )
endif()
