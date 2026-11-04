#!/usr/bin/env bash
# The R/Clang acceptance jobs need Ubuntu packages, not unrelated hosted-image feeds.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}" = Linux
ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
test -f "$ubuntu_sources"
configuration=/etc/apt/apt.conf.d/99nddev-native-sources
test ! -e "$configuration"
parts="$(mktemp -d "$RUNNER_TEMP/nddev-apt-sources.XXXXXXXX")"
# Preserve the image's native Ubuntu suites, mirrors and Signed-By keyrings.
# This configuration exists only in this disposable SDK acceptance VM.
printf 'Dir::Etc::sourcelist "%s";\nDir::Etc::sourceparts "%s";\n' "$ubuntu_sources" "$parts" |
  sudo tee "$configuration" >/dev/null
