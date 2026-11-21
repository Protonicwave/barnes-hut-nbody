"""Draws the README figures from the committed results.

Reads timing.json, force_error.csv and energy_drift.csv from the results
directory and writes speed.png, scaling.png, force_error.png and
energy_drift.png beside them, each with a -dark variant for dark pages.
Amber is the tree and slate is direct
summation. Needs matplotlib.
"""

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.figure import Figure


@dataclass(frozen=True, slots=True)
class Palette:
    """Colours of one figure variant. `thetas` runs from the smallest opening angle up."""

    page: str
    ink: str
    ink_muted: str
    grid: str
    spine: str
    direct: str
    tree: str
    tree_soft: str
    thetas: tuple[str, str, str, str]


LIGHT = Palette(
    page="#fbfcfd",
    ink="#131b26",
    ink_muted="#5c646e",
    grid="#dfe3e8",
    spine="#b9c0c8",
    direct="#364355",
    tree="#bd6700",
    tree_soft="#e4b572",
    thetas=("#e4b572", "#d08a2c", "#bd6700", "#8e4300"),
)
DARK = Palette(
    page="#14181e",
    ink="#e7ecf0",
    ink_muted="#969ca3",
    grid="#2b3138",
    spine="#4e5661",
    direct="#9aa8ba",
    tree="#e8aa4e",
    tree_soft="#a85c00",
    thetas=("#a85c00", "#d08a2c", "#e8aa4e", "#f0c98a"),
)

REFERENCE_COUNT = 65536
REFERENCE_THREADS = 8
REFERENCE_TIMESTEP = 1.0 / 128.0
REFERENCE_SOFTENING_SCALE = 4.0
REFERENCE_THETA = 0.5
# Opening angle and the points its end label is raised by to clear its neighbour.
THETA_LINES = ((0.3, 0.0), (0.5, 0.0), (0.7, 7.0), (1.0, 0.0))
TIMESTEPS = (1.0 / 256.0, 1.0 / 128.0, 1.0 / 64.0)
FIGURE_DPI = 160

Series = tuple[list[float], list[float]]
DriftKey = tuple[str, float, float, float]
TimingRow = dict[str, float | str]


def style_axes(axes: Axes, x_label: str, y_label: str, palette: Palette) -> None:
    axes.set_facecolor(palette.page)
    axes.set_xlabel(x_label, color=palette.ink_muted)
    axes.set_ylabel(y_label, color=palette.ink_muted)
    axes.tick_params(colors=palette.ink_muted, labelsize=9)
    axes.grid(True, color=palette.grid, linewidth=0.6)
    for side in ("top", "right"):
        axes.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        axes.spines[side].set_color(palette.spine)


def label_end(
    axes: Axes, point: tuple[float, float], text: str, colour: str, raise_points: float = 0.0
) -> None:
    axes.annotate(
        text,
        xy=point,
        xytext=(6, raise_points),
        textcoords="offset points",
        va="center",
        fontsize=9,
        color=colour,
        annotation_clip=False,
    )


def draw_line(
    axes: Axes, series: Series, colour: str, label: str, raise_points: float = 0.0
) -> None:
    xs, ys = series
    axes.plot(xs, ys, color=colour, linewidth=1.8)
    label_end(axes, (xs[-1], ys[-1]), label, colour, raise_points)


def new_figure(width: float, palette: Palette, columns: int = 1) -> tuple[Figure, list[Axes]]:
    figure, axes = plt.subplots(
        1,
        columns,
        figsize=(width, 3.8),
        facecolor=palette.page,
        layout="constrained",
        squeeze=False,
    )
    return figure, list(axes[0])


def save(figure: Figure, path: Path, palette: Palette) -> None:
    figure.savefig(path, dpi=FIGURE_DPI, facecolor=palette.page)
    plt.close(figure)


def timing_series(rows: Sequence[TimingRow], method: str, key: str, **fixed: float) -> Series:
    """Median milliseconds against `key` for the rows of one method matching `fixed`."""
    picked = sorted(
        (float(row[key]), float(row["median_ms"]))
        for row in rows
        if row["method"] == method and all(row[name] == value for name, value in fixed.items())
    )
    if not picked:
        raise ValueError(f"no {method} timings with {fixed} in the timing data")
    return [x for x, _ in picked], [y for _, y in picked]


def plot_speed(rows: Sequence[TimingRow], path: Path, palette: Palette = LIGHT) -> None:
    figure, (axes,) = new_figure(6.4, palette)
    for method, colour in (("direct", palette.direct), ("tree", palette.tree)):
        series = timing_series(rows, method, "count", threads=REFERENCE_THREADS)
        draw_line(axes, series, colour, method)
    axes.set_xscale("log", base=2)
    axes.set_yscale("log")
    style_axes(
        axes, "particles N", f"time per force evaluation (ms), {REFERENCE_THREADS} threads", palette
    )
    save(figure, path, palette)


