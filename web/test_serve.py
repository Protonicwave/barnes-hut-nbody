import threading
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from http.client import HTTPResponse
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

import serve


@contextmanager
def running(*, isolated: bool) -> Iterator[str]:
    with TemporaryDirectory() as directory:
        Path(directory, "module.wasm").write_bytes(b"\x00asm")
        Path(directory, "module.mjs").write_text("export {};\n", encoding="utf-8")
        server = serve.make_server(Path(directory), 0, isolated)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


def fetch(url: str) -> HTTPResponse:
    # The URL is always the loopback server the test started.
    return cast(HTTPResponse, urllib.request.urlopen(url))  # noqa: S310


def test_sends_both_isolation_headers() -> None:
    with running(isolated=True) as base, fetch(f"{base}/module.wasm") as reply:
        assert reply.headers["Cross-Origin-Opener-Policy"] == "same-origin"
        assert reply.headers["Cross-Origin-Embedder-Policy"] == "require-corp"


def test_leaves_the_headers_out_on_request() -> None:
    with running(isolated=False) as base, fetch(f"{base}/module.wasm") as reply:
        assert reply.headers["Cross-Origin-Opener-Policy"] is None
        assert reply.headers["Cross-Origin-Embedder-Policy"] is None


def test_serves_wasm_and_modules_with_their_media_types() -> None:
    with running(isolated=True) as base:
        with fetch(f"{base}/module.wasm") as reply:
            assert reply.headers["Content-Type"] == "application/wasm"
        with fetch(f"{base}/module.mjs") as reply:
            assert reply.headers["Content-Type"] == "text/javascript"


def test_parses_port_and_isolation_flag() -> None:
    arguments = serve.parse_arguments(["--port", "9001", "--no-isolation"])
    assert (arguments.port, arguments.no_isolation) == (9001, True)
    defaults = serve.parse_arguments([])
    assert (defaults.port, defaults.no_isolation) == (serve.DEFAULT_PORT, False)
