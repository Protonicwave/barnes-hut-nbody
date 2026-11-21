# Reproducing the results

Timing figures in the README are medians of 5 repetitions on an Intel Core Ultra 5
238V (4 performance and 4 efficiency cores), g++ 16.2.0, `release` preset,
Plummer sphere, softening 4/sqrt(N), theta 0.5, 8 threads. A tree evaluation
includes building the tree. The data is in `results/`: `timing.json`,
`force_error.csv` (force error quantiles against theta at N = 16384),
`energy_drift.csv` (relative energy error every 1/8 time unit for N = 4096 over
28.25 time units, about ten crossing times) and `wasm_timing.json`.

## Speed, force error and energy drift

From the repository root:

```
cmake --workflow --preset release
build/release/bench/nbody_bench --benchmark_repetitions=5 --benchmark_min_time=0.1s --benchmark_report_aggregates_only=true --benchmark_out=build/release/budget.json --benchmark_out_format=json
build/release/bench/accuracy_sweep force results/force_error.csv
build/release/bench/accuracy_sweep drift results/energy_drift.csv
python bench/check_budgets.py build/release/budget.json --drift results/energy_drift.csv --summary results/timing.json
```

`check_budgets.py` prints each budget beside its figure and exits 1 when any
is over. It reads the core count from `results/machine.txt`. Its tests run
with `python -m unittest discover -s bench`. The drift sweep takes about
eight minutes.

## Native against WebAssembly

One tree force evaluation, tree build included, at N = 16384, theta 0.5,
softening 4/sqrt(N). Medians of 5 repetitions, the native build from the
`release` preset and the Wasm builds under Node 26.4.0. The budgets are a
ratio of at most 2.5 on one thread and 3 on eight. The two builds do not time
the same particles: libc++ and libstdc++ draw different numbers from the same
seed, so the Plummer sphere is a different realisation of the same
distribution. Reproduce the figures after building the `release`,
`wasm-single` and `wasm-threads` presets:

```
python bench/check_wasm_budgets.py --native build/release/bench/kernel_timing --wasm-single build/wasm-single/bench/kernel_timing.js --wasm-threads build/wasm-threads/bench/kernel_timing.js --summary results/wasm_timing.json
```

It prints each ratio beside its budget and exits 1 when either is over. Its
tests run with `python -m unittest discover -s bench`.

## Figures

The light and dark figures in `results/` are drawn from those files. They need
the `plot` extra:

```
python scripts/plot_results.py
```

The simulator page reads the same data from `web/data/results.json`:

```
python scripts/export_page_data.py
```

## Hero screenshots

`docs/screenshots/hero-light.png` and `hero-dark.png` show the running
simulator on the threaded build, paused five seconds into a run. They need the
Wasm builds from [building.md](building.md) and Chrome:

```
node web/test/screenshot.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```
