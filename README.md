# barnes-hut-nbody

A gravitational N-body simulator in C++20. Forces come from direct
summation or a Barnes-Hut octree, both with Plummer softening, and time
stepping uses kick-drift-kick leapfrog with a fixed timestep. Parallel force
loops, Python bindings and a WebAssembly build are planned.

Units are N-body units with G = 1. The library provides:

- `compute_accelerations`: softened accelerations by direct summation or by a
  Morton-ordered octree with monopole cells. `ForceConfig::theta` sets the
  opening angle from 0 (exact, every cell opened) to 1. On a 4096-body
  Plummer sphere with softening 4/sqrt(N), the median relative force error
  against direct summation is 3.8e-4 at theta 0.3, 1.4e-3 at 0.5, 3.0e-3 at
  0.7 and 7.5e-3 at 1.0. Above about 0.7 is not recommended.
- `Simulation`: leapfrog stepping of a `ParticleSet`.
- `kinetic_energy`, `potential_energy`, `total_momentum`, `centre_of_mass`.
- `plummer_sphere`, `uniform_sphere` and `kepler_binary` initial conditions.

## Build and test

Requires CMake 3.25 or later, Ninja and a C++20 compiler. Catch2 is fetched
at configure time.

    cmake --workflow --preset dev

The `release` preset builds optimised, `asan` runs the suite under
AddressSanitizer and UndefinedBehaviorSanitizer on Linux, and
`msvc` builds with Visual Studio's compiler from a developer prompt.

## Checks

    clang-tidy -quiet -p build/dev --extra-arg=--target=x86_64-w64-mingw32 src/*.cpp
    cppcheck -q --std=c++20 --enable=warning,style,performance,portability,unusedFunction --suppress=useStlAlgorithm --error-exitcode=1 -I include src tests
    cmake --workflow --preset coverage
    gcovr --root . --filter src/direct.cpp --filter src/octree.cpp --filter src/forces.cpp --filter src/simulation.cpp --filter src/diagnostics.cpp --exclude-throw-branches --exclude-unreachable-branches --exclude-noncode-lines --fail-under-line 100 --fail-under-branch 100 build/coverage

The `--target` flag matters only for a MinGW toolchain, where clang-tidy
must be told which one produced the compilation database.

## Licence

MIT. See `LICENSE`.
