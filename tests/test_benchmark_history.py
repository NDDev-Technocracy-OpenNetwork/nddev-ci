"""Vendor-native benchmark history must establish actual comparable work and preserve acceptance."""

import json

import pytest

from nddev_cicd import reports
from nddev_cicd.model import Invalid


def history(suites):
    return {
        "repoUrl": "https://github.com/example/fixture",
        "lastUpdate": 1,
        "entries": {"Benchmark": suites},
    }


def suite(commit, benches=None):
    return {
        "tool": "go",
        "commit": {"id": commit},
        "benches": benches
        if benches is not None
        else [{"name": "BenchmarkNative", "value": 2, "unit": "ns/op"}],
    }


def test_same_commit_sdk_skip_cannot_be_reported_as_a_pass(tmp_path):
    path = tmp_path / "native.json"
    path.write_text(json.dumps(history([suite("same"), suite("same")])))
    with pytest.raises(Invalid, match="distinct"):
        reports.benchmark_history(path, "go", "https://github.com/example/fixture", comparison=True)


@pytest.mark.parametrize(
    "benches",
    [
        [],
        [{"name": "Native", "value": 0, "unit": "ns/op"}],
        [{"name": "Native", "value": float("nan"), "unit": "ns/op"}],
        [{"name": "Other", "value": 2, "unit": "ns/op"}],
    ],
)
def test_missing_or_changed_measurements_do_not_establish_comparison(tmp_path, benches):
    path = tmp_path / "native.json"
    path.write_text(json.dumps(history([suite("baseline"), suite("candidate", benches)])))
    with pytest.raises(Invalid):
        reports.benchmark_history(path, "go", "https://github.com/example/fixture", comparison=True)


def test_preparation_copies_accepted_history_and_keeps_original_bytes(tmp_path):
    root, temporary = tmp_path / "caller", tmp_path / "job"
    root.mkdir()
    temporary.mkdir()
    (root / "go.txt").write_text("native measurement fixture")
    accepted = root / "accepted.json"
    accepted.write_text(json.dumps(history([suite("baseline")])))
    before = accepted.read_bytes()
    result = reports.benchmark_prepare(
        root, temporary, "go.txt", "accepted.json", "go", "compare", 2, "https://github.com/example/fixture"
    )
    from pathlib import Path

    assert Path(result["history"]) != accepted and accepted.read_bytes() == before
    Path(result["history"]).write_text("controlled SDK failure")
    assert accepted.read_bytes() == before
    with pytest.raises(Invalid):
        reports.benchmark_prepare(
            root, temporary, "go.txt", "", "go", "compare", 2, "https://github.com/example/fixture"
        )
