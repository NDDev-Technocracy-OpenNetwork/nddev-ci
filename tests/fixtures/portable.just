set shell := ["bash", "-euo", "pipefail", "-c"]

probe first second third:
    @test {{ quote(first) }} = 'path with spaces'
    @test {{ quote(second) }} = '$(must-stay-literal)'
    @test {{ quote(third) }} = 'مرحبا-Ә-测试'
    @printf 'Portable recipe arguments preserved.\n'
