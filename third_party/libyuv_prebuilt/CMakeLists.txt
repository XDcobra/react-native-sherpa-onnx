# Wrapper around the libyuv submodule. ISA flags only on *_neon64.cc.
# Android prebuilts: -DLIBYUV_BUILD_SHARED=ON
# iOS prebuilts + host tests: static (default).
cmake_minimum_required(VERSION 3.16)
project(sherpa_libyuv LANGUAGES C CXX)

option(LIBYUV_BUILD_SHARED "Build libyuv as a shared library" OFF)

set(LIBYUV_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../libyuv")
set(LIBYUV_SRC "${LIBYUV_ROOT}/source")

if(NOT EXISTS "${LIBYUV_ROOT}/include/libyuv.h")
  message(FATAL_ERROR
    "libyuv submodule missing at ${LIBYUV_ROOT}. "
    "Run: git submodule update --init third_party/libyuv")
endif()

set(LIBYUV_COMMON
  ${LIBYUV_SRC}/compare.cc
  ${LIBYUV_SRC}/compare_common.cc
  ${LIBYUV_SRC}/compare_gcc.cc
  ${LIBYUV_SRC}/compare_win.cc
  ${LIBYUV_SRC}/convert.cc
  ${LIBYUV_SRC}/convert_argb.cc
  ${LIBYUV_SRC}/convert_from.cc
  ${LIBYUV_SRC}/convert_from_argb.cc
  ${LIBYUV_SRC}/convert_to_argb.cc
  ${LIBYUV_SRC}/convert_to_i420.cc
  ${LIBYUV_SRC}/cpu_id.cc
  ${LIBYUV_SRC}/planar_functions.cc
  ${LIBYUV_SRC}/rotate.cc
  ${LIBYUV_SRC}/rotate_any.cc
  ${LIBYUV_SRC}/rotate_argb.cc
  ${LIBYUV_SRC}/rotate_common.cc
  ${LIBYUV_SRC}/rotate_gcc.cc
  ${LIBYUV_SRC}/rotate_win.cc
  ${LIBYUV_SRC}/row_any.cc
  ${LIBYUV_SRC}/row_common.cc
  ${LIBYUV_SRC}/row_gcc.cc
  ${LIBYUV_SRC}/row_win.cc
  ${LIBYUV_SRC}/scale.cc
  ${LIBYUV_SRC}/scale_any.cc
  ${LIBYUV_SRC}/scale_argb.cc
  ${LIBYUV_SRC}/scale_common.cc
  ${LIBYUV_SRC}/scale_gcc.cc
  ${LIBYUV_SRC}/scale_rgb.cc
  ${LIBYUV_SRC}/scale_uv.cc
  ${LIBYUV_SRC}/scale_win.cc
  ${LIBYUV_SRC}/video_common.cc
)

set(LIBYUV_NEON32
  ${LIBYUV_SRC}/compare_neon.cc
  ${LIBYUV_SRC}/rotate_neon.cc
  ${LIBYUV_SRC}/row_neon.cc
  ${LIBYUV_SRC}/scale_neon.cc
)

set(LIBYUV_NEON64
  ${LIBYUV_SRC}/compare_neon64.cc
  ${LIBYUV_SRC}/rotate_neon64.cc
  ${LIBYUV_SRC}/row_neon64.cc
  ${LIBYUV_SRC}/scale_neon64.cc
)

set(LIBYUV_DISABLE_DEFS
  LIBYUV_DISABLE_JPEG
  LIBYUV_DISABLE_SME
  LIBYUV_DISABLE_SVE
  LIBYUV_DISABLE_LSX
  LIBYUV_DISABLE_LASX
  LIBYUV_DISABLE_HVX
  LIBYUV_DISABLE_RVV
)

# *_win.cc is a no-op on NDK/Apple clang unless LIBYUV_ENABLE_ROWWIN; keep it
# anyway because 32-bit x86 SSE for MSVC lives there. Android x86/x86_64 SSE
# is in *_gcc.cc (compiled for those ABIs, empty elsewhere).

if(LIBYUV_BUILD_SHARED)
  add_library(yuv SHARED ${LIBYUV_COMMON})
  target_compile_definitions(yuv PRIVATE LIBYUV_BUILDING_SHARED_LIBRARY)
  set_target_properties(yuv PROPERTIES C_VISIBILITY_PRESET hidden CXX_VISIBILITY_PRESET hidden)
else()
  add_library(yuv STATIC ${LIBYUV_COMMON})
endif()

target_include_directories(yuv PUBLIC "${LIBYUV_ROOT}/include")
target_compile_definitions(yuv PUBLIC ${LIBYUV_DISABLE_DEFS})
set_target_properties(yuv PROPERTIES
  POSITION_INDEPENDENT_CODE ON
  CXX_STANDARD 17
  OUTPUT_NAME yuv
)

string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" _ly_arch)
if(ANDROID AND ANDROID_ABI STREQUAL "armeabi-v7a")
  target_sources(yuv PRIVATE ${LIBYUV_NEON32})
  set_source_files_properties(${LIBYUV_NEON32} PROPERTIES COMPILE_OPTIONS "-mfpu=neon")
elseif(ANDROID AND ANDROID_ABI STREQUAL "arm64-v8a")
  target_sources(yuv PRIVATE ${LIBYUV_NEON64})
  set_source_files_properties(${LIBYUV_NEON64} PROPERTIES
    COMPILE_OPTIONS "-march=armv8.2-a+dotprod+i8mm")
elseif(_ly_arch STREQUAL "aarch64" OR _ly_arch STREQUAL "arm64")
  target_sources(yuv PRIVATE ${LIBYUV_NEON64})
  set_source_files_properties(${LIBYUV_NEON64} PROPERTIES
    COMPILE_OPTIONS "-march=armv8.2-a+dotprod+i8mm")
endif()

install(TARGETS yuv
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION lib)
install(DIRECTORY "${LIBYUV_ROOT}/include/" DESTINATION include)
