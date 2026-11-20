# barnes-hut-nbody

A gravitational N-body simulator in C++20. Forces come from direct
summation with Plummer softening, and time stepping uses kick-drift-kick
leapfrog. A Barnes-Hut octree, parallel force loops, Python bindings and a
WebAssembly build are planned.

## Build and test

Requires CMake 3.25 or later and a C++20 compiler.

    cmake --workflow --preset dev
