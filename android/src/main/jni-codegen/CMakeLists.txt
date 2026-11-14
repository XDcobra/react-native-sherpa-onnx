# Codegen library for SherpaOnnxSpec with the hand-written ReaderView insert
# shadow node (cpp/fabric). Replaces the generated codegen CMakeLists so the
# custom sources and SherpaOnnxSpec.h (which adds the custom descriptor) are used.
cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE on)

set(LIB_ANDROID_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../..)
set(LIB_FABRIC_DIR ${LIB_ANDROID_DIR}/../cpp/fabric)
set(LIB_FABRIC_COMPONENTS_DIR ${LIB_FABRIC_DIR}/react/renderer/components/SherpaOnnxSpec)
set(LIB_GENERATED_JNI_DIR ${LIB_ANDROID_DIR}/build/generated/source/codegen/jni)
set(LIB_GENERATED_COMPONENTS_DIR ${LIB_GENERATED_JNI_DIR}/react/renderer/components/SherpaOnnxSpec)

file(GLOB react_codegen_SRCS CONFIGURE_DEPENDS
  ${LIB_GENERATED_JNI_DIR}/*.cpp
  ${LIB_GENERATED_COMPONENTS_DIR}/*.cpp
  ${LIB_FABRIC_COMPONENTS_DIR}/*.cpp)

add_library(react_codegen_SherpaOnnxSpec OBJECT ${react_codegen_SRCS})

# This folder comes first: its SherpaOnnxSpec.h shadows the generated one for
# the app's autolinking.cpp.
target_include_directories(react_codegen_SherpaOnnxSpec PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${LIB_FABRIC_DIR}
  ${LIB_GENERATED_JNI_DIR}
  ${LIB_GENERATED_COMPONENTS_DIR})

target_link_libraries(react_codegen_SherpaOnnxSpec fbjni jsi reactnative)

target_compile_reactnative_options(react_codegen_SherpaOnnxSpec PRIVATE)