def plot_scaling(rows: Sequence[TimingRow], path: Path, palette: Palette = LIGHT) -> None:
    threads, times = timing_series(rows, "tree", "threads", count=REFERENCE_COUNT)
    figure, (axes,) = new_figure(4.8, palette)
    axes.plot(threads, threads, "--", color=palette.ink_muted, linewidth=1.2)
    label_end(axes, (threads[-1], threads[-1]), "ideal", palette.ink_muted)
    draw_line(axes, (threads, [times[0] / time for time in times]), palette.tree, "tree")
    axes.set_xscale("log", base=2)
    axes.set_xticks(threads, [str(int(count)) for count in threads])
    style_axes(axes, "threads", f"speedup over one thread, N = {REFERENCE_COUNT}", palette)
    save(figure, path, palette)


def plot_force_error(path_in: Path, path_out: Path, palette: Palette = LIGHT) -> None:
    with path_in.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    thetas = [float(row["theta"]) for row in rows]
    figure, (axes,) = new_figure(6.4, palette)
    p99 = [float(row["p99"]) for row in rows]
    draw_line(axes, (thetas, p99), palette.tree_soft, "99th percentile")
    draw_line(axes, (thetas, [float(row["median"]) for row in rows]), palette.tree, "median")
    axes.set_yscale("log")
    style_axes(axes, "opening angle θ", "relative force error against direct summation", palette)
    save(figure, path_out, palette)


def load_drift(path: Path) -> dict[DriftKey, Series]:
    """Curves keyed by method, theta (0 for direct), timestep and softening scale.

    The initial row has zero error, which a log axis cannot show, so it is dropped.
    """
    curves: dict[DriftKey, Series] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            key = (
                row["method"],
                float(row["theta"] or 0.0),
                float(row["timestep"]),
                float(row["softening_scale"]),
            )
            xs, ys = curves.setdefault(key, ([], []))
            if float(row["time"]) > 0.0:
                xs.append(float(row["time"]))
                ys.append(float(row["relative_energy_error"]))
    return curves


def drift_curve(
    curves: dict[DriftKey, Series], method: str, theta: float, timestep: float
) -> Series:
    key = (method, theta if method == "tree" else 0.0, timestep, REFERENCE_SOFTENING_SCALE)
    if key not in curves:
        raise ValueError(f"no {method} drift curve for theta {key[1]} and timestep {timestep}")
    return curves[key]


def plot_energy_drift(path_in: Path, path_out: Path, palette: Palette = LIGHT) -> None:
    curves = load_drift(path_in)
    figure, (theta_axes, step_axes) = new_figure(10.4, palette, columns=2)
    direct = drift_curve(curves, "direct", 0.0, REFERENCE_TIMESTEP)
    draw_line(theta_axes, direct, palette.direct, "direct", raise_points=-7)
    for (theta, raise_points), shade in zip(THETA_LINES, palette.thetas, strict=True):
        draw_line(
            theta_axes,
            drift_curve(curves, "tree", theta, REFERENCE_TIMESTEP),
            shade,
            f"θ {theta}",
            raise_points=raise_points,
        )
    for method, colour in (("direct", palette.direct), ("tree", palette.tree)):
        worst = [max(drift_curve(curves, method, REFERENCE_THETA, step)[1]) for step in TIMESTEPS]
        draw_line(step_axes, (list(TIMESTEPS), worst), colour, method)
    step_axes.set_xscale("log", base=2)
    step_axes.set_xticks(TIMESTEPS, [f"1/{round(1 / step)}" for step in TIMESTEPS])
    step_axes.minorticks_off()
    style_axes(theta_axes, "time (N-body units)", "relative energy error", palette)
    style_axes(step_axes, "timestep dt", "largest relative energy error", palette)
    for axes in (theta_axes, step_axes):
        axes.set_yscale("log")
    theta_axes.set_title("opening angle, dt 1/128", color=palette.ink, fontsize=10, loc="left")
    step_axes.set_title("timestep, θ 0.5", color=palette.ink, fontsize=10, loc="left")
    save(figure, path_out, palette)


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--results",
        type=Path,
        default=Path("results"),
        help="directory holding the data, and receiving the figures",
    )
    results: Path = parser.parse_args(argv).results

    rows: list[TimingRow] = json.loads((results / "timing.json").read_text(encoding="utf-8"))
    for suffix, palette in (("", LIGHT), ("-dark", DARK)):
        plot_speed(rows, results / f"speed{suffix}.png", palette)
        plot_scaling(rows, results / f"scaling{suffix}.png", palette)
        plot_force_error(results / "force_error.csv", results / f"force_error{suffix}.png", palette)
        plot_energy_drift(
            results / "energy_drift.csv", results / f"energy_drift{suffix}.png", palette
        )
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
