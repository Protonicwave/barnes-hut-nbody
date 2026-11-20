#!/bin/bash
# Checks that a served copy of the page can run the threaded WebAssembly build:
# every URL answers 200 with both cross-origin isolation headers, and the two
# .wasm files carry the type streaming compilation needs.
#
# Usage: check_site_headers.sh BASE_URL
# Exit status: 0 all checks pass, 1 any check fails or the host cannot be
# fetched, 2 usage error. A repeated header is joined with ", " and so fails.
set -euo pipefail

readonly REQUEST_TIMEOUT_SECONDS=20
readonly MAX_RETRIES=5
readonly RETRY_DELAY_SECONDS=5
readonly EXPECTED_OPENER_POLICY="same-origin"
readonly EXPECTED_EMBEDDER_POLICY="require-corp"
readonly EXPECTED_WASM_TYPE="application/wasm"

readonly PAGE_PATHS=("/" "/worker.js" "/wasm/threads/nbody.js")
readonly WASM_PATHS=("/wasm/threads/nbody.wasm" "/wasm/single/nbody.wasm")

failures=0
dump=""

# Prints the value of header $1 from the header dump in $2, empty if absent.
# A header sent twice gives both values joined with ", ".
header_value() {
  local name="$1" file="$2"
  awk -F': *' -v name="${name}" '
    { sub(/\r$/, "") }
    tolower($1) == tolower(name) {
      sub(/^[^:]*: */, "")
      value = (value == "" ? $0 : value ", " $0)
    }
    END { print value }
  ' "${file}"
}

# Compares a received value with the expected one, printing a line and adding
# to the global failure count on a mismatch.
check_equal() {
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
  local url="$1" expected_type="$2" status
  if ! status="$(curl --silent --show-error --output /dev/null --dump-header "${dump}" \
    --write-out '%{http_code}' --max-time "${REQUEST_TIMEOUT_SECONDS}" \
    --retry "${MAX_RETRIES}" --retry-delay "${RETRY_DELAY_SECONDS}" \
    --retry-all-errors "${url}")"; then
    # Retries are spent, so the remaining URLs would only repeat the wait.
    echo "FAIL ${url} could not be fetched after ${MAX_RETRIES} retries" >&2
    exit 1
  fi
  local opener_policy embedder_policy content_type
  opener_policy="$(header_value "Cross-Origin-Opener-Policy" "${dump}")"
  embedder_policy="$(header_value "Cross-Origin-Embedder-Policy" "${dump}")"
  content_type="$(header_value "Content-Type" "${dump}")"
  check_equal "${url}" "status" "200" "${status}"
  check_equal "${url}" "Cross-Origin-Opener-Policy" "${EXPECTED_OPENER_POLICY}" "${opener_policy}"
  check_equal "${url}" "Cross-Origin-Embedder-Policy" "${EXPECTED_EMBEDDER_POLICY}" "${embedder_policy}"
  if [[ -n "${expected_type}" ]]; then
    check_equal "${url}" "Content-Type" "${expected_type}" "${content_type}"
  fi
}

main() {
  if [[ $# -ne 1 || ! "$1" =~ ^https?:// ]]; then
    echo "usage: ${0##*/} http(s)://host[:port]" >&2
    exit 2
  fi
  local base="${1%/}" path
  dump="$(mktemp)"
  trap 'rm -f "${dump}"' EXIT
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
