import io
import json
from pathlib import Path

import pytest
from PIL import GifImagePlugin, Image

import encode_display_clip as encoder

SIZE = (48, 32)


def noise_image(seed: int) -> Image.Image:
    """A frame of pseudo-random pixels, so that each frame differs and compresses poorly."""
    image = Image.new("RGB", SIZE)
    state = seed * 7919 + 1
    pixels = []
    for _ in range(SIZE[0] * SIZE[1]):
        state = (state * 1103515245 + 12345) % 2**31
        pixels.append((state % 256, (state >> 8) % 256, (state >> 16) % 256))
    image.putdata(pixels)
    return image


def write_frames(directory: Path, times: list[float]) -> list[tuple[Path, float]]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    for number, time in enumerate(times, start=1):
        name = f"frame-{number:04d}.png"
        noise_image(number).save(directory / name)
        frames.append((directory / name, time))
    entries = [{"file": path.name, "time": time} for path, time in frames]
    (directory / "frames.json").write_text(json.dumps(entries), encoding="utf-8")
    return frames


def test_select_frames_picks_the_nearest_frame_at_each_interval() -> None:
    times = [0.0, 0.011, 0.019, 0.041, 0.06]

    assert encoder.select_frames(times, 0.02) == [0, 2, 3, 4]


def test_select_frames_with_one_frame_returns_it() -> None:
    assert encoder.select_frames([1.5], 0.02) == [0]


def test_select_frames_takes_the_first_of_equal_times() -> None:
    assert encoder.select_frames([0.0, 0.0, 0.0, 0.04, 0.04], 0.02) == [0, 0, 3]


def test_select_frames_repeats_the_nearest_frame_across_a_gap() -> None:
    assert encoder.select_frames([0.0, 0.1], 0.02) == [0, 0, 0, 1, 1, 1]


def test_select_frames_rejects_a_non_positive_interval() -> None:
    with pytest.raises(ValueError, match="interval"):
        encoder.select_frames([0.0, 1.0], 0.0)


def test_read_manifest_returns_paths_and_times(tmp_path: Path) -> None:
    expected = write_frames(tmp_path, [0.0, 0.5, 0.5])

    assert encoder.read_manifest(tmp_path) == expected


def test_read_manifest_rejects_an_empty_list(tmp_path: Path) -> None:
    (tmp_path / "frames.json").write_text("[]", encoding="utf-8")

    with pytest.raises(ValueError, match="no frames"):
        encoder.read_manifest(tmp_path)


def test_read_manifest_rejects_a_missing_frame_file(tmp_path: Path) -> None:
    write_frames(tmp_path, [0.0, 0.1])
    (tmp_path / "frame-0002.png").unlink()

    with pytest.raises(ValueError, match=r"entry 1.*frame-0002\.png"):
        encoder.read_manifest(tmp_path)


@pytest.mark.parametrize("time", ["NaN", "Infinity", "-Infinity"])
def test_read_manifest_rejects_a_non_finite_time(tmp_path: Path, time: str) -> None:
    write_frames(tmp_path, [0.0, 0.1])
    text = (tmp_path / "frames.json").read_text(encoding="utf-8")
    (tmp_path / "frames.json").write_text(text.replace("0.1", time), encoding="utf-8")

    with pytest.raises(ValueError, match=r"entry 1.*finite"):
        encoder.read_manifest(tmp_path)


def test_read_manifest_rejects_a_decreasing_time(tmp_path: Path) -> None:
    write_frames(tmp_path, [0.0, 0.2, 0.1])

    with pytest.raises(ValueError, match=r"entry 2.*before"):
        encoder.read_manifest(tmp_path)


@pytest.mark.parametrize(
    "entry",
    [
        7,
        {"file": "frame-0001.png"},
        {"time": 0.0},
        {"file": 3, "time": 0.0},
        {"file": "frame-0001.png", "time": "0.0"},
        {"file": "frame-0001.png", "time": True},
        {"file": "../frame-0001.png", "time": 0.0},
    ],
)
def test_read_manifest_rejects_a_malformed_entry(tmp_path: Path, entry: object) -> None:
    write_frames(tmp_path, [0.0])
    (tmp_path / "frames.json").write_text(json.dumps([entry]), encoding="utf-8")

    with pytest.raises(ValueError, match="entry 0"):
        encoder.read_manifest(tmp_path)


def test_read_manifest_rejects_a_top_level_object(tmp_path: Path) -> None:
    (tmp_path / "frames.json").write_text("{}", encoding="utf-8")

    with pytest.raises(ValueError, match="list"):
        encoder.read_manifest(tmp_path)


