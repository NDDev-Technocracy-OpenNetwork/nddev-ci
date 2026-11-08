set shell := ["bash", "-euo", "pipefail", "-c"]

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
    node -e 'const {execFileSync}=require("node:child_process"); const p=require("./actions/recipe/just.json"); if(execFileSync("just",["--version"],{encoding:"utf8"}).trim()!=="just "+p.version)process.exit(1)'
