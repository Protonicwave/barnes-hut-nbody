import json
from pathlib import Path

import pytest

import export_page_data

DRIFT_HEADER = "method,theta,timestep,softening_scale,time,relative_energy_error\n"


def write_results(directory: Path, drift_rows: str) -> None:
    (directory / "timing.json").write_text(
        json.dumps([{"method": "tree", "count": 1024, "threads": 8, "median_ms": 1.5}]),
        encoding="utf-8",
    )
    (directory / "wasm_timing.json").write_text(
        json.dumps(
            {
                "node": "v1",
                "runs": [{"platform": "native", "threads": 1, "count": 16384, "median_ms": 2.0}],
            }
        ),
        encoding="utf-8",
    )
    (directory / "machine.txt").write_text(
        "cpu=Test CPU\nphysical_cores=6\ncore_mix=2 big and 4 small\nother=x\n", encoding="utf-8"
    )
    (directory / "force_error.csv").write_text(
        "theta,median,p90,p99,max\n0.5,1.234567e-03,2e-3,5.6789e-03,1e-2\n", encoding="utf-8"
    )
    (directory / "energy_drift.csv").write_text(DRIFT_HEADER + drift_rows, encoding="utf-8")


DRIFT_ROWS = (
    "direct,,0.0078125,4,0,0.000000e+00\n"
    "direct,,0.0078125,4,0.125,1.234567e-06\n"
    "tree,0.5,0.0078125,4,0.125,2.345678e-04\n"
    "tree,0.3,0.0078125,4,0.125,1e-05\n"
    "tree,0.4,0.0078125,4,0.125,9e-05\n"
    "tree,0.5,0.015625,4,0.125,9e-04\n"
    "tree,0.5,0.0078125,2,0.125,8e-04\n"
)


FULL_ROWS = "tree,0.7,0.0078125,4,0.125,3e-04\ntree,1,0.0078125,4,0.125,4e-04\n"


def test_rejects_a_drift_file_missing_a_drawn_curve(tmp_path: Path) -> None:
    write_results(tmp_path, DRIFT_ROWS)

    with pytest.raises(ValueError, match="no reference run"):
        export_page_data.build(tmp_path)


def test_builds_every_section_from_the_results(tmp_path: Path) -> None:
    write_results(tmp_path, DRIFT_ROWS + FULL_ROWS)

    data = export_page_data.build(tmp_path)

    assert data["machine"] == {
        "cpu": "Test CPU",
        "physicalCores": 6,
        "coreMix": "2 big and 4 small",
    }
    assert data["timing"][0]["median_ms"] == 1.5
    assert data["forceError"]["rows"] == [{"theta": 0.5, "median": 1.235e-3, "p99": 5.679e-3}]
    assert data["wasm"]["count"] == 16384
    assert data["budgets"]["timing"]["max_tree_ms"] > 0
    assert data["budgets"]["wasm"]["max_threaded_ratio"] > 0


def test_keeps_only_the_reference_run_and_the_drawn_angles(tmp_path: Path) -> None:
    write_results(tmp_path, DRIFT_ROWS + FULL_ROWS)

    curves = export_page_data.build(tmp_path)["drift"]["curves"]

    assert [(curve["method"], curve["theta"]) for curve in curves] == [
        ("direct", None),
        ("tree", 0.3),
        ("tree", 0.5),
        ("tree", 0.7),
        ("tree", 1.0),
    ]
    assert curves[0]["points"] == [[0.0, 0.0], [0.125, 1.235e-06]]
    assert curves[2]["points"] == [[0.125, 2.346e-04]]


def test_main_writes_the_file_and_creates_its_directory(tmp_path: Path) -> None:
    write_results(tmp_path, DRIFT_ROWS + FULL_ROWS)
    output = tmp_path / "out" / "results.json"

    status = export_page_data.main(["--results", str(tmp_path), "--output", str(output)])

    assert status == 0
    assert json.loads(output.read_text(encoding="utf-8"))["machine"]["physicalCores"] == 6


def test_committed_page_data_matches_the_committed_results() -> None:
    repository = export_page_data.REPOSITORY
    expected = (
        json.dumps(export_page_data.build(repository / "results"), separators=(",", ":")) + "\n"
    )

    committed = (repository / "web" / "data" / "results.json").read_text(encoding="utf-8")

    assert committed == expected, "run python scripts/export_page_data.py"


def test_rejects_results_missing_a_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        export_page_data.build(tmp_path)


def test_rejects_a_machine_file_without_a_core_mix(tmp_path: Path) -> None:
    machine = tmp_path / "machine.txt"
    machine.write_text("cpu=Test CPU\nphysical_cores=6\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"machine.txt has no core_mix line"):
        export_page_data.read_machine(machine)
