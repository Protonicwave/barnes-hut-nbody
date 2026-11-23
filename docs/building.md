# Building and running

Requires CMake 3.25 or later, Ninja and a C++20 compiler. Catch2 is fetched
at configure time.

```
cmake --workflow --preset dev
```

The `release` preset builds optimised, `asan` runs the suite under
AddressSanitizer and UndefinedBehaviorSanitizer on Linux, and
`msvc` builds with Visual Studio's compiler from a developer prompt.

## Library

Units are N-body units with G = 1. The library provides:

- `compute_accelerations`: softened accelerations by direct summation or by a
  Morton-ordered octree with monopole cells. `ForceConfig::theta` sets the
  opening angle from 0 (exact, every cell opened) to 1. Above about 0.7 is not
  recommended. `ForceConfig::thread_count` sets the threads, from 1 to 256, and
  results are bitwise identical for every thread count.
- `Simulation`: leapfrog stepping of a `ParticleSet`.
- `kinetic_energy`, `potential_energy`, `total_momentum`, `centre_of_mass`.
- `plummer_sphere`, `uniform_sphere` and `kepler_binary` initial conditions.

## Python

```
pip install .
```

installs `barnes_hut` (Python 3.10 or later, NumPy 1.26 or later) and builds
the C++ core with CMake, Ninja and a C++20 compiler with OpenMP. Wheels for
Linux, Windows and macOS on Apple silicon are built by the `wheels` workflow.

```python
import numpy as np
import barnes_hut as bh

positions, velocities, masses = bh.plummer_sphere(4096, seed=1)
simulation = bh.Simulation(
    positions, velocities, masses,
    dt=1 / 128, softening=4 / np.sqrt(4096),
    method="tree", theta=0.5, threads=8,
)
start = simulation.total_energy()
simulation.step(256)
print(simulation.time, abs(simulation.total_energy() - start) / abs(start))
```

`method` is `"tree"` or `"direct"`; `theta` is from 0 to 1 and `threads` from 1
to 256. Invalid settings raise `ValueError` naming the value, and a particle
leaving the finite range raises `RuntimeError`. `positions`, `velocities` and
`masses` are read-only NumPy views of the simulation state, with no copy: they
follow `step`, and keep the simulation alive. The constructor copies its
inputs. `plummer_sphere`, `uniform_sphere` and `kepler_binary` return the
three arrays the constructor takes. `step` holds the Python interpreter lock
for the whole call, and a `Simulation` must not be used from two threads at
once. The tests run with `python -m pytest`, after `pip install ".[test,plot]"`.

## WebAssembly

The core builds with Emscripten 6.0.6 in two variants. `wasm-threads` runs the
force loops on `std::thread` workers, a pool of 7 started with the module,
and `wasm-single` runs them on the calling thread. Results are bitwise
identical between the two.
Install emsdk, activate it so that `EMSDK` is set, then from the repository
root:

```
cmake --workflow --preset wasm-threads
cmake --workflow --preset wasm-single
node --test web/test/smoke.mjs
```

Each workflow builds the Catch2 suite and runs it under Node. The Embind
module is written to `web/wasm/threads/` and `web/wasm/single/`, as
`nbody.js` and `nbody.wasm`, and the smoke test drives both. The heap is fixed
at 256 MiB, which holds 65536 particles with the tree or direct summation, the
limit the module enforces.

```js
import createModule from "./wasm/threads/nbody.js";

const module = await createModule();
const simulation = module.Simulation.create(
  "plummer", 4096, 1, "tree", 0.5, 4 / Math.sqrt(4096), 1 / 128, 8);
simulation.step(16);
const positions = simulation.positions(); // Float64Array view of 3 * N doubles
const error = Math.abs(simulation.energy() - simulation.initialEnergy())
  / Math.abs(simulation.initialEnergy());
```

