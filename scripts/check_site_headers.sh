#!/bin/bash
# Checks that a served copy of the page can run the threaded WebAssembly build:
# every URL answers 200 with both cross-origin isolation headers, and the two
# .wasm files carry the type streaming compilation needs.
#
# Usage: check_site_headers.sh BASE_URL
# Exit status: 0 all checks pass, 1 any check fails, 2 usage error.
set -euo pipefail

readonly REQUEST_TIMEOUT_SECONDS=20
readonly MAX_RETRIES=5
readonly RETRY_DELAY_SECONDS=5
readonly RETRY_BUDGET_SECONDS=120
readonly EXPECTED_OPENER_POLICY="same-origin"
readonly EXPECTED_EMBEDDER_POLICY="require-corp"
readonly EXPECTED_WASM_TYPE="application/wasm"

readonly PAGE_PATHS=("/" "/worker.js")
readonly WASM_PATHS=("/wasm/threads/nbody.wasm" "/wasm/single/nbody.wasm")

failures=0

# Prints the value of header $1 from the header dump in $2, empty if absent.
header_value() {
  local name="$1" dump="$2"
  awk -F': *' -v name="${name}" '
    { sub(/\r$/, "") }
    tolower($1) == tolower(name) { sub(/^[^:]*: */, ""); value = $0 }
    END { print value }
  ' "${dump}"
}

# Reports one expectation: prints a line, and counts a failure on mismatch.
expect() {
  local url="$1" what="$2" expected="$3" received="$4"
  if [[ "${received}" == "${expected}" ]]; then
    echo "ok   ${url} ${what}: ${received}"
  else
    echo "FAIL ${url} ${what}: expected '${expected}', received '${received}'"
    failures=$((failures + 1))
  fi
}

# Fetches $1 and checks status and isolation headers, plus the content type
# when $2 is not empty.
check_url() {
  local url="$1" expected_type="$2" dump status
  dump="$(mktemp)"
  if ! status="$(curl --silent --show-error --output /dev/null --dump-header "${dump}" \
    --write-out '%{http_code}' --max-time "${REQUEST_TIMEOUT_SECONDS}" \
    --retry "${MAX_RETRIES}" --retry-delay "${RETRY_DELAY_SECONDS}" \
    --retry-max-time "${RETRY_BUDGET_SECONDS}" --retry-all-errors "${url}")"; then
    # The retries already waited the host out, so the remaining URLs would
    # only repeat the wait.
    echo "FAIL ${url} unreachable after ${MAX_RETRIES} retries" >&2
    rm -f "${dump}"
    exit 1
  fi
  local opener_policy embedder_policy content_type
  opener_policy="$(header_value "Cross-Origin-Opener-Policy" "${dump}")"
  embedder_policy="$(header_value "Cross-Origin-Embedder-Policy" "${dump}")"
  content_type="$(header_value "Content-Type" "${dump}")"
  expect "${url}" "status" "200" "${status}"
  expect "${url}" "Cross-Origin-Opener-Policy" "${EXPECTED_OPENER_POLICY}" "${opener_policy}"
  expect "${url}" "Cross-Origin-Embedder-Policy" "${EXPECTED_EMBEDDER_POLICY}" "${embedder_policy}"
  if [[ -n "${expected_type}" ]]; then
    expect "${url}" "Content-Type" "${expected_type}" "${content_type}"
  fi
  rm -f "${dump}"
}

main() {
  if [[ $# -ne 1 || ! "$1" =~ ^https?:// ]]; then
    echo "usage: ${0##*/} http(s)://host[:port]" >&2
    exit 2
  fi
  local base="${1%/}" path
  for path in "${PAGE_PATHS[@]}"; do
    check_url "${base}${path}" ""
  done
  for path in "${WASM_PATHS[@]}"; do
    check_url "${base}${path}" "${EXPECTED_WASM_TYPE}"
  done
  if ((failures > 0)); then
    echo "${failures} check(s) failed" >&2
    exit 1
  fi
}

main "$@"
