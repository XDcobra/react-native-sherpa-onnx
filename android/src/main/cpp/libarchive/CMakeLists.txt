cmake_minimum_required(VERSION 3.22.1)

project(libarchive C)

# Set C standard
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# List all libarchive source files relative to this directory
file(GLOB libarchive_SOURCES
    "libarchive/*.c"
)

# Remove unwanted files if they exist
list(FILTER libarchive_SOURCES EXCLUDE REGEX "test.*\\.c$")

# Create shared library
add_library(archive SHARED ${libarchive_SOURCES})

# Include directories
target_include_directories(archive PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/libarchive"
    "${CMAKE_CURRENT_SOURCE_DIR}/contrib/android/include"
)

target_include_directories(archive PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/libarchive"
    "${CMAKE_CURRENT_SOURCE_DIR}/contrib/android/include"
)

# Use Android-specific config header shipped with libarchive
target_compile_definitions(archive PRIVATE
    PLATFORM_CONFIG_H="config.h"
)

# Compiler flags
target_compile_options(archive PRIVATE
    -Wall
    -Wextra
    -Wno-error
    -Wno-unused-variable
    -Wno-sign-compare
    -Wno-format
)

# Link zlib from the NDK (required for gzip/zip/deflate)
target_link_libraries(archive PRIVATE z)

# Library properties
set_target_properties(archive PROPERTIES
    VERSION 13.7.2
    SOVERSION 13
)

list(LENGTH libarchive_SOURCES libarchive_SOURCE_COUNT)
message(STATUS "libarchive: Built shared library 'archive' with ${libarchive_SOURCE_COUNT} source files")
