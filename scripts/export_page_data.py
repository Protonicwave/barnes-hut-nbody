"""Writes the figures the web page draws from the committed results.

Reads timing.json, force_error.csv, energy_drift.csv, wasm_timing.json and
machine.txt from the results directory, and the budgets from the two budget
checkers, and writes web/data/results.json. The page fetches that one file, so
every number on it comes from a measurement that is in the repository. Standard
library only.
"""

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parent.parent
# The budgets live with the checkers that enforce them, in bench/.
sys.path.insert(0, str(REPOSITORY / "bench"))

import check_budgets  # noqa: E402
import check_wasm_budgets  # noqa: E402

FORCE_ERROR_COUNT = 16384
DRIFT_COUNT = 4096
DRIFT_TIMESTEP = 1.0 / 128.0
DRIFT_SOFTENING_SCALE = 4.0
# The drift curves the page draws: direct summation and the tree at these angles.
DRIFT_THETAS = (0.3, 0.5, 0.7, 1.0)
SIGNIFICANT_DIGITS = 4


def significant(value: float) -> float:
    return float(f"{value:.{SIGNIFICANT_DIGITS - 1}e}")


def read_machine(path: Path) -> dict[str, str | int]:
    fields = dict(
        line.partition("=")[::2] for line in path.read_text(encoding="utf-8").splitlines() if line
    )
    return {"cpu": fields["cpu"], "physicalCores": int(fields["physical_cores"])}


def read_force_error(path: Path) -> list[dict[str, float]]:
    with path.open(newline="", encoding="utf-8") as file:
        return [
            {
                "theta": float(row["theta"]),
                "median": significant(float(row["median"])),
                "p99": significant(float(row["p99"])),
            }
            for row in csv.DictReader(file)
        ]


def read_drift(path: Path) -> list[dict[str, Any]]:
    """One curve per method and opening angle of the reference run."""
    curves: dict[tuple[str, float | None], list[list[float]]] = {}
    with path.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            if (
                float(row["timestep"]) != DRIFT_TIMESTEP
                or float(row["softening_scale"]) != DRIFT_SOFTENING_SCALE
            ):
                continue
            theta = float(row["theta"]) if row["method"] == "tree" else None
            if theta is not None and theta not in DRIFT_THETAS:
                continue
            point = [float(row["time"]), significant(float(row["relative_energy_error"]))]
            curves.setdefault((row["method"], theta), []).append(point)
    missing = [
        key for key in [("direct", None), *(("tree", t) for t in DRIFT_THETAS)] if key not in curves
    ]
    if missing:
        raise ValueError(f"{path} has no reference run for {missing}")
    return [
        {"method": method, "theta": theta, "points": points}
        for (method, theta), points in sorted(
            curves.items(), key=lambda item: (item[0][0], item[0][1] or 0)
        )
    ]


def build(results: Path) -> dict[str, Any]:
    timing = json.loads((results / "timing.json").read_text(encoding="utf-8"))
    wasm = json.loads((results / "wasm_timing.json").read_text(encoding="utf-8"))
    return {
        "machine": read_machine(results / "machine.txt"),
        "timing": timing,
        "forceError": {
            "count": FORCE_ERROR_COUNT,
            "rows": read_force_error(results / "force_error.csv"),
        },
        "drift": {
            "count": DRIFT_COUNT,
            "timestep": DRIFT_TIMESTEP,
            "curves": read_drift(results / "energy_drift.csv"),
        },
        "wasm": {
            "node": wasm["node"],
            "count": wasm["runs"][0]["count"],
            "runs": wasm["runs"],
        },
        "budgets": {
            "timing": check_budgets.Budgets()._asdict(),
            "wasm": check_wasm_budgets.Budgets()._asdict(),
        },
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=REPOSITORY / "results")
    parser.add_argument("--output", type=Path, default=REPOSITORY / "web" / "data" / "results.json")
    arguments = parser.parse_args(argv)
    text = json.dumps(build(arguments.results), separators=(",", ":")) + "\n"
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
