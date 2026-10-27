# Rook (Linux) — native shell host.
#
# GTK3 window + CEF 156 browsers. One executable, `rook`.
# The CEF runtime (libcef.so, paks, icudtl.dat, locales) is staged once into
# host/cef-runtime so throwaway build directories stay cheap.
cmake_minimum_required(VERSION 3.21)
project(rook C CXX)

# CEF 156's headers are C++20 (std::same_as / concepts in base/cef_scoped_refptr.h),
# so the translation units that include them have to be C++20. The host code
# itself is written in the C++17 subset.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

set(CEF_ROOT "" CACHE PATH "CEF binary distribution (156.x)")
if(CEF_ROOT STREQUAL "")
  message(FATAL_ERROR
    "CEF_ROOT is not set: pass -DCEF_ROOT=/path/to/cef_binary_156 (see host/README.md)")
endif()
set(ROOK_CEF_RUNTIME_DIR "${CMAKE_CURRENT_SOURCE_DIR}/cef-runtime" CACHE PATH
    "Shared staging directory for CEF's runtime files")

# The sandbox is enabled at runtime (src/sandbox.cc): the setuid helper from the
# package when it is usable, user namespaces otherwise, no_sandbox when neither
# works. That decision is made at runtime; the client-side defines are kept
# consistent with CEF anyway.
set(USE_SANDBOX ON CACHE BOOL "CEF sandbox")

list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK3 REQUIRED IMPORTED_TARGET gtk+-3.0)

# One libcef_dll_wrapper for the whole project. It is the expensive part of a
# clean build (~60 s on 4 cores).
add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)

add_library(rook_core STATIC
  src/a11y.cc
  src/app.cc
  src/browser_client.cc
  src/capture.cc
  src/control_local.cc
  src/control_rpc.cc
  src/highlight.cc
  src/options.cc
  src/paths.cc
  src/sandbox.cc
  src/shell.cc
)
target_include_directories(rook_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CEF_INCLUDE_PATH}"
)
target_compile_definitions(rook_core PUBLIC
  ROOK_DEFAULT_CEF_RUNTIME="${ROOK_CEF_RUNTIME_DIR}"
)
target_link_libraries(rook_core PUBLIC libcef_dll_wrapper PkgConfig::GTK3)

add_executable(rook src/main.cc)
SET_EXECUTABLE_TARGET_PROPERTIES(rook)
target_link_directories(rook PRIVATE "${CEF_BINARY_DIR_RELEASE}")
target_link_libraries(rook PRIVATE rook_core "-l:libcef.so" ${CEF_STANDARD_LIBS})
# Absolute rpath into our own runtime dir, where icudtl.dat sits next to
# libcef.so. Never point it at the CEF distribution: ICU is resolved relative to
# the *loaded* libcef.so.
set_target_properties(rook PROPERTIES BUILD_RPATH "${ROOK_CEF_RUNTIME_DIR}")

# CEF runtime files, hardlinked (same filesystem) or copied.
add_custom_target(rook_cef_runtime ALL
  COMMAND ${CMAKE_COMMAND}
          -DCEF_SRC=${CEF_ROOT}
          -DDEST=${ROOK_CEF_RUNTIME_DIR}
          -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/StageCef.cmake"
  COMMENT "Staging CEF runtime into ${ROOK_CEF_RUNTIME_DIR}"
  VERBATIM
)
add_dependencies(rook rook_cef_runtime)

message(STATUS "rook: CEF_ROOT=${CEF_ROOT}")
message(STATUS "rook: runtime dir=${ROOK_CEF_RUNTIME_DIR}")
