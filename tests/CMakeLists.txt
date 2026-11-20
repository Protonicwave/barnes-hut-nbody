include(FetchContent)
FetchContent_Declare(Catch2
  URL https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.1.tar.gz
  URL_HASH SHA256=d16bd1b8b2364918bd472cb216394acb93bde6784890df0d91bccfb3f28d777d
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(Catch2)

add_executable(nbody_tests
  test_diagnostics.cpp
  test_forces.cpp
  test_parallel.cpp
  test_particles.cpp
  test_setups.cpp
  test_tree_forces.cpp
  test_simulation.cpp)
target_link_libraries(nbody_tests PRIVATE nbody_core nbody_warnings
  Catch2::Catch2WithMain)

include(Catch)
catch_discover_tests(nbody_tests)

# MinGW test binaries link the runtime statically so a libstdc++ DLL from
# another toolchain earlier on PATH cannot be loaded in its place.
if(MINGW)
  target_link_options(nbody_tests PRIVATE -static)
endif()

# Catch2 writes its test listing to a host path. Under Node, raw file system
# access lets the Emscripten runtime see it.
if(EMSCRIPTEN)
  target_link_options(nbody_tests PRIVATE -sNODERAWFS=1)
endif()
