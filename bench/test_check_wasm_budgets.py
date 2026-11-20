import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Sequence
from pathlib import Path

import check_wasm_budgets
from check_wasm_budgets import Budgets

# Milliseconds a fake kernel_timing reports, keyed by program and thread count.
TIMES_MS = {
    ("native", "1"): 100.0,
    ("native", "8"): 20.0,
    ("single.js", "1"): 150.0,
    ("threads.js", "8"): 40.0,
}
ARGUMENTS = ["--native", "native", "--wasm-single", "single.js", "--wasm-threads", "threads.js"]


def fake_runner(command: Sequence[str]) -> float:
    # The last three entries are count, threads and repetitions; the program is before them.
    return TIMES_MS[(Path(command[-4]).name, command[-2])]


def run_main(extra: list[str], budgets: Budgets = Budgets()) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        status = check_wasm_budgets.main(
            ARGUMENTS + extra, budgets, fake_runner, lambda node: f"{node} v0"
        )
    return status, output.getvalue()


class CheckWasmBudgetsTests(unittest.TestCase):
    def test_passes_within_budgets_and_prints_each_figure(self) -> None:
        status, output = run_main([])
        self.assertEqual(status, 0)
        self.assertIn("1.5 (budget <= 2.5)", output)
        self.assertIn("2 (budget <= 3)", output)

    def test_fails_when_the_single_thread_ratio_is_over(self) -> None:
        status, output = run_main([], Budgets(max_single_thread_ratio=1.2))
        self.assertEqual(status, 1)
        self.assertIn("OVER Wasm single-threaded", output)
        self.assertIn("ok   Wasm threaded", output)

    def test_fails_when_the_threaded_ratio_is_over(self) -> None:
        status, output = run_main([], Budgets(max_threaded_ratio=1.5))
        self.assertEqual(status, 1)
        self.assertIn("OVER Wasm threaded", output)

    def test_writes_the_medians_and_node_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "wasm_timing.json")
            run_main(["--node", "node26", "--summary", str(path)])
            summary = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(summary["node"], "node26 v0")
        self.assertIn(
            {"platform": "wasm-threads", "threads": 8, "count": 16384, "median_ms": 40.0},
            summary["runs"],
        )
        self.assertEqual(len(summary["runs"]), 4)

    def test_runs_each_kernel_with_count_threads_and_repetitions(self) -> None:
        commands = []

        def recording_runner(command: Sequence[str]) -> float:
            commands.append(list(command))
            return 1.0

        check_wasm_budgets.measure(
            Path("native"), Path("single.js"), Path("threads.js"), "node", recording_runner
        )
        self.assertEqual(
            commands,
            [
                ["native", "16384", "1", "5"],
                ["native", "16384", "8", "5"],
                ["node", "single.js", "16384", "1", "5"],
                ["node", "threads.js", "16384", "8", "5"],
            ],
        )

    def test_run_kernel_reads_the_median_from_the_printed_json(self) -> None:
        script = 'import json; print(json.dumps({"median_ms": 12.5}))'
        self.assertEqual(check_wasm_budgets.run_kernel([sys.executable, "-c", script]), 12.5)

    def test_run_kernel_raises_when_the_kernel_fails(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            check_wasm_budgets.run_kernel([sys.executable, "-c", "raise SystemExit(2)"])

    def test_node_version_is_the_trimmed_output(self) -> None:
        self.assertTrue(check_wasm_budgets.node_version(sys.executable).startswith("Python"))

