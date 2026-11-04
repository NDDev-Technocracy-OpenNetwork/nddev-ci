#!/usr/bin/env bash
# Job-local native tools for this repository's Linux CI; no shared-host packages.
set -euo pipefail
: "${RUNNER_TEMP:?Use an owned job-local temporary directory}"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
tools="$RUNNER_TEMP/nddev-native-tools"
if [[ -e "$tools" && ! -f "$tools/.nddev-tools-owner" ]]; then
  echo 'Refusing an unowned native-tool directory' >&2
  exit 2
fi
mkdir -p "$tools"
printf 'std-0004-ci-tools/v1\n' > "$tools/.nddev-tools-owner"
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
# shellcheck source=scripts/prepared-artifact.sh
source "$(dirname "${BASH_SOURCE[0]}")/prepared-artifact.sh"
verified_download() {
  local url="$1" expected="$2" destination="$3" status
  if nddev_prepared_artifact "$expected" "$destination"; then return 0; else status=$?; fi
  if [[ "$status" != 1 ]]; then return "$status"; fi
  download "$url" --output "$destination"
}
install_archive() {
  local url="$1" expected="$2" binary="$3" archive="$tools/$3.tar.gz" member
  if [[ -f "$tools/$binary.source" && "$(cat "$tools/$binary.source")" == "$expected" ]] && \
    (cd "$tools" && sha256sum --check --status "$binary.sha256"); then
    return
  fi
  verified_download "$url" "$expected" "$archive"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status
  member="$(tar -tzf "$archive" | awk -F/ -v binary="$binary" '$NF == binary { print }')"
  [[ -n "$member" && "$member" != *$'\n'* ]]
  tar -xOzf "$archive" "$member" > "$tools/$binary.new"
  chmod 755 "$tools/$binary.new"
  mv "$tools/$binary.new" "$tools/$binary"
  rm "$archive"
  printf '%s\n' "$expected" > "$tools/$binary.source"
  (cd "$tools" && sha256sum "$binary" > "$binary.sha256")
}
install_file() {
  local url="$1" expected="$2" binary="$3"
  if [[ -f "$tools/$binary" ]] && printf '%s  %s\n' "$expected" "$tools/$binary" | sha256sum --check --status; then
    return
  fi
  verified_download "$url" "$expected" "$tools/$binary.new"
  printf '%s  %s\n' "$expected" "$tools/$binary.new" | sha256sum --check --status
  chmod 755 "$tools/$binary.new"
  mv "$tools/$binary.new" "$tools/$binary"
}
capabilities="${*//,/ }"
unique=''
for capability in $capabilities; do
  case "$capability" in rust|security|quality|compiler|shell|container|infrastructure|workflows|documentation) ;; *) echo 'Unknown tool capability' >&2; exit 2 ;; esac
  case " $unique " in *" $capability "*) ;; *) unique+=" $capability" ;; esac
done
install_archive 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz' \
  '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' actionlint
install_archive 'https://github.com/lycheeverse/lychee/releases/download/lychee-v0.24.2/lychee-x86_64-unknown-linux-musl.tar.gz' \
  '73657a111819a30c47c08352896796f23d64e4eb2b3ed39b6d32149241566fc5' lychee
install_archive 'https://github.com/zizmorcore/zizmor/releases/download/v1.31.1/zizmor-x86_64-unknown-linux-gnu.tar.gz' \
  'd185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99' zizmor
for capability in $unique; do
if [[ "$capability" == rust || "$capability" == quality ]]; then
  install_archive 'https://github.com/bnjbvr/cargo-machete/releases/download/v0.9.2/cargo-machete-v0.9.2-x86_64-unknown-linux-musl.tar.gz' \
    '48200087f54c55aabcd4db4af1e25742b49846c02a1b1bfa134711945b35b2e9' cargo-machete
fi
if [[ "$capability" == compiler ]]; then
  install_archive 'https://github.com/ccache/ccache/releases/download/v4.14.2/ccache-4.14.2-linux-x86_64-musl-static.tar.gz' \
    'd540ba01f160addbd3dd5e18eda9bd34005591b095c09ac8ae9d0a1b655e7ef5' ccache
  "$tools/ccache" --version
