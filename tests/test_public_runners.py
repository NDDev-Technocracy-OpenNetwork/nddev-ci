from pathlib import Path

import pytest

from nddev_cicd import routing


@pytest.mark.parametrize(
    ("platform", "architecture", "label"),
    [
        ("linux", "x64", "ubuntu-26.04"),
        ("linux", "arm64", "ubuntu-26.04-arm"),
        ("windows", "x64", "windows-2025"),
        ("windows", "arm64", "windows-11-arm"),
        ("macos", "arm64", "macos-15"),
        ("macos", "x64", "macos-15-intel"),
    ],
)
def test_public_work_routes_to_the_free_standard_label(platform, architecture, label):
    result = routing.select("public", platform, architecture=architecture)
    assert result == {"provider": "github", "runner": [label], "basis": "standard-public"}
    assert routing.public_label(label)[0] == "standard"


@pytest.mark.parametrize(
    ("label", "verdict"),
    [
        ("ubuntu-latest", "floating"),
        ("macos-latest", "floating"),
        ("macos-14", "retiring"),
        ("ubuntu-22.04", "retiring"),
        ("ubuntu-latest-8-cores", "larger"),
        ("ubuntu-24.04-16-cores", "larger"),
        ("macos-15-xlarge", "larger"),
        ("windows-2025-large", "larger"),
        ("my-runner", "unknown"),
    ],
)
def test_labels_outside_the_free_standard_set_are_named(label, verdict):
    assert routing.public_label(label)[0] == verdict


def test_workflow_labels_include_matrix_values_and_skip_self_hosted(tmp_path: Path):
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "ci.yml").write_text(
        """
jobs:
  lint:
    runs-on: ubuntu-26.04
  platforms:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-14, windows-2025, macos-15-xlarge]
  private:
    runs-on: [self-hosted, Linux, X64]
  reuse:
    uses: ./.github/workflows/other.yml
"""
    )
    verdicts = {item["label"]: item["verdict"] for item in routing.workflow_labels(tmp_path)}
    assert verdicts == {
        "ubuntu-26.04": "standard",
        "macos-14": "retiring",
        "windows-2025": "standard",
        "macos-15-xlarge": "larger",
    }
