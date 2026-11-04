#!/usr/bin/env bash
set -euo pipefail
directory="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nddev-mobile-tools"
mkdir -p "$directory"
jar="$directory/bundletool-1.18.3.jar"
expected=a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
if [ ! -f "$jar" ] || ! printf '%s  %s\n' "$expected" "$jar" | sha256sum --check --status; then
  trap 'rm -f -- "$jar.pending"' EXIT
  curl --silent --show-error --fail --location --retry 2 --max-time 180 \
    https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar \
    --output "$jar.pending"
  printf '%s  %s\n' "$expected" "$jar.pending" | sha256sum --check
  mv -- "$jar.pending" "$jar"
fi
java -jar "$jar" version
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'BUNDLETOOL_JAR=%s\n' "$jar" >> "$GITHUB_ENV"
else
  printf 'BUNDLETOOL_JAR=%s\n' "$jar"
fi
