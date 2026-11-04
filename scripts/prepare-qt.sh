#!/usr/bin/env bash
# Job-local open-source Qt SDK; never installs shared-host packages.
set -euo pipefail
: "${RUNNER_TEMP:?Owned job temporary directory required}"
library="$(pwd)"
sdk="$RUNNER_TEMP/nddev-qt"
(
  cd "$RUNNER_TEMP"
  uv run --project "$library/.github/native-tools" --locked aqt install-qt \
    linux desktop 6.12.0 linux_gcc_64 --outputdir "$sdk" --archives qtbase icu
)
prefix="$sdk/6.12.0/gcc_64"
"$prefix/bin/qtpaths" --qt-version
printf '%s\n' "$prefix/bin" >> "$GITHUB_PATH"
printf 'CMAKE_PREFIX_PATH=%s\nLD_LIBRARY_PATH=%s\n' "$prefix" "$prefix/lib" >> "$GITHUB_ENV"
