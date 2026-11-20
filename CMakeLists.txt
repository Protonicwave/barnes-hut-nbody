cmake_minimum_required(VERSION 3.25)
project(barnes_hut_nbody VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(NBODY_BUILD_BENCH "Build the benchmark and accuracy programs" OFF)
option(NBODY_BUILD_PYTHON "Build the Python extension module" OFF)
option(NBODY_WASM_THREADS "WebAssembly: run force loops on std::thread workers" OFF)

include(CTest)

if(EMSCRIPTEN)
  # One fixed heap, so the page knows its particle limit and a threaded build
  # never grows shared memory. The stack sizes cover Catch2 and the tree walk.
  set(NBODY_WASM_FLAGS -fwasm-exceptions -msimd128 -flto)
  set(NBODY_WASM_LINK_FLAGS ${NBODY_WASM_FLAGS}
    -sINITIAL_MEMORY=268435456 -sSTACK_SIZE=1048576)
  if(NBODY_WASM_THREADS)
    list(APPEND NBODY_WASM_FLAGS -pthread)
    list(APPEND NBODY_WASM_LINK_FLAGS -pthread
      -sPTHREAD_POOL_SIZE=8 -sDEFAULT_PTHREAD_STACK_SIZE=1048576)
  endif()
  add_compile_options(${NBODY_WASM_FLAGS})
  add_link_options(${NBODY_WASM_LINK_FLAGS})
else()
  find_package(OpenMP REQUIRED COMPONENTS CXX)
endif()

add_library(nbody_warnings INTERFACE)
if(MSVC)
  target_compile_options(nbody_warnings INTERFACE /W4 /WX /permissive-)
else()
  target_compile_options(nbody_warnings INTERFACE
    -Wall -Wextra -Wpedantic -Wshadow -Wformat=2 -Wcast-qual
    -Wnull-dereference -Werror)
endif()

add_library(nbody_core
  src/particles.cpp
  src/forces.cpp
  src/direct.cpp
  src/octree.cpp
  src/simulation.cpp
  src/diagnostics.cpp
  src/setups.cpp)
target_include_directories(nbody_core PUBLIC include)
target_compile_features(nbody_core PUBLIC cxx_std_20)
set_target_properties(nbody_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_link_libraries(nbody_core PRIVATE nbody_warnings)
if(EMSCRIPTEN)
  target_compile_definitions(nbody_core PRIVATE
    $<IF:$<BOOL:${NBODY_WASM_THREADS}>,NBODY_BACKEND_THREADS,NBODY_BACKEND_SERIAL>)
else()
  target_link_libraries(nbody_core PRIVATE OpenMP::OpenMP_CXX)
endif()

if(NBODY_BUILD_PYTHON)
  add_subdirectory(python)
endif()

if(BUILD_TESTING)
  add_subdirectory(tests)
  if(NBODY_BUILD_BENCH)
    add_subdirectory(bench)
  endif()
endif()
