import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import check_budgets
from check_budgets import Budgets

CASE_TIMES_MS = {
    ("direct", 4096, 8): 4.0,
    ("direct", 65536, 8): 800.0,
    ("tree", 4096, 8): 2.0,
    ("tree", 65536, 8): 50.0,
    ("tree", 65536, 1): 350.0,
    ("tree", 65536, 4): 100.0,
    ("direct", 1024, 8): 1.0,
    ("tree", 1024, 8): 2.0,
}


def gbench_json(times_ms: dict, unit: str = "ms") -> str:
    scale = {"ms": 1.0, "us": 1e3}[unit]
    entries = []
    for (method, count, threads), median_ms in times_ms.items():
        run_name = f"Force/{method}/{count}/{threads}/real_time"
        entries.append({"run_name": run_name, "name": run_name + "_median",
                        "run_type": "aggregate", "aggregate_name": "median",
                        "real_time": median_ms * scale, "time_unit": unit})
        entries.append({"run_name": run_name, "name": run_name + "_mean",
                        "run_type": "aggregate", "aggregate_name": "mean",
                        "real_time": 1e9, "time_unit": unit})
    entries.append({"run_name": "Other/1", "name": "Other/1_median", "run_type": "aggregate",
                    "aggregate_name": "median", "real_time": 1.0, "time_unit": "ms"})
    entries.append({"run_name": "Force/tree/1/1/real_time", "name": "Force/tree/1/1/real_time",
                    "run_type": "iteration", "real_time": 1.0, "time_unit": "ms"})
    return json.dumps({"context": {"host_name": "private"}, "benchmarks": entries})


def drift_csv(tree_error: float, direct_error: float) -> str:
    rows = ["method,theta,timestep,softening_scale,time,relative_energy_error"]
    rows.append(f"tree,0.5,0.0078125,4.0,1.0,{tree_error / 2}")
    rows.append(f"tree,0.5,0.0078125,4.0,2.0,{tree_error}")
    rows.append(f"direct,,0.0078125,4.0,2.0,{direct_error}")
    rows.append("tree,0.5,0.015625,4.0,2.0,1.0")
    rows.append("tree,0.3,0.0078125,4.0,2.0,1.0")
    rows.append("tree,0.5,0.0078125,2.0,2.0,1.0")
    return "\n".join(rows) + "\n"


class CheckBudgetsTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.machine = self.directory / "machine.txt"
        self.machine.write_text("cpu=Test\nphysical_cores=4\n")

    def write(self, name: str, text: str) -> Path:
        path = self.directory / name
        path.write_text(text)
        return path

    def run_main(self, arguments: list[str], budgets: Budgets = Budgets()) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = check_budgets.main(arguments, budgets)
        return status, output.getvalue()

    def test_passes_when_every_figure_is_within_its_budget(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        drift = self.write("drift.csv", drift_csv(1e-4, 5e-6))
        status, output = self.run_main(
            [str(timing), "--machine", str(self.machine), "--drift", str(drift)])
        self.assertEqual(status, 0)
        self.assertNotIn("OVER", output)
        self.assertIn("tree speedup over direct, N=65536, 8 threads: 16", output)

    def test_fails_when_the_speedup_is_under_budget(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        status, output = self.run_main(
            [str(timing), "--machine", str(self.machine)],
            Budgets(min_speedup_over_direct=20.0))
        self.assertEqual(status, 1)
        self.assertIn("OVER tree speedup over direct", output)

    def test_fails_when_the_tree_is_slower_than_direct_at_a_large_count(self) -> None:
        times = dict(CASE_TIMES_MS)
        times[("tree", 4096, 8)] = 9.0
        timing = self.write("timing.json", gbench_json(times))
        status, output = self.run_main([str(timing), "--machine", str(self.machine)])
        self.assertEqual(status, 1)
        self.assertIn("OVER smallest direct/tree time ratio", output)

    def test_ignores_counts_below_the_threshold_when_comparing_with_direct(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        status, _ = self.run_main([str(timing), "--machine", str(self.machine)])
        self.assertEqual(status, 0)

    def test_fails_when_the_evaluation_time_is_over_budget(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        status, output = self.run_main(
            [str(timing), "--machine", str(self.machine)], Budgets(max_tree_ms=40.0))
        self.assertEqual(status, 1)
        self.assertIn("OVER tree evaluation ms", output)

    def test_fails_when_scaling_is_under_budget(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        status, output = self.run_main(
            [str(timing), "--machine", str(self.machine)],
            Budgets(min_scaling_efficiency=0.95))
        self.assertEqual(status, 1)
        self.assertIn("OVER tree speedup, 1 to 4 threads", output)

    def test_fails_when_drift_is_over_budget(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        drift = self.write("drift.csv", drift_csv(2e-3, 5e-6))
        status, output = self.run_main(
            [str(timing), "--machine", str(self.machine), "--drift", str(drift)])
        self.assertEqual(status, 1)
        self.assertIn("OVER max relative energy error, tree", output)

    def test_reads_other_time_units(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS, unit="us"))
        status, _ = self.run_main([str(timing), "--machine", str(self.machine)])
        self.assertEqual(status, 0)

    def test_stops_when_a_needed_median_is_missing(self) -> None:
        times = dict(CASE_TIMES_MS)
        del times[("tree", 65536, 4)]
        timing = self.write("timing.json", gbench_json(times))
        with self.assertRaisesRegex(SystemExit, "tree at 65536 particles on 4 threads"):
            self.run_main([str(timing), "--machine", str(self.machine)])

    def test_stops_when_the_machine_file_has_no_core_count(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        self.machine.write_text("cpu=Test\n")
        with self.assertRaisesRegex(SystemExit, "no physical_cores"):
            self.run_main([str(timing), "--machine", str(self.machine)])

    def test_stops_when_the_drift_file_lacks_the_reference_run(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        drift = self.write(
            "drift.csv",
            "method,theta,timestep,softening_scale,time,relative_energy_error\n")
        with self.assertRaisesRegex(SystemExit, "no reference run for tree"):
            self.run_main([str(timing), "--machine", str(self.machine), "--drift", str(drift)])

    def test_summary_keeps_the_medians_and_drops_the_host_details(self) -> None:
        timing = self.write("timing.json", gbench_json(CASE_TIMES_MS))
        summary = self.directory / "summary.json"
        self.run_main([str(timing), "--machine", str(self.machine), "--summary", str(summary)])
        text = summary.read_text()
        self.assertNotIn("private", text)
        rows = json.loads(text)
        self.assertEqual(len(rows), len(CASE_TIMES_MS))
        self.assertIn({"method": "tree", "count": 65536, "threads": 8, "median_ms": 50.0}, rows)


if __name__ == "__main__":  # pragma: no cover - lets the file run directly
    unittest.main()
