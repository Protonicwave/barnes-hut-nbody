import csv
import json
from pathlib import Path

import pytest

import plot_results

COUNTS = (1024, 65536)
THREADS = (1, 2, 4, 8)
THETAS = (0.2, 0.3, 0.5, 0.7, 1.0)
DRIFT_TIMES = (0.0, 0.125, 0.25)


def timing_rows() -> list[dict[str, float | str]]:
    rows: list[dict[str, float | str]] = []
    for count in COUNTS:
        for method in ("direct", "tree"):
            rows.append({"method": method, "count": count, "threads": 8, "median_ms": count / 100})
    for threads in THREADS:
        rows.append(
            {"method": "tree", "count": 65536, "threads": threads, "median_ms": 800.0 / threads}
        )
    return rows


def drift_rows() -> list[list[str]]:
    rows = []
    reference_step = 1 / 128
    curves = [("direct", "", step) for step in plot_results.TIMESTEPS]
    curves += [("tree", str(theta), reference_step) for theta in (0.3, 0.7, 1.0)]
    curves += [("tree", "0.5", step) for step in plot_results.TIMESTEPS]
    for method, theta, step in curves:
        for time in DRIFT_TIMES:
            rows.append([method, theta, str(step), "4", str(time), str(1e-6 * time)])
    return rows


def write_results(directory: Path, drift: list[list[str]] | None = None) -> None:
    (directory / "timing.json").write_text(json.dumps(timing_rows()), encoding="utf-8")
    with (directory / "force_error.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["theta", "median", "p90", "p99", "max"])
        for theta in THETAS:
            writer.writerow([theta, 1e-3 * theta, 2e-3 * theta, 5e-3 * theta, 1e-2 * theta])
    with (directory / "energy_drift.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["method", "theta", "timestep", "softening_scale", "time", "relative_energy_error"]
        )
        writer.writerows(drift_rows() if drift is None else drift)


def test_writes_every_figure(tmp_path: Path) -> None:
    write_results(tmp_path)
    assert plot_results.main(["--results", str(tmp_path)]) == 0
    for name in ("speed", "scaling", "force_error", "energy_drift"):
        assert (tmp_path / f"{name}.png").stat().st_size > 1000, name


def test_missing_timing_series_names_what_is_missing(tmp_path: Path) -> None:
    rows = [row for row in timing_rows() if row["method"] != "direct"]
    with pytest.raises(ValueError, match="no direct timings"):
        plot_results.plot_speed(rows, tmp_path / "speed.png")


def test_missing_drift_curve_names_what_is_missing(tmp_path: Path) -> None:
    write_results(tmp_path, drift=[row for row in drift_rows() if row[0] != "direct"])
    with pytest.raises(ValueError, match="no direct drift curve"):
        plot_results.plot_energy_drift(tmp_path / "energy_drift.csv", tmp_path / "out.png")


def test_drift_curves_drop_the_zero_error_start(tmp_path: Path) -> None:
    write_results(tmp_path)
    curves = plot_results.load_drift(tmp_path / "energy_drift.csv")
    times, errors = curves[("tree", 0.3, 1 / 128, 4.0)]
    assert times == [0.125, 0.25]
    assert errors == [1.25e-7, 2.5e-7]


def test_missing_results_directory_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        plot_results.main(["--results", str(tmp_path / "absent")])