`setup` is `"plummer"`, `"collapse"` or `"kepler"` (two bodies, eccentricity
0.5, semi-major axis 1, which ignore the count and seed). `step` takes 1 to
1024 steps. `energy` is the kinetic energy plus the direct softened potential,
whatever the force method. Invalid arguments throw an `Error` naming the
value. Also on `Simulation`: `setForceSettings(method, theta, threads)`,
`evaluateForces(method)`, `compare(method)` (median and 99th-percentile force
error against direct summation, and mean interactions per particle),
`treeCells(maxDepth)` and `walkTrace(index)`, which also gives the centre of
mass of each accepted cell. The views point into the heap, so
read them before the next call. The
threaded build needs a worker: it joins its threads with a blocking wait,
which a page's main thread may not do, so `web/worker.js` runs the module.

## The simulator page

`web/index.html` is the simulator page. It runs the module in the worker
`web/worker.js` and draws the particles, the octree cells and one particle's
tree walk, with live timings of direct and tree evaluation, the relative energy
error, and the results figures. The controls run in the order an
experiment is set up: initial conditions, force, integrator. Beside the
display are three conservation meters: the relative energy error, the change
in total momentum and the shift of the centre of mass, each since the start
of the run or the last method change. Under it, "Reproduce in Python" gives
the Python call that repeats the run on screen. `web/data/results.json` holds the figures
it draws, written from `results/` by `python scripts/export_page_data.py`. The
fonts in `web/fonts/` are B612 and B612 Mono, subset to the glyphs the page
uses, under the SIL Open Font Licence. Screenshots are in `docs/screenshots/`.

Threads need
shared memory, and browsers allow that only on a cross-origin isolated page,
which means two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages cannot send them. `web/_headers` sets them on Cloudflare Pages.
`serve.bat` on Windows, or `python web/serve.py`, serves the directory locally
at http://127.0.0.1:8000/ with them (the batch file also opens the page, and
needs the Wasm builds above in place), and
`--no-isolation` leaves them out, which shows the page fall back to the
single-threaded build with a banner saying so. In headless Chrome on the
development machine the page loads in 0.6 s to its largest paint on the
single-threaded build, with no layout shift, and its own JavaScript is 23 KiB
compressed. `web/test/page_budget.mjs` measures those figures and the time of
one viewport draw at 8192 particles, prints each beside its budget and exits 1
when any is over:

```
node web/test/page_budget.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## Deploy

The `deploy` job in `.github/workflows/ci.yml` publishes `web/`, with both
Wasm builds and without the Python and test files, to Cloudflare Pages on every
push to `main` that passes the `wasm` job. It then runs
`bash scripts/check_site_headers.sh BASE_URL`, which fetches the page, its
worker and the Wasm files and fails unless each carries the two headers above and
the modules are served as `application/wasm`. The same command checks any
served copy, such as `http://127.0.0.1:8000`.

## Checks

```
clang-tidy -quiet -p build/dev --extra-arg=--target=x86_64-w64-mingw32 src/*.cpp
cppcheck -q --std=c++20 --enable=warning,style,performance,portability,unusedFunction --suppress=useStlAlgorithm --error-exitcode=1 -I include src tests bench python wasm
clang-tidy -quiet wasm/bindings.cpp -- -std=c++20 --target=wasm32-unknown-emscripten -fwasm-exceptions -msimd128 -isystem $EMSDK/upstream/emscripten/cache/sysroot/include/c++/v1 -isystem $EMSDK/upstream/emscripten/cache/sysroot/include/compat -isystem $EMSDK/upstream/emscripten/cache/sysroot/include -Iinclude -DNBODY_WASM_MAX_THREADS=8 -D__EMSCRIPTEN__
ruff check python scripts web
mypy
vulture python scripts web --min-confidence 60
cmake --workflow --preset coverage
gcovr --root . --filter src/direct.cpp --filter src/octree.cpp --filter src/forces.cpp --filter src/simulation.cpp --filter src/diagnostics.cpp --exclude-throw-branches --exclude-unreachable-branches --exclude-noncode-lines --fail-under-line 100 --fail-under-branch 100 build/coverage
```

The `--target` flag matters only for a MinGW toolchain, where clang-tidy
must be told which one produced the compilation database.
