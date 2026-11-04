"""Inspect the actual cross-platform action results and this attempt's native upload policy."""

import json
import os
import subprocess
from pathlib import Path

paths = [Path(os.environ[key]) for key in ("POSITIVE", "NEGATIVE", "NEVER")]
assert len(set(paths)) == 3 and os.environ["NEGATIVE_OUTCOME"] == "failure"
for directory, expected in zip(paths, ["success", "failure", "success"], strict=True):
    result = json.loads((directory / "result.json").read_text())
    assert result["status"] == expected
    assert "uv 0.12.24 " in (directory / "tool.uv.log").read_text()
assert "native action diagnostic fixture" in (paths[1] / "documentation.examples.log").read_text()
response = json.loads(
    subprocess.check_output(
        [
            "gh",
            "api",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}/artifacts?per_page=100",
        ]
    )
)
base = f"nddev-source-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}-contract-{os.environ['RUNNER_OS']}-"
names = {item["name"] for item in response["artifacts"]}
assert base + "negative" in names and base + "positive" not in names and base + "never" not in names
print("Caller executable, independent results, failed diagnostics and actual upload policies verified")

compressed = next(
    item["size_in_bytes"] for item in response["artifacts"] if item["name"] == base + "negative"
)
raw = sum(p.stat().st_size for p in paths[1].rglob("*") if p.is_file())
assert compressed < raw // 2, (compressed, raw)
print(f"Native uploaded result compression: {compressed} bytes for {raw} uncompressed bytes")