def test_encode_gif_writes_a_looping_gif_of_the_given_length_and_delay() -> None:
    gif = encoder.encode_gif([noise_image(1), noise_image(2), noise_image(3)], 5)

    with Image.open(io.BytesIO(gif)) as read_back:
        assert isinstance(read_back, GifImagePlugin.GifImageFile)
        assert read_back.n_frames == 3
        assert read_back.info["loop"] == 0
        assert read_back.info["duration"] == 50
        assert read_back.size == SIZE


def column_ramp(shift: int) -> Image.Image:
    """A frame of 300 columns, each one colour and no two alike, so that a palette of
    256 entries cannot hold them all."""
    width = 300
    image = Image.new("RGB", (width, 8))
    row = [((x + shift) % 256, (x * 7) % 256, x // 2) for x in range(width)]
    image.putdata(row * 8)
    return image


def read_back_frames(gif: bytes) -> list[Image.Image]:
    frames = []
    with Image.open(io.BytesIO(gif)) as read_back:
        for number in range(read_back.n_frames):
            read_back.seek(number)
            frames.append(read_back.convert("RGB"))
    return frames


def test_encode_gif_draws_a_shared_colour_alike_in_every_frame() -> None:
    first, second = column_ramp(0), column_ramp(40)
    second.paste(first.crop((0, 0, 20, 8)))

    frames = read_back_frames(encoder.encode_gif([first, second], 5))

    assert frames[0].crop((0, 0, 20, 8)).tobytes() == frames[1].crop((0, 0, 20, 8)).tobytes()


def test_fit_clip_returns_the_fastest_rate_within_the_limit(tmp_path: Path) -> None:
    frames = write_frames(tmp_path, [i * 0.005 for i in range(40)])

    clip = encoder.fit_clip(frames, 10**9)

    assert clip.delay_cs == encoder.FRAME_DELAYS_CS[0]
    assert clip.frame_indices == encoder.select_frames(
        [time for _, time in frames], encoder.FRAME_DELAYS_CS[0] / 100 * encoder.SIM_TIME_PER_SECOND
    )
    assert len(clip.gif) <= 10**9


def test_fit_clip_drops_to_a_slower_rate_when_the_fastest_is_over(tmp_path: Path) -> None:
    frames = write_frames(tmp_path, [i * 0.005 for i in range(40)])
    fastest = encoder.fit_clip(frames, 10**9)
    slowest = encoder.fit_clip(frames, 10**9, delays_cs=(encoder.FRAME_DELAYS_CS[-1],))

    clip = encoder.fit_clip(frames, (len(fastest.gif) + len(slowest.gif)) // 2)

    assert clip.delay_cs > encoder.FRAME_DELAYS_CS[0]
    assert len(clip.gif) < len(fastest.gif)


def test_fit_clip_rejects_an_empty_list_of_delays(tmp_path: Path) -> None:
    frames = write_frames(tmp_path, [0.0, 0.1])

    with pytest.raises(ValueError, match="empty"):
        encoder.fit_clip(frames, 10**9, delays_cs=())


def test_fit_clip_raises_naming_the_smallest_size_when_none_fits(tmp_path: Path) -> None:
    frames = write_frames(tmp_path, [i * 0.005 for i in range(40)])
    slowest = encoder.fit_clip(frames, 10**9, delays_cs=(encoder.FRAME_DELAYS_CS[-1],))

    with pytest.raises(encoder.ClipOverLimit) as raised:
        encoder.fit_clip(frames, 1)

    assert raised.value.smallest_bytes == len(slowest.gif)
    assert str(len(slowest.gif)) in str(raised.value)


def test_main_writes_the_gif_and_the_still_and_exits_zero(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    frames = tmp_path / "frames"
    write_frames(frames, [i * 0.005 for i in range(40)])
    out = tmp_path / "out"

    status = encoder.main([str(frames), str(out)])

    assert status == 0
    assert (out / "collapse.gif").stat().st_size > 0
    with Image.open(out / "collapse-still.png") as still:
        assert still.size == SIZE
    assert "ok" in capsys.readouterr().out


def test_main_exits_one_and_writes_nothing_when_over_the_limit(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    frames = tmp_path / "frames"
    write_frames(frames, [i * 0.005 for i in range(40)])
    out = tmp_path / "out"

    status = encoder.main([str(frames), str(out)], limit_bytes=1)

    assert status == 1
    assert not out.exists()
    assert "OVER" in capsys.readouterr().out


def test_main_exits_two_on_a_bad_manifest(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "frames.json").write_text("[]", encoding="utf-8")

    status = encoder.main([str(tmp_path), str(tmp_path / "out")])

    assert status == 2
    assert "no frames" in capsys.readouterr().err


def test_main_exits_two_when_the_manifest_is_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    status = encoder.main([str(tmp_path), str(tmp_path / "out")])

    assert status == 2
    assert "frames.json" in capsys.readouterr().err


def test_main_exits_two_on_wrong_usage() -> None:
    with pytest.raises(SystemExit) as raised:
        encoder.main(["only-one"])

    assert raised.value.code == 2
