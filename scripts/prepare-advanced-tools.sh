#!/usr/bin/env bash
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
directory="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nddev-advanced-tools"
mkdir -p "$directory"
fetch() {
  name="$1" url="$2" expected="$3"
  archive="$directory/$name.tar.gz"
  if [ ! -f "$archive" ] || ! printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status; then
    curl --silent --show-error --fail --location --retry 2 --max-time 180 "$url" --output "$archive.pending"
    printf '%s  %s\n' "$expected" "$archive.pending" | sha256sum --check
    mv -- "$archive.pending" "$archive"
  fi
  python3 - "$archive" "$directory/$name" "$name" <<'PY'
import sys, tarfile
from pathlib import Path
with tarfile.open(sys.argv[1]) as archive:
    member = next(m for m in archive.getmembers() if Path(m.name).name == sys.argv[3] and m.isfile())
    with archive.extractfile(member) as stream:
        Path(sys.argv[2]).write_bytes(stream.read())
Path(sys.argv[2]).chmod(0o755)
PY
}
fetch cargo-fuzz https://github.com/rust-fuzz/cargo-fuzz/releases/download/0.13.2/cargo-fuzz-0.13.2-x86_64-unknown-linux-musl.tar.gz b5b704018b63e0f151c17a057ac53b5111e1db545d1b9f72fee79f08a545931c
fetch cargo-mutants https://github.com/sourcefrog/cargo-mutants/releases/download/v27.1.0/cargo-mutants-x86_64-unknown-linux-gnu.tar.gz dfe6dc37d0342c891d2829b5a695aa57c2d0edecef7e7d0399a30cc6e206411e
"$directory/cargo-fuzz" --version
"$directory/cargo-mutants" mutants --version
if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$directory" >> "$GITHUB_PATH"; fi
