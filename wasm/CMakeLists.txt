# The Embind module. Each variant writes into its own directory under web/wasm/,
# which the harness page and the smoke test load from.
if(NBODY_WASM_THREADS)
  set(NBODY_WASM_VARIANT threads)
  set(NBODY_WASM_MAX_THREADS 8)
else()
  set(NBODY_WASM_VARIANT single)
  set(NBODY_WASM_MAX_THREADS 1)
endif()

add_executable(nbody_wasm bindings.cpp)
target_link_libraries(nbody_wasm PRIVATE nbody_core nbody_warnings embind)
target_compile_definitions(nbody_wasm PRIVATE NBODY_WASM_MAX_THREADS=${NBODY_WASM_MAX_THREADS})
set_target_properties(nbody_wasm PROPERTIES
  OUTPUT_NAME nbody
  RUNTIME_OUTPUT_DIRECTORY ${PROJECT_SOURCE_DIR}/web/wasm/${NBODY_WASM_VARIANT})
target_link_options(nbody_wasm PRIVATE
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createNbody
  -sENVIRONMENT=web,worker,node)
# The smoke test stops the pool workers, which would otherwise keep Node alive.
if(NBODY_WASM_THREADS)
  target_link_options(nbody_wasm PRIVATE -sEXPORTED_RUNTIME_METHODS=PThread)
endif()
