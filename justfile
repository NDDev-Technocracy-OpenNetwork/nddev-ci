set shell := ["bash", "-euo", "pipefail", "-c"]

actionlint_version := "1.7.12"
actionlint_sha256 := "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
zizmor_version := "1.32.0"
tools := justfile_directory() / ".tools"

# Lists the commands.
default:
    @just --list

# Format, workflow structure and workflow security. Reads only, apart from fetching the tools once.
check: tools
    just --fmt --check
    {{ tools }}/actionlint .github/workflows/*.yml
    {{ tools }}/zizmor/bin/zizmor --min-severity medium .github

# The documented caller workflow is valid.
test: tools
    {{ tools }}/actionlint examples/ci.yml

# Everything the full check on dev runs.
verify: check test

# Applies formatting.
fix:
    just --fmt

# Fetches the pinned check tools into .tools.
tools:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{ tools }}"
    if [ ! -x "{{ tools }}/actionlint" ]; then
      archive="{{ tools }}/actionlint.tar.gz"
      curl -fsSL --retry 3 -o "$archive" "https://github.com/rhysd/actionlint/releases/download/v{{ actionlint_version }}/actionlint_{{ actionlint_version }}_linux_amd64.tar.gz"
      echo "{{ actionlint_sha256 }}  $archive" | sha256sum --check --quiet
      tar -xzf "$archive" -C "{{ tools }}" actionlint
      rm "$archive"
    fi
    if [ ! -x "{{ tools }}/zizmor/bin/zizmor" ]; then
      python3 -m venv "{{ tools }}/zizmor"
      "{{ tools }}/zizmor/bin/pip" install --quiet --disable-pip-version-check "zizmor=={{ zizmor_version }}"
    fi
