include(FetchContent)
FetchContent_Declare(benchmark
  URL https://github.com/google/benchmark/archive/refs/tags/v1.10.0.tar.gz
  URL_HASH SHA256=acc5c7c0fbed855c4aaa2d7c3c36fb82b0c15c28f4e151e3f679c2fc0aa404af
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
set(BENCHMARK_ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(BENCHMARK_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(BENCHMARK_ENABLE_WERROR OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(benchmark)

add_executable(nbody_bench nbody_bench.cpp)
target_link_libraries(nbody_bench PRIVATE nbody_core nbody_warnings benchmark::benchmark)

add_executable(accuracy_sweep accuracy_sweep.cpp)
target_link_libraries(accuracy_sweep PRIVATE nbody_core nbody_warnings)

# Small runs that show both programs start, finish and write their files.
add_test(NAME nbody_bench_smoke
  COMMAND nbody_bench --benchmark_filter=Force/tree/1024/8 --benchmark_min_time=0.001s
          --benchmark_repetitions=1)
add_test(NAME accuracy_sweep_force_smoke
  COMMAND accuracy_sweep force ${CMAKE_CURRENT_BINARY_DIR}/force_smoke.csv 256)
add_test(NAME accuracy_sweep_drift_smoke
  COMMAND accuracy_sweep drift ${CMAKE_CURRENT_BINARY_DIR}/drift_smoke.csv 128 0.5)

# As for the tests: keep a libstdc++ DLL from another toolchain on PATH out.
if(MINGW)
  target_link_options(nbody_bench PRIVATE -static)
  target_link_options(accuracy_sweep PRIVATE -static)
endif()