fi
if [[ "$capability" == quality ]]; then
  install_archive 'https://github.com/crate-ci/typos/releases/download/v1.51.1/typos-v1.51.1-x86_64-unknown-linux-musl.tar.gz' \
    '93c301fd4120ff076e2cc2a6d6a61cab4a4bdb81899287c0938b452e56d1f454' typos
  "$tools/typos" --version
  "$tools/cargo-machete" --version
  library="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  library_uv="$(bash "$library/scripts/library-uv.sh")"
  quality_runtime="$(UV_PROJECT_ENVIRONMENT="$tools/quality-runtime" UV_CACHE_DIR="${NDDEV_UV_CACHE_ROOT:-$tools/quality-downloads}" \
    bash "$library/scripts/prepare-python-tool-runtime.sh" "$library_uv" "$library/.github/native-tools" --group quality)"
  SEMGREP_APP_TOKEN='' SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 OTEL_SDK_DISABLED=true \
    SEMGREP_SETTINGS_FILE="$tools/quality-semgrep-settings.yml" "$quality_runtime/bin/semgrep" --version
  if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$quality_runtime/bin" >> "$GITHUB_PATH"; fi
fi
if [[ "$capability" == rust ]]; then
  install_archive 'https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/cargo-deny-0.20.2-x86_64-unknown-linux-musl.tar.gz' \
    '9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f' cargo-deny
  install_archive 'https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-x86_64-unknown-linux-musl.tar.gz' \
    '45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89' sccache
  install_archive 'https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv0.22.2/cargo-audit-x86_64-unknown-linux-musl-v0.22.2.tgz' \
    '7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428' cargo-audit
  install_archive 'https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.149/cargo-nextest-0.9.149-x86_64-unknown-linux-musl.tar.gz' \
    'd65c7f14bcb5c1566d1ecd534c5da8dedb81ba58586e478b0ab81c877d2bd8ad' cargo-nextest
  "$tools/cargo-deny" --version
  "$tools/sccache" --version
  "$tools/cargo-audit" --version
  "$tools/cargo-nextest" --version
fi
if [[ "$capability" == security ]]; then
  install_archive 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz' \
    '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' gitleaks
  "$tools/gitleaks" version
  install_file 'https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_amd64' \
    'ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108' osv-scanner
  "$tools/osv-scanner" --version
  library="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  library_uv="$(bash "$library/scripts/library-uv.sh")"
  security_runtime="$(UV_PROJECT_ENVIRONMENT="$tools/security-runtime" UV_CACHE_DIR="${NDDEV_UV_CACHE_ROOT:-$tools/security-downloads}" \
    bash "$library/scripts/prepare-python-tool-runtime.sh" "$library_uv" "$library/tools/security" --no-dev)"
  "$security_runtime/bin/bandit" --version
  if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$security_runtime/bin" >> "$GITHUB_PATH"; fi
fi
if [[ "$capability" == shell ]]; then
  install_archive 'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz' \
    'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6' shellcheck
  archive="$tools/bats.tar.gz"
  verified_download \
    'https://codeload.github.com/bats-core/bats-core/tar.gz/eb7f42f8d608ac693d7a4b67474f6714ea68cfc5' \
    '845574549f4c9777bf02fcdf307f1bf347d40c66920fb6b47dcc8fdfa065ac39' "$archive"
  printf '%s  %s\n' '845574549f4c9777bf02fcdf307f1bf347d40c66920fb6b47dcc8fdfa065ac39' "$archive" | sha256sum --check --status
  mkdir -p "$tools/bats-sdk"
  tar -xzf "$archive" --strip-components=1 --directory "$tools/bats-sdk"
  rm "$archive"
  "$tools/bats-sdk/bin/bats" --version
  if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$tools/bats-sdk/bin" >> "$GITHUB_PATH"; fi
fi
if [[ "$capability" == container || "$capability" == infrastructure ]]; then
  install_archive 'https://github.com/aquasecurity/trivy/releases/download/v0.76.0/trivy_0.76.0_Linux-64bit.tar.gz' \
    'e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7' trivy
  "$tools/trivy" --version
fi
if [[ "$capability" == container ]]; then
  install_file 'https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64' \
    'c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507' hadolint
  "$tools/hadolint" --version
fi
done
"$tools/actionlint" --version
"$tools/lychee" --version
if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$tools" >> "$GITHUB_PATH"; fi
