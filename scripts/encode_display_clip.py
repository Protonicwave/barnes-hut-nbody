"""Encode recorded display frames into a looping GIF no larger than a size limit.

The frames directory holds the PNG frames and a `frames.json` manifest listing each
frame's file name and simulated time. Frames are picked at even steps of simulated
time, so the GIF plays at an even pace whatever rate the frames were captured at.

Exit status: 0 on success, 1 when no frame rate fits the limit (nothing is written),
2 on a bad manifest or bad usage.
"""

import argparse
import io
import json
import math
import shutil
import sys
from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

MANIFEST_NAME = "frames.json"
GIF_NAME = "collapse.gif"
STILL_NAME = "collapse-still.png"
MAX_GIF_BYTES = 4096 * 1024
PALETTE_COLOURS = 256
# Frames held in memory for one GIF, about 0.9 MB each at the size of the glass: 3 time
# units at 25 frames per second take 151.
MAX_CLIP_FRAMES = 600
# Frame delays in centiseconds, fastest first: 25, 20, 16.7, 12.5 and 10 frames per second.
FRAME_DELAYS_CS = (4, 5, 6, 8, 10)
# Simulated time units that pass in one second of playback.
SIM_TIME_PER_SECOND = 0.5
# Absorbs float error when counting how many whole intervals fit in the recorded span.
INTERVAL_COUNT_TOLERANCE = 1e-9


class ClipOverLimit(Exception):  # noqa: N818 - names the outcome, not an error type
    """No frame rate produced a GIF within the limit."""

    def __init__(self, smallest_bytes: int, smallest_delay_cs: int, limit_bytes: int) -> None:
        super().__init__(
            f"smallest GIF is {smallest_bytes} bytes at {smallest_delay_cs} cs per frame,"
            f" over the limit of {limit_bytes} bytes"
        )
        self.smallest_bytes = smallest_bytes
        self.smallest_delay_cs = smallest_delay_cs
        self.limit_bytes = limit_bytes


@dataclass(frozen=True, slots=True)
class Clip:
    gif: bytes
    delay_cs: int
    frame_indices: list[int]


def _parse_entry(directory: Path, number: int, entry: object) -> tuple[Path, float]:
    if not isinstance(entry, dict):
        raise ValueError(f"entry {number}: expected an object, got {entry!r}")
    name = entry.get("file")
    time = entry.get("time")
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError(f"entry {number}: expected a file name, got {name!r}")
    if isinstance(time, bool) or not isinstance(time, int | float):
        raise ValueError(f"entry {number}: expected a number for time, got {time!r}")
    if not math.isfinite(time):
        raise ValueError(f"entry {number}: expected a finite time, got {time!r}")
    path = directory / name
    if not path.is_file():
        raise ValueError(f"entry {number}: frame file {name} does not exist in {directory}")
    return path, float(time)


def read_manifest(directory: Path) -> list[tuple[Path, float]]:
    """Frames as (path, simulated time) pairs in recorded order.

    Raises ValueError for an empty list, a malformed entry, a missing frame file or a
    time before its predecessor's, and OSError when `frames.json` cannot be read.
    """
    entries = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError(f"expected a list of frames, got {type(entries).__name__}")
    if not entries:
        raise ValueError("no frames in the manifest")
    frames = [_parse_entry(directory, number, entry) for number, entry in enumerate(entries)]
    for number in range(1, len(frames)):
        if frames[number][1] < frames[number - 1][1]:
            raise ValueError(
                f"entry {number}: time {frames[number][1]} is before {frames[number - 1][1]}"
            )
    return frames


def select_frames(times: Sequence[float], interval: float) -> list[int]:
    """Index of the frame nearest each multiple of `interval` from the first time to the last.

    `times` is non-decreasing. Of several frames with the nearest time the first is
    taken, and a gap longer than the interval repeats the nearest frame.
    """
    if interval <= 0:
        raise ValueError(f"expected a positive interval, got {interval}")
    first = times[0]
    count = int((times[-1] - first) / interval + INTERVAL_COUNT_TOLERANCE) + 1
    indices = []
    for step in range(count):
        target = first + step * interval
        above = bisect_left(times, target)
        below_time = times[max(above - 1, 0)]
        above_time = times[min(above, len(times) - 1)]
        nearest = below_time if target - below_time <= above_time - target else above_time
        indices.append(bisect_left(times, nearest))
    return indices


