"""Real Go measurements and controlled SDK history fixtures; no application performance claim."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def git(*arguments):
    return subprocess.check_output(["git", *arguments], text=True).strip()


mode, directory = sys.argv[1], Path(sys.argv[2]).resolve()
directory.mkdir(parents=True, exist_ok=True)
if mode == "prepare":
    previous = git("rev-parse", "HEAD^")
    source = "tests/native/go/checksum.go"
    before = subprocess.check_output(["git", "show", previous + ":" + source])
    assert before == Path(source).read_bytes(), "The SDK baseline fixture must identify the actual old source"
    (directory / "baseline-source.txt").write_text(previous)
    (directory / "go.mod").write_bytes(Path("tests/native/go/go.mod").read_bytes())
    (directory / "checksum.go").write_bytes(before)
    (directory / "benchmark_test.go").write_text("""package ciwf
import "testing"
var measuredChecksum int
func BenchmarkNativeChecksum(b *testing.B) {
    for i:=0;i<b.N;i++ { measuredChecksum=Checksum("native benchmark fixture") }
}
""")
    # The actual package name, not a parallel test-only implementation, owns compilation.
    package = before.decode().split("package ", 1)[1].splitlines()[0].strip()
    benchmark = directory / "benchmark_test.go"
    benchmark.write_text(benchmark.read_text().replace("package ciwf", "package " + package, 1))
    subprocess.run(["gofmt", "-w", str(benchmark)], check=True)
    with (directory / "before.txt").open("w") as stream:
        subprocess.run(
            ["go", "test", "-run", "^$", "-bench", "BenchmarkNativeChecksum", "-benchtime=100ms", "-count=1"],
            cwd=directory,
            check=True,
            stdout=stream,
        )
elif mode == "baseline":
    # The vendor action knows the instrumentation workflow commit. This controlled fixture
    # labels the *measured Go implementation* with its actual extracted earlier Git source.
    # Native measurements/units/names remain byte-for-byte SDK-produced; no numbers are forged.
    history = Path(sys.argv[3])
    data = json.loads(history.read_text())
    data["entries"]["Benchmark"][-1]["commit"]["id"] = (directory / "baseline-source.txt").read_text()
    (directory / "accepted.json").write_text(json.dumps(data))
    (directory / "accepted.sha256").write_text(
        hashlib.sha256((directory / "accepted.json").read_bytes()).hexdigest()
    )
elif mode == "verify":
    from nddev_cicd.reports import benchmark_history

    assert os.environ["NEGATIVE_OUTCOME"] == "failure", "The native regression must actually fail"
    assert not os.environ["NEGATIVE_HISTORY"], "A rejected candidate must not emit accepted history"
    assert (
        hashlib.sha256((directory / "accepted.json").read_bytes()).hexdigest()
        == (directory / "accepted.sha256").read_text()
    )
    benchmark_history(
        Path(os.environ["POSITIVE_HISTORY"]),
        "go",
        os.environ["GITHUB_SERVER_URL"] + "/" + os.environ["GITHUB_REPOSITORY"],
        comparison=True,
    )
elif mode in {"positive", "negative"}:
    if mode == "negative":
        benchmark = directory / "benchmark_test.go"
        source = benchmark.read_text()
        source = source.replace('import "testing"', 'import "testing"\nimport "time"')
        source = source.replace(
            "measuredChecksum = Checksum(", "time.Sleep(20*time.Microsecond)\nmeasuredChecksum = Checksum("
        )
        if "time.Sleep" not in source:
            raise RuntimeError("The controlled native performance defect was not installed")
        benchmark.write_text(source)
        subprocess.run(["gofmt", "-w", str(benchmark)], check=True)
    with (directory / (mode + ".txt")).open("w") as stream:
        subprocess.run(
            ["go", "test", "-run", "^$", "-bench", "BenchmarkNativeChecksum", "-benchtime=100ms", "-count=1"],
            cwd=directory,
            check=True,
            stdout=stream,
        )
else:
    raise SystemExit("Unsupported native fixture operation")
if os.environ.get("GITHUB_OUTPUT"):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("directory=" + str(directory) + "\n")
