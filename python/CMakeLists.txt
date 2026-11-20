find_package(Python 3.10 REQUIRED COMPONENTS Interpreter Development.Module)
find_package(nanobind CONFIG REQUIRED)

# No warnings-as-errors here: nanobind's own headers trip -Wshadow and
# -Wcast-qual, and a compiler upgrade would fail the wheel build.
nanobind_add_module(_core NB_STATIC bindings.cpp)
target_link_libraries(_core PRIVATE nbody_core)

install(TARGETS _core LIBRARY DESTINATION barnes_hut)
