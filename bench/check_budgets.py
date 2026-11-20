"""Checks the performance and accuracy budgets against measured figures.

Reads the JSON that nbody_bench writes with --benchmark_out, and optionally
the CSV that accuracy_sweep drift writes. Prints each figure beside its
budget and exits 1 when any is over, or when a figure it needs is missing.
Standard library only.
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import NamedTuple

SECONDS_PER_UNIT = {"ns": 1e-9, "us": 1e-6, "ms": 1e-3, "s": 1.0}
BENCHMARK_NAME = re.compile(r"Force/(direct|tree)/(\d+)/(\d+)/real_time")

# The timing budgets apply at this particle count and thread count.
REFERENCE_COUNT = 65536
REFERENCE_THREADS = 8

# The drift budgets apply to the run with these settings, which the tree and
# direct summation share. The softening is this many over sqrt(N).
REFERENCE_THETA = 0.5
REFERENCE_TIMESTEP = 1.0 / 128.0
REFERENCE_SOFTENING_SCALE = 4.0


class Budgets(NamedTuple):
    """Limits from the project plan. Every one is a guess until measured."""

    min_speedup_over_direct: float = 10.0
    min_count_tree_wins: int = 4096
    max_tree_ms: float = 400.0
    min_scaling_efficiency: float = 0.35
    max_tree_drift: float = 1.7e-4
    max_direct_drift: float = 6e-6


class Result(NamedTuple):
    name: str
    figure: float
    budget: float
    is_upper_bound: bool

    @property
    def passed(self) -> bool:
        if self.is_upper_bound:
            return self.figure <= self.budget
        return self.figure >= self.budget


def load_medians_ms(path: Path) -> dict[tuple[str, int, int], float]:
    """Median real time in milliseconds, keyed by method, count and threads."""
    medians = {}
    for entry in json.loads(path.read_text(encoding="utf-8"))["benchmarks"]:
        if entry.get("aggregate_name") != "median":
            continue
        match = BENCHMARK_NAME.fullmatch(entry["run_name"])
        if match is None:
            continue
        key = (match[1], int(match[2]), int(match[3]))
        medians[key] = entry["real_time"] * SECONDS_PER_UNIT[entry["time_unit"]] * 1e3
    return medians


def load_physical_cores(path: Path) -> int:
    for line in path.read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if name.strip() == "physical_cores":
            return int(value)
    raise SystemExit(f"{path} has no physical_cores line")


def need(medians: dict[tuple[str, int, int], float], method: str, count: int, threads: int) -> float:
    try:
        return medians[(method, count, threads)]
    except KeyError:
        raise SystemExit(f"no median for {method} at {count} particles on {threads} threads") from None


def check_timing(
    medians: dict[tuple[str, int, int], float], physical_cores: int, budgets: Budgets
) -> list[Result]:
    tree = need(medians, "tree", REFERENCE_COUNT, REFERENCE_THREADS)
    direct = need(medians, "direct", REFERENCE_COUNT, REFERENCE_THREADS)
    single = need(medians, "tree", REFERENCE_COUNT, 1)
    on_all_cores = need(medians, "tree", REFERENCE_COUNT, physical_cores)
    counts = sorted(
        count for method, count, threads in medians
        if method == "direct" and threads == REFERENCE_THREADS and count >= budgets.min_count_tree_wins
    )
    # The slowest margin of the tree over direct summation across the counts.
    worst_ratio = min(need(medians, "direct", count, REFERENCE_THREADS)
                      / need(medians, "tree", count, REFERENCE_THREADS) for count in counts)
    return [
        Result(f"tree speedup over direct, N={REFERENCE_COUNT}, {REFERENCE_THREADS} threads",
               direct / tree, budgets.min_speedup_over_direct, False),
        Result(f"smallest direct/tree time ratio, N from {budgets.min_count_tree_wins}",
               worst_ratio, 1.0, False),
        Result(f"tree evaluation ms, N={REFERENCE_COUNT}, {REFERENCE_THREADS} threads",
               tree, budgets.max_tree_ms, True),
        Result(f"tree speedup, 1 to {physical_cores} threads, N={REFERENCE_COUNT}",
               single / on_all_cores, budgets.min_scaling_efficiency * physical_cores, False),
    ]


def max_drift(path: Path, method: str) -> float:
    """Largest relative energy error of the reference run of a method."""
    with path.open(newline="", encoding="utf-8") as file:
        figures = [
            float(row["relative_energy_error"])
            for row in csv.DictReader(file)
            if row["method"] == method
            and row["theta"] in ("", str(REFERENCE_THETA))
            and float(row["timestep"]) == REFERENCE_TIMESTEP
            and float(row["softening_scale"]) == REFERENCE_SOFTENING_SCALE
        ]
    if not figures:
        raise SystemExit(f"{path} has no reference run for {method}")
    return max(figures)


def check_drift(path: Path, budgets: Budgets) -> list[Result]:
    return [
        Result("max relative energy error, tree theta 0.5, reference run",
               max_drift(path, "tree"), budgets.max_tree_drift, True),
        Result("max relative energy error, direct, reference run",
               max_drift(path, "direct"), budgets.max_direct_drift, True),
    ]


def write_summary(medians: dict[tuple[str, int, int], float], path: Path) -> None:
    """Writes the medians without the host details the benchmark JSON carries."""
    rows = [
        {"method": method, "count": count, "threads": threads, "median_ms": median_ms}
        for (method, count, threads), median_ms in sorted(medians.items())
    ]
    path.write_text(json.dumps(rows, indent=1) + "\n", encoding="utf-8")


def main(argv: list[str], budgets: Budgets = Budgets()) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("timing", type=Path, help="JSON written by nbody_bench")
    parser.add_argument("--machine", type=Path, default=Path("results/machine.txt"))
    parser.add_argument("--drift", type=Path, help="CSV written by accuracy_sweep drift")
    parser.add_argument("--summary", type=Path, help="write the medians to this JSON file")
    arguments = parser.parse_args(argv)

    medians = load_medians_ms(arguments.timing)
    results = check_timing(medians, load_physical_cores(arguments.machine), budgets)
    if arguments.drift is not None:
        results += check_drift(arguments.drift, budgets)
    if arguments.summary is not None:
        write_summary(medians, arguments.summary)
    for result in results:
        sign = "<=" if result.is_upper_bound else ">="
        print(f"{'ok  ' if result.passed else 'OVER'} {result.name}: "
              f"{result.figure:.4g} (budget {sign} {result.budget:.4g})")
    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
