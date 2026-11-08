set shell := ["bash", "-euo", "pipefail", "-c"]

actionlint_version := "1.7.12"
actionlint_sha256 := "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
zizmor_version := "1.32.0"
tools := env_var_or_default("NDDEV_CI_CHECK_TOOLS", justfile_directory() / ".tools")

# Lists the commands.
default:
    @just --list

# Prepare source-analysis tools explicitly before offline checks.
setup: tools

# Format, JavaScript syntax, workflow structure and workflow security.
check:
    test -x {{ tools }}/actionlint && test -x {{ tools }}/zizmor/bin/zizmor
    test "$({{ tools }}/actionlint --version | head -n 1)" = "{{ actionlint_version }}"
    test "$({{ tools }}/zizmor/bin/zizmor --version)" = "zizmor {{ zizmor_version }}"
    just --fmt --check
    rustfmt --edition 2024 --check tests/recipe-routing.rs
    node --check actions/recipe/run.mjs
    node --check tests/portable-recipe.test.mjs
    {{ tools }}/actionlint .github/workflows/*.yml
    {{ tools }}/zizmor/bin/zizmor --min-severity medium .github

# The documented caller workflow is valid.
test:
    {{ tools }}/actionlint examples/ci.yml
    rustc --edition 2024 --test tests/recipe-routing.rs -o {{ tools }}/recipe-routing-tests
    {{ tools }}/recipe-routing-tests
    node --test tests/portable-recipe.test.mjs

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
    if [ ! -x "{{ tools }}/actionlint" ] || [ "$("{{ tools }}/actionlint" --version | head -n 1)" != "{{ actionlint_version }}" ]; then
      archive="{{ tools }}/actionlint.tar.gz"
      auth=()
      if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
      asset=$(curl -fsSL "${auth[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/rhysd/actionlint/releases/tags/v{{ actionlint_version }}" |
        jq -er --arg name "actionlint_{{ actionlint_version }}_linux_amd64.tar.gz" '[.assets[] | select(.name == $name)] | if length == 1 then .[0].id | numbers else error("release asset is missing or ambiguous") end')
      curl -fsSL "${auth[@]}" -H 'Accept: application/octet-stream' -o "$archive" "https://api.github.com/repos/rhysd/actionlint/releases/assets/$asset"
      echo "{{ actionlint_sha256 }}  $archive" | sha256sum --check --quiet
      tar -xzf "$archive" -C "{{ tools }}" actionlint
      rm "$archive"
    fi
    if [ ! -x "{{ tools }}/zizmor/bin/zizmor" ] || [ "$("{{ tools }}/zizmor/bin/zizmor" --version)" != "zizmor {{ zizmor_version }}" ]; then
      uv venv --allow-existing --python "$(command -v python3)" "{{ tools }}/zizmor"
      uv pip install --python "{{ tools }}/zizmor/bin/python" --only-binary :all: "zizmor=={{ zizmor_version }}"
    fi
