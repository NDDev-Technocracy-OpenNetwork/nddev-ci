set shell := ["bash", "-euo", "pipefail", "-c"]

actionlint_version := "1.7.12"
actionlint_sha256 := "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
zizmor_version := "1.32.0"
zizmor_sha256 := "84a6acb975accc13408786a2bd274b572537ca19c933ebbc13e78f3988562071"
shellcheck_version := "0.11.0"
shellcheck_sha256 := "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"
tools := env_var_or_default("NDDEV_CI_CHECK_TOOLS", justfile_directory() / ".tools")
actionlint := tools / "checks" / ("actionlint-" + actionlint_sha256) / "actionlint"
zizmor := tools / "checks" / ("zizmor-" + zizmor_sha256) / "zizmor"
shellcheck := tools / "checks" / ("shellcheck-" + shellcheck_sha256)

# Lists the commands.
default:
    @just --list

# Prepare source-analysis tools explicitly before offline checks.
setup: tools

# Format, JavaScript syntax, workflow structure and workflow security.
check: (_tools "check")
    just --fmt --check
    rustfmt --edition 2024 --check tests/recipe-routing.rs
    node --check actions/artifact-registry/run.mjs
    node --check tests/artifact-registry.test.mjs
    node --check lib/runner-profile.mjs
    node --check tests/runner-profile.test.mjs
    node --check actions/frontend/run.mjs
    node --check actions/recipe/run.mjs
    node --check actions/hosted-sdk/run.mjs
    node --check actions/hosted-sdk/bun.mjs
    node --check actions/hosted-sdk/flutter.mjs
    node --check tests/bun-source.test.mjs
    node --check tests/hosted-sdk.test.mjs
    node --check tests/sdk-runtime.test.mjs
    node --check actions/release-assets/run.mjs
    node --check lib/release-asset.mjs
    node --check lib/native-member.mjs
    node --check lib/dependency-report.mjs
    node --check lib/dependency-source.mjs
    node --check lib/dependency-scan.mjs
    node --check actions/dependency-guard/run.mjs
    node --check tests/dependency-report.test.mjs
    node --check tests/dependency-source.test.mjs
    node --check lib/change-objects.mjs
    node --check actions/change-objects/run.mjs
    node --check tests/change-objects.test.mjs
    node --check tests/dependency-native.mjs
    node --check actions/daily-osv/run.mjs
    node --check tests/daily-osv-native.mjs
    node --check tests/daily-osv.test.mjs
    node --check actions/daily-sbom/run.mjs
    node --check tests/daily-sbom-native.mjs
    node --check lib/security-policy.mjs
    node --check tests/license-policy.test.mjs
    node --check tests/portable-recipe.test.mjs
    node --check tests/release-assets.test.mjs
    node --check tests/windows-archive.test.mjs
    node --check tests/bootstrap-tools.mjs
    node --check tests/dependency-scan.test.mjs
    node --check tests/telemetry.test.mjs
    node --check actions/job-record/run.mjs
    node --check tests/job-record.test.mjs
    node --check lib/qualification.mjs
    node --check actions/qualify/run.mjs
    node --check actions/checked-artifacts/run.mjs
    node --check tests/qualification.test.mjs
    node --check lib/release.mjs
    node --check actions/release/run.mjs
    node --check tests/release.test.mjs
    PATH="{{ shellcheck }}:$PATH" "{{ actionlint }}" .github/workflows/*.yml
    "{{ zizmor }}" --min-severity medium .github actions

# The documented caller workflow is valid.
test:
    PATH="{{ shellcheck }}:$PATH" "{{ actionlint }}" examples/*.yml
    rustc --edition 2024 --test tests/recipe-routing.rs -o "{{ tools }}/recipe-routing-tests"
    "{{ tools }}/recipe-routing-tests"
    node --test tests/*.test.mjs
    node --test tests/bootstrap-tools.mjs
    node --test tests/dependency-native.mjs
    node --test tests/daily-osv-native.mjs
    node --test tests/daily-sbom-native.mjs

# Everything the full check on dev runs.
verify: check test

# Applies formatting.
fix:
    just --fmt

# Prepares only verified source generations; checks never download or change retained tools.
tools: (_tools "setup")

[private]
_tools mode:
    #!/usr/bin/env bash
    set -euo pipefail
    umask 077
    mode="{{ mode }}"
    case "$mode" in setup|check) ;; *) echo "Unknown tool preparation mode" >&2; exit 1 ;; esac
    stage=""
    cleanup() { if [ -n "$stage" ]; then rm -rf -- "$stage"; fi; }
    trap cleanup EXIT
    if [ "$mode" = setup ]; then
      mkdir -p "{{ tools }}/checks"
      exec 9> "{{ tools }}/checks/.bootstrap.lock"
      flock 9
      rm -rf -- "{{ tools }}"/checks/.prepare.*
    fi
    fetch() {
      local tool=$1 version=$2 sha=$3 expected=$4
      local folder="{{ tools }}/checks/$tool-$sha"
      local name identity output first digest
      case "$tool" in
        actionlint) name="actionlint_${version}_linux_amd64.tar.gz"; identity="rhysd/actionlint@v$version/$name $sha" ;;
        zizmor) name="zizmor-$version-py3-none-manylinux_2_28_x86_64.whl"; identity="pypi:zizmor@$version/$name $sha" ;;
        shellcheck) name="shellcheck-v$version.linux.x86_64.tar.gz"; identity="koalaman/shellcheck@v$version/$name $sha" ;;
        *) exit 1 ;;
      esac
      valid() {
        local recorded computed
        [ -d "$folder" ] && [ ! -L "$folder" ] &&
          [ -x "$folder/$tool" ] && [ ! -L "$folder/$tool" ] &&
          [ -f "$folder/source" ] && [ ! -L "$folder/source" ] &&
          [ -f "$folder/sha256" ] && [ ! -L "$folder/sha256" ] &&
          [ "$(cat "$folder/source")" = "$identity" ] || return 1
        recorded=$(cat "$folder/sha256") || return 1
        [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || return 1
        computed=$(sha256sum "$folder/$tool") || return 1
        [ "$recorded" = "${computed%% *}" ] || return 1
        output=$("$folder/$tool" --version) || return 1
        first=${output%%$'\n'*}
        if [ "$tool" = shellcheck ]; then first=$(sed -n 2p <<< "$output"); fi
        [ "$first" = "$expected" ] || [[ "$first" == "$expected "* ]]
      }
      if valid; then return; fi
      if [ "$mode" = check ]; then
        printf 'Check tool %s differs from its pin; run just setup.\n' "$tool" >&2
        exit 1
      fi
      printf 'Preparing check tool %s (%s)\n' "$tool" "$version"
      stage=$(mktemp -d "{{ tools }}/checks/.prepare.XXXXXX")
      mkdir "$stage/ready"
      if [ "$tool" = actionlint ] || [ "$tool" = shellcheck ]; then
        repository=rhysd/actionlint
        if [ "$tool" = shellcheck ]; then repository=koalaman/shellcheck; fi
        auth=()
        if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
        if [ -n "${NDDEV_CI_ARTIFACT_REGISTRY:-}" ]; then
          curl -fsSL -o "$stage/archive" "${NDDEV_CI_ARTIFACT_REGISTRY%/}/github-releases/sha256/$sha/$repository/releases/download/v$version/$name"
        else
          asset=$(curl -fsSL "${auth[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repository/releases/tags/v$version" |
            jq -er --arg name "$name" '[.assets[] | select(.name == $name)] | if length == 1 then .[0].id | numbers else error("release asset is missing or ambiguous") end')
          curl -fsSL "${auth[@]}" -H 'Accept: application/octet-stream' -o "$stage/archive" "https://api.github.com/repos/$repository/releases/assets/$asset"
        fi
      else
        if [ -n "${NDDEV_CI_ARTIFACT_REGISTRY:-}" ]; then
          metadata="${NDDEV_CI_ARTIFACT_REGISTRY%/}/pypi/simple/zizmor/"
          origin="${NDDEV_CI_ARTIFACT_REGISTRY%/}/pypi-files/"
        else
          metadata="https://pypi.org/simple/zizmor/"
          origin="https://files.pythonhosted.org/"
        fi
        url=$(curl -fsSL -H 'Accept: application/vnd.pypi.simple.v1+json' "$metadata" |
          jq -er --arg name "$name" '[.files[] | select(.filename == $name)] | if length == 1 then .[0].url | strings else error("wheel is missing or ambiguous") end')
        case "$url" in "$origin"*) ;; *) echo "Wheel origin differs from the configured registry" >&2; exit 1 ;; esac
        curl -fsSL -o "$stage/archive" "$url"
      fi
      echo "$sha  $stage/archive" | sha256sum --check --quiet
      if [ "$tool" = actionlint ]; then
        tar -xOzf "$stage/archive" actionlint > "$stage/ready/$tool"
      elif [ "$tool" = shellcheck ]; then
        tar -xOzf "$stage/archive" "shellcheck-v$version/shellcheck" > "$stage/ready/$tool"
      else
        # The pinned wheel contains one standalone ELF, with no Python runtime dependencies.
        python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$stage/archive" "zizmor-$version.data/scripts/zizmor" > "$stage/ready/$tool"
      fi
      chmod 0755 "$stage/ready/$tool"
      output=$("$stage/ready/$tool" --version)
      first=${output%%$'\n'*}
      if [ "$tool" = shellcheck ]; then first=$(sed -n 2p <<< "$output"); fi
      if [ "$first" != "$expected" ] && [[ "$first" != "$expected "* ]]; then
        printf 'Check tool version differs: expected %s, received %s.\n' "$expected" "$first" >&2
        exit 1
      fi
      digest=$(sha256sum "$stage/ready/$tool" | cut -d ' ' -f 1)
      printf '%s\n' "$identity" > "$stage/ready/source"
      printf '%s\n' "$digest" > "$stage/ready/sha256"
      if [ -e "$folder" ] || [ -L "$folder" ]; then mv -T -- "$folder" "$stage/obsolete"; fi
      mv -T -- "$stage/ready" "$folder"
      valid
      cleanup
      stage=""
    }
    fetch actionlint {{ actionlint_version }} {{ actionlint_sha256 }} "{{ actionlint_version }}"
    fetch zizmor {{ zizmor_version }} {{ zizmor_sha256 }} "zizmor {{ zizmor_version }}"
    fetch shellcheck {{ shellcheck_version }} {{ shellcheck_sha256 }} "version: {{ shellcheck_version }}"
    if [ "$mode" = setup ]; then
      rm -f -- "{{ tools }}/actionlint" "{{ tools }}/actionlint.tar.gz"
      rm -rf -- "{{ tools }}/zizmor"
      for previous in "{{ tools }}"/checks/*; do
        case "$previous" in
          "{{ tools }}/checks/actionlint-{{ actionlint_sha256 }}"|"{{ tools }}/checks/zizmor-{{ zizmor_sha256 }}"|"{{ tools }}/checks/shellcheck-{{ shellcheck_sha256 }}") continue ;;
        esac
        if [[ "${previous##*/}" =~ ^(actionlint|zizmor|shellcheck)-[a-f0-9]{64}$ ]]; then rm -rf -- "$previous"; fi
      done
    fi
