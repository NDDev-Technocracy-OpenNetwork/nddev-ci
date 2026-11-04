#!/usr/bin/env bash
# Optional prepared bytes are a transport optimization; requested identity stays with the callee.
nddev_prepared_artifact() {
  local expected="$1" destination="$2" helper
  if [[ -z "${NDDEV_ARTIFACT_CACHE:-}" ]]; then return 1; fi
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prepared-artifact.py"
  if ! command -v python3 >/dev/null 2>&1; then
    echo 'Configured prepared artifact storage requires the native host Python' >&2
    return 2
  fi
  python3 "$helper" "$NDDEV_ARTIFACT_CACHE" "$expected" "$destination"
}
