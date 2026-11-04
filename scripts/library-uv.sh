#!/usr/bin/env bash
# Bootstrap only the callee's uv; never write caller PATH or shared-host packages.
set -euo pipefail
: "${RUNNER_TEMP:?Use an owned job temporary directory}"
# An explicit native binding owns bootstrap too; a miss must not select public transport.
if [[ -n "${NDDEV_CACHE_PROVIDER:-}" || -n "${NDDEV_UV_CENTRAL_INDEX+x}" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo 'Selected native cache bootstrap requires the prepared host Python' >&2
    exit 2
  fi
  exec python3 "$(dirname "${BASH_SOURCE[0]}")/../src/nddev_cicd/native_cache.py" uv
fi
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) target=x86_64-unknown-linux-gnu; checksum=f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f ;;
  Linux:aarch64) target=aarch64-unknown-linux-gnu; checksum=4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403 ;;
  Darwin:arm64) target=aarch64-apple-darwin; checksum=743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73 ;;
  Darwin:x86_64) target=x86_64-apple-darwin; checksum=b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66 ;;
  MINGW*:x86_64|MSYS*:x86_64) target=x86_64-pc-windows-msvc; checksum=a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a ;;
  *) echo 'Unsupported library uv platform' >&2; exit 2 ;;
esac
extension=tar.gz
binary=uv
if [[ "$target" == *windows* ]]; then extension=zip; binary=uv.exe; fi
temporary_root="$RUNNER_TEMP"
if [[ "$target" == *windows* ]]; then temporary_root="$(cygpath -u "$RUNNER_TEMP")"; fi
# A full timeout must discard both origin and CDN connection caches before retrying.
# curl retains ownership of transient HTTP classification; digest checks stay below.
download() {
  local attempt status=28 deadline=$((SECONDS + 480)) remaining limit
  for attempt in 0 1 2 3; do
    remaining=$((deadline - SECONDS))
    if (( remaining <= 0 )); then return "$status"; fi
    limit=120
    if (( remaining < limit )); then limit="$remaining"; fi
    if curl --retry 3 --retry-max-time "$limit" --connect-timeout 20 --max-time "$limit" \
      --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$@"; then
      return 0
    else
      status=$?
    fi
    if [[ "$status" != 28 || "$attempt" == 3 ]]; then return "$status"; fi
  done
  return "$status"
}
stage="$(mktemp -d "$temporary_root/nddev-library-uv.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
archive="$stage/uv.$extension"
# shellcheck source=scripts/prepared-artifact.sh
source "$(dirname "${BASH_SOURCE[0]}")/prepared-artifact.sh"
if nddev_prepared_artifact "$checksum" "$archive"; then
  :
else
  prepared_status=$?
  if [[ "$prepared_status" != 1 ]]; then exit "$prepared_status"; fi
  download \
    "https://github.com/astral-sh/uv/releases/download/0.13.5/uv-$target.$extension" --output "$archive"
fi
if [[ "$target" == *apple* ]]; then
  observed="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  observed="$(sha256sum "$archive" | awk '{print $1}')"
fi
[[ "$observed" == "$checksum" ]]
if [[ "$extension" == zip ]]; then
  unzip -qq "$archive" "$binary" -d "$stage"
else
  tar -xOzf "$archive" "uv-$target/$binary" > "$stage/$binary"
fi
chmod 755 "$stage/$binary"
"$stage/$binary" --version >&2
rm "$archive"
printf '%s\n' "$stage/$binary"
trap - EXIT
