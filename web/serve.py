"""Serves the web directory locally with the headers WebAssembly threads need.

Shared memory needs cross-origin isolation, which the page gets from the two
headers below. `--no-isolation` leaves them out, to see the page fall back to
the single-threaded build. Standard library only.
"""

import argparse
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from os import PathLike
from pathlib import Path

ISOLATION_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}
MEDIA_TYPES = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
}
DEFAULT_PORT = 8000


class Handler(SimpleHTTPRequestHandler):
    """Serves files, adding the isolation headers unless `isolated` is false."""

    isolated = True

    def guess_type(self, path: str | PathLike[str]) -> str:
        return MEDIA_TYPES.get(Path(path).suffix) or super().guess_type(path)

    def end_headers(self) -> None:
        if self.isolated:
            for name, value in ISOLATION_HEADERS.items():
                self.send_header(name, value)
        super().end_headers()


def make_server(directory: Path, port: int, isolated: bool) -> ThreadingHTTPServer:
    """A server on the loopback interface; port 0 picks a free one."""
    handler = type("ConfiguredHandler", (Handler,), {"isolated": isolated})
    return ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=str(directory)))


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-isolation", action="store_true", help="omit the isolation headers")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:  # pragma: no cover - blocks serving until interrupted
    arguments = parse_arguments(argv)
    server = make_server(Path(__file__).parent, arguments.port, not arguments.no_isolation)
    print(f"http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point only wires main to the process
    sys.exit(main(sys.argv[1:]))
