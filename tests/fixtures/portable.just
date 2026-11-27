set shell := ["bash", "-euo", "pipefail", "-c"]

environment-probe:
    node --version
    python --version
    uv --version
    bun --version
    rustc --version
    cargo clippy --version
    cargo fmt --version

probe first second third:
    @test {{ quote(first) }} = 'path with spaces'
    @test {{ quote(second) }} = '$(must-stay-literal)'
    @test {{ quote(third) }} = 'مرحبا-Ә-测试'
    @printf 'Portable recipe arguments preserved.\n'

[script("bash")]
script-probe first second third:
    set -euo pipefail
    test {{ quote(first) }} = 'path with spaces'
    test {{ quote(second) }} = '$(must-stay-literal)'
    test {{ quote(third) }} = 'مرحبا-Ә-测试'
    node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {hostedJustPin} from "./lib/hosted-compat-pins.mjs"; const p=hostedJustPin({RUNNER_ENVIRONMENT:"github-hosted"}); if(execFileSync("just",["--version"],{encoding:"utf8"}).trim()!=="just "+p.version)process.exit(1)'

profile-probe platform:
    @test "$(node -p 'process.platform + "-" + process.arch')" = {{ quote(platform) }}
