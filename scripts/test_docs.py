import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DOCUMENTS = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
TABLE_THREADS = 8

FENCE = re.compile(r"^(```|~~~).*?^\1[ \t]*$", re.DOTALL | re.MULTILINE)
INDENTED_CODE = re.compile(r"^(?: {4}|\t).*$", re.MULTILINE)
CODE_SPAN = re.compile(r"`[^`\n]*`")
BACKTICK_MATHS = re.compile(r"\$`.*?`\$")
PLAIN_MATHS = re.compile(r"\$([^$\n]+)\$")
LINK_TARGET = re.compile(r"\]\(([^)\s]+)")
ATTRIBUTE_TARGET = re.compile(r"""\b(?:src|href|srcset)\s*=\s*["']([^"']+)["']""")
TABLE_HEADER = re.compile(r"^\|\s*N\s*\|\s*direct \(ms\)\s*\|\s*tree \(ms\)\s*\|\s*$", re.MULTILINE)
EXTERNAL = ("http://", "https://", "mailto:", "#")


def prose(text: str) -> str:
    """Text with fenced and indented code removed, as a Markdown renderer would not parse it."""
    return INDENTED_CODE.sub("", FENCE.sub("", text))


def relative_targets(text: str) -> list[str]:
    """Relative link, src and srcset targets in the text, outside code."""
    markup = prose(text)
    targets = LINK_TARGET.findall(markup) + ATTRIBUTE_TARGET.findall(markup)
    paths = [part.split()[0] for target in targets for part in target.split(",") if part.split()]
    return [path for path in paths if not path.startswith(EXTERNAL)]


def broken_targets(directory: Path, text: str) -> list[str]:
    """Relative link, src and srcset targets in the text that name no file under the directory."""
    return [path for path in relative_targets(text) if not (directory / path).exists()]


def fragile_maths(text: str) -> list[str]:
    """Plain inline maths holding an underscore or asterisk, which Markdown reads as emphasis."""
    markup = CODE_SPAN.sub("", BACKTICK_MATHS.sub("", prose(text)))
    return [m for m in PLAIN_MATHS.findall(markup) if "_" in m or "*" in m]


def results_table(text: str) -> list[tuple[str, str, str]]:
    """Rows of the table headed N, direct (ms), tree (ms), as the cell text."""
    header = TABLE_HEADER.search(text)
    if header is None:
        return []
    rows = []
    for line in text[header.end() :].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        rows.append((cells[0], cells[1], cells[2]))
    return rows


def table_errors(rows: list[tuple[str, str, str]], timing: list[dict[str, object]]) -> list[str]:
    """Rows whose cells differ from the timing results at the table's thread count."""
    medians = {
        (row["method"], row["count"]): row["median_ms"]
        for row in timing
        if row["threads"] == TABLE_THREADS
    }
    errors = [] if rows else ["no results table"]
    for count, direct, tree in rows:
        for method, cell in (("direct", direct), ("tree", tree)):
            median = medians.get((method, int(count)))
            expected = None if median is None else f"{float(str(median)):.1f}"
            if cell != expected:
                errors.append(f"N = {count} {method}: table has {cell}, results have {expected}")
    return errors


@pytest.mark.parametrize("document", DOCUMENTS, ids=lambda path: path.name)
def test_every_relative_target_exists(document: Path) -> None:
    text = document.read_text(encoding="utf-8")
    assert broken_targets(document.parent, text) == []


@pytest.mark.parametrize("document", DOCUMENTS, ids=lambda path: path.name)
def test_inline_maths_avoids_emphasis_characters(document: Path) -> None:
    assert fragile_maths(document.read_text(encoding="utf-8")) == []


def test_readme_table_matches_timing_results() -> None:
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    timing = json.loads((ROOT / "results" / "timing.json").read_text(encoding="utf-8"))
    assert table_errors(results_table(text), timing) == []


def test_package_description_has_no_maths_or_relative_targets() -> None:
    text = (ROOT / "docs" / "pypi.md").read_text(encoding="utf-8")
    assert relative_targets(text) == []
    assert "$" not in text


def test_relative_targets_are_listed() -> None:
    text = "[a](x.md) ![b](y.png) [c](https://example.com) [d](#top)\n```\n[e](z.md)\n```\n"
    assert relative_targets(text) == ["x.md", "y.png"]


def test_missing_target_is_reported(tmp_path: Path) -> None:
    (tmp_path / "there.png").write_bytes(b"")
    text = (
        "[ok](there.png) [web](https://example.com/x.png) [top](#top) [no](gone.md)\n"
        '<img src="gone.png"> <source srcset="there.png, there.png 2x">\n'
        "```\n[skipped](in-code.md)\n```\n"
    )
    assert broken_targets(tmp_path, text) == ["gone.md", "gone.png"]


def test_emphasis_characters_in_plain_maths_are_reported() -> None:
    text = (
        "bad $a_b$ and $x*y$, good $`a_b`$ and $x + y$.\n"
        "```math\nv_{n+1} = v_n\n```\n"
        "    echo $HOME $PATH_ONE\n"
        "inline `$a_b$ code`\n"
    )
    assert fragile_maths(text) == ["a_b", "x*y"]


def test_table_cell_that_differs_from_results_is_reported() -> None:
    text = "| N | direct (ms) | tree (ms) |\n|---:|---:|---:|\n| 4096 | 11.7 | 6.5 |\n\nafter\n"
    timing: list[dict[str, object]] = [
        {"method": "direct", "count": 4096, "threads": 8, "median_ms": 11.7004},
        {"method": "tree", "count": 4096, "threads": 8, "median_ms": 6.4439},
        {"method": "tree", "count": 4096, "threads": 1, "median_ms": 30.0},
    ]
    assert table_errors(results_table(text), timing) == [
        "N = 4096 tree: table has 6.5, results have 6.4"
    ]
    assert table_errors([("8192", "1.0", "1.0")], timing) == [
        "N = 8192 direct: table has 1.0, results have None",
        "N = 8192 tree: table has 1.0, results have None",
    ]


def test_missing_table_is_reported() -> None:
    assert table_errors(results_table("no table here"), []) == ["no results table"]


def test_table_at_the_end_of_a_document_is_read() -> None:
    text = "| N | direct (ms) | tree (ms) |\n|---:|---:|---:|\n| 4096 | 11.7 | 6.4 |"
    assert results_table(text) == [("4096", "11.7", "6.4")]