def encode_gif(images: Sequence[Image.Image], delay_cs: int) -> bytes:
    """A looping GIF with `delay_cs` centiseconds per frame and one palette for every frame.

    The palette is taken from the first, middle and last frames. A palette per frame
    would draw an unchanged pixel in a new colour whenever the palette moves, so the
    GIF could not leave it out of the next frame.
    """
    width, height = images[0].size
    samples = (images[0], images[len(images) // 2], images[-1])
    sheet = Image.new("RGB", (width, height * len(samples)))
    for row, sample in enumerate(samples):
        sheet.paste(sample, (0, height * row))
    palette = sheet.quantize(PALETTE_COLOURS, dither=Image.Dither.NONE)
    frames = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
    buffer = io.BytesIO()
    frames[0].save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=delay_cs * 10,
        loop=0,
    )
    return buffer.getvalue()


def _load(paths: Sequence[Path]) -> list[Image.Image]:
    loaded = []
    for path in paths:
        with Image.open(path) as image:
            loaded.append(image.convert("RGB"))
    return loaded


def fit_clip(
    frames: Sequence[tuple[Path, float]],
    limit_bytes: int,
    delays_cs: Sequence[int] = FRAME_DELAYS_CS,
) -> Clip:
    """The GIF at the fastest frame delay in `delays_cs` that is within `limit_bytes`.

    Raises ClipOverLimit, naming the smallest size reached, when none fits, and
    ValueError when `delays_cs` is empty or a rate would need more than MAX_CLIP_FRAMES
    frames.
    """
    times = [time for _, time in frames]
    sizes: list[tuple[int, int]] = []
    for delay_cs in delays_cs:
        indices = select_frames(times, delay_cs / 100 * SIM_TIME_PER_SECOND)
        if len(indices) > MAX_CLIP_FRAMES:
            raise ValueError(
                f"t = {times[0]} to {times[-1]} needs {len(indices)} frames at"
                f" {delay_cs} cs per frame, over the limit of {MAX_CLIP_FRAMES}"
            )
        gif = encode_gif(_load([frames[index][0] for index in indices]), delay_cs)
        if len(gif) <= limit_bytes:
            return Clip(gif, delay_cs, indices)
        sizes.append((len(gif), delay_cs))
    smallest_bytes, smallest_delay_cs = min(sizes)
    raise ClipOverLimit(smallest_bytes, smallest_delay_cs, limit_bytes)


def _report(size_bytes: int, delay_cs: int, limit_bytes: int, verdict: str) -> str:
    return (
        f"{GIF_NAME} {size_bytes / 1024:.0f} KiB at {100 / delay_cs:.1f} fps"
        f"  limit {limit_bytes / 1024:.0f} KiB  {verdict}"
    )


def main(argv: Sequence[str], limit_bytes: int = MAX_GIF_BYTES) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("frames", type=Path, help="directory holding the frames and frames.json")
    parser.add_argument("output", type=Path, help="directory to write the GIF and the still to")
    arguments = parser.parse_args(argv)

    try:
        frames = read_manifest(arguments.frames)
        clip = fit_clip(frames, limit_bytes)
    except ClipOverLimit as over:
        print(_report(over.smallest_bytes, over.smallest_delay_cs, limit_bytes, "OVER"))
        return 1
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    arguments.output.mkdir(parents=True, exist_ok=True)
    (arguments.output / GIF_NAME).write_bytes(clip.gif)
    middle = clip.frame_indices[len(clip.frame_indices) // 2]
    shutil.copyfile(frames[middle][0], arguments.output / STILL_NAME)
    print(_report(len(clip.gif), clip.delay_cs, limit_bytes, "ok"))
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
