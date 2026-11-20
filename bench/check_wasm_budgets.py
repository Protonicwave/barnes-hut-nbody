"""Times the tree force kernel natively and under Node, and checks the ratios.

Runs bench/kernel_timing for the native build, the single-threaded WebAssembly
build and the threaded one, prints each Wasm to native ratio beside its budget
and exits 1 when any is over. The single-threaded figure is compared with the
native run on one thread, the threaded figure with the native run on the same
number of threads. Standard library only.
"""

import argparse
import json
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple

PARTICLE_COUNT = 16384
THREADED_COUNT = 8
REPETITIONS = 5
TIMEOUT_SECONDS = 600


class Budgets(NamedTuple):
    """Largest allowed ratio of a Wasm time to the native time."""

    max_single_thread_ratio: float = 2.5
    max_threaded_ratio: float = 3.0


class Result(NamedTuple):
    name: str
    figure: float
    budget: float

    @property
    def passed(self) -> bool:
        return self.figure <= self.budget


Runner = Callable[[Sequence[str]], float]


def run_kernel(command: Sequence[str]) -> float:
    """Median milliseconds that a kernel_timing command prints."""
    completed = subprocess.run(  # noqa: S603 - the command is built from the arguments below
        command, capture_output=True, text=True, check=True, timeout=TIMEOUT_SECONDS
    )
    return float(json.loads(completed.stdout)["median_ms"])


def kernel_command(program: Sequence[str], threads: int) -> list[str]:
    return [*program, str(PARTICLE_COUNT), str(threads), str(REPETITIONS)]


def measure(
    native: Path, wasm_single: Path, wasm_threads: Path, node: str, runner: Runner
) -> dict[str, float]:
    """Median milliseconds per platform and thread count, keyed like `native-1`."""
    programs = {
        "native": [str(native)],
        "wasm-single": [node, str(wasm_single)],
        "wasm-threads": [node, str(wasm_threads)],
    }
    runs = [
        ("native", 1),
        ("native", THREADED_COUNT),
        ("wasm-single", 1),
        ("wasm-threads", THREADED_COUNT),
    ]
    return {
        f"{platform}-{threads}": runner(kernel_command(programs[platform], threads))
        for platform, threads in runs
    }


def check(medians: dict[str, float], budgets: Budgets) -> list[Result]:
    return [
        Result(
            f"Wasm single-threaded over native, 1 thread, N={PARTICLE_COUNT}",
            medians["wasm-single-1"] / medians["native-1"],
            budgets.max_single_thread_ratio,
        ),
        Result(
            f"Wasm threaded over native, {THREADED_COUNT} threads, N={PARTICLE_COUNT}",
            medians[f"wasm-threads-{THREADED_COUNT}"] / medians[f"native-{THREADED_COUNT}"],
            budgets.max_threaded_ratio,
        ),
    ]


def write_summary(medians: dict[str, float], node_version_text: str, path: Path) -> None:
    rows = []
    for key, median_ms in medians.items():
        platform, _, threads = key.rpartition("-")
        rows.append(
            {
                "platform": platform,
                "threads": int(threads),
                "count": PARTICLE_COUNT,
                "median_ms": median_ms,
            }
        )
    path.write_text(
        json.dumps({"node": node_version_text, "runs": rows}, indent=1) + "\n", encoding="utf-8"
    )


def node_version(node: str) -> str:
    completed = subprocess.run(  # noqa: S603 - the command is the node given on the command line
        [node, "--version"], capture_output=True, text=True, check=True, timeout=TIMEOUT_SECONDS
    )
    return completed.stdout.strip()


def main(
    argv: list[str],
    budgets: Budgets = Budgets(),  # noqa: B008 - an immutable tuple of numbers
    runner: Runner = run_kernel,
    version: Callable[[str], str] = node_version,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", type=Path, required=True, help="native kernel_timing")
    parser.add_argument("--wasm-single", type=Path, required=True, help="kernel_timing.js, single")
    parser.add_argument(
        "--wasm-threads", type=Path, required=True, help="kernel_timing.js, threaded"
    )
    parser.add_argument("--node", default="node", help="Node executable")
    parser.add_argument("--summary", type=Path, help="write the medians to this JSON file")
    arguments = parser.parse_args(argv)

    medians = measure(
        arguments.native, arguments.wasm_single, arguments.wasm_threads, arguments.node, runner
    )
    if arguments.summary is not None:
        write_summary(medians, version(arguments.node), arguments.summary)
    for key, median_ms in medians.items():
        print(f"     {key}: {median_ms:.4g} ms")
    results = check(medians, budgets)
    for result in results:
        print(
            f"{'ok  ' if result.passed else 'OVER'} {result.name}: "
            f"{result.figure:.4g} (budget <= {result.budget:.4g})"
        )
    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
