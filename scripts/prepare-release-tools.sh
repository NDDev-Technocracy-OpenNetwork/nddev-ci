#!/usr/bin/env bash
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
directory="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nddev-syft-1.54.1"
mkdir -p "$directory"
archive="$directory/syft.tar.gz"
expected=c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47
if [ ! -f "$archive" ] || ! printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status; then
  curl --silent --show-error --fail --location --retry 2 --max-time 180 \
    https://github.com/anchore/syft/releases/download/v1.54.1/syft_1.54.1_linux_amd64.tar.gz \
    --output "$archive.pending"
  printf '%s  %s\n' "$expected" "$archive.pending" | sha256sum --check
  mv -- "$archive.pending" "$archive"
fi
tar --extract --gzip --file "$archive" --directory "$directory" syft
"$directory/syft" version
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$directory" >> "$GITHUB_PATH"
fi
