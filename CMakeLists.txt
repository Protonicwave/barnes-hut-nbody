cmake_minimum_required(VERSION 3.25)
project(barnes_hut_nbody VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(CTest)

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
target_link_libraries(nbody_core PRIVATE nbody_warnings)

if(BUILD_TESTING)
  add_subdirectory(tests)
endif()
