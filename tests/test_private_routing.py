import json
import shutil
import subprocess
from pathlib import Path

import pytest

from nddev_cicd import routing
from nddev_cicd.model import Invalid

# The contract agreed with the fleet controller: it writes NDDEV_ROUTE_LABELS and NDDEV_RUN_ROUTES,
# the expression only reads them. Pinned literally so a drift on either side is a reviewed change.
CANONICAL = (
    "${{ fromJSON(vars.NDDEV_ROUTE_LABELS || '{}')[format('{0}/{1}', "
    "fromJSON(vars.NDDEV_RUN_ROUTES || '{}')[github.run_id] || 'self', 'nddev-linux-small')] "
    "|| 'nddev-linux-small' }}"
)


def test_route_expression_is_the_controller_contract():
    assert routing.route_expression("nddev-linux-small") == CANONICAL
    reusable = routing.route_expression("", reusable=True)
    assert "inputs.runner-class)] || inputs.runner-class }}" in reusable


def test_unknown_class_is_refused():
    with pytest.raises(Invalid):
        routing.route_expression("ubuntu-24.04")


def _resolve(expression: str, labels: dict, routes: dict, run_id: str) -> str:
    """Evaluate the expression the way GitHub does for these inputs (string keys, `||` fallbacks)."""
    runner_class = expression.split("'self', '")[1].split("'")[0]
    tier = routes.get(run_id) or "self"
    return labels.get(f"{tier}/{runner_class}") or runner_class


@pytest.mark.parametrize(
    ("routes", "expected"),
    [
        ({}, "nddev-linux-small"),
        ({"7": "blacksmith"}, "blacksmith-2vcpu-ubuntu-2404"),
        ({"7": "hosted"}, "ubuntu-24.04"),
        ({"8": "hosted"}, "nddev-linux-small"),
    ],
)
def test_an_unmoved_run_keeps_its_class_and_a_moved_run_takes_its_tier(routes, expected):
    labels = {
        "blacksmith/nddev-linux-small": "blacksmith-2vcpu-ubuntu-2404",
        "hosted/nddev-linux-small": "ubuntu-24.04",
    }
    assert _resolve(routing.route_expression("nddev-linux-small"), labels, routes, "7") == expected


def test_private_jobs_classify_routed_fixed_hosted_and_invalid(tmp_path: Path):
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    route = routing.route_expression("nddev-linux")
    (workflows / "ci.yml").write_text(
        f"""
jobs:
  routed:
    runs-on: "{route}"
  sdk:
    runs-on: [self-hosted, Linux, X64, nddev-linux-small]
  mac:
    runs-on: macos-15
  linux-hosted:
    runs-on: ubuntu-24.04
  lane:
    runs-on: ${{{{ vars.RUNNER_LANE || 'nddev-linux-standart' }}}}
  pool:
    runs-on: curestry-new-deploy
  edited:
    runs-on: ${{{{ fromJSON(vars.NDDEV_ROUTE_LABELS || '{{}}')['self/nddev-linux'] || 'nddev-linux' }}}}
  reuse:
    uses: ./.github/workflows/other.yml
"""
    )
    verdicts = {item["job"]: item["verdict"] for item in routing.private_jobs(tmp_path)}
    assert verdicts == {
        "routed": "routed",
        "sdk": "fixed",
        "mac": "hosted",
        "linux-hosted": "invalid",
        "lane": "fixed",
        "pool": "fixed",
        "edited": "invalid",
    }


def test_runners_check_private_fails_only_on_invalid(tmp_path: Path):
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "ci.yml").write_text(
        f"""
jobs:
  routed:
    runs-on: "{routing.route_expression("nddev-linux-small")}"
  sdk:
    runs-on: [self-hosted, Linux, X64, nddev-linux-small]
"""
    )
    command = ["uv", "run", "--locked", "python", "-m", "nddev_cicd"]
    result = subprocess.run(
        [*command, "runners-check", "--visibility", "private", "--root", str(tmp_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(result.stdout)
    assert result.returncode == 0, result.stderr
    assert [item["job"] for item in report["routed"]] == ["routed"]
    assert [item["job"] for item in report["fixed"]] == ["sdk"]


@pytest.mark.skipif(shutil.which("actionlint") is None, reason="actionlint is not installed")
def test_actionlint_accepts_the_route_expression(tmp_path: Path):
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "ci.yml").write_text(
        f"""on: push
jobs:
  build:
    runs-on: {routing.route_expression("nddev-linux-small")}
    steps:
      - run: echo ok
"""
    )
    (tmp_path / ".github" / "actionlint.yaml").write_text(
        "self-hosted-runner:\n  labels:\n    - nddev-linux-small\n"
    )
    subprocess.run(["git", "init", "--quiet"], cwd=tmp_path, check=True)
    result = subprocess.run(
        ["actionlint", "-config-file", ".github/actionlint.yaml", ".github/workflows/ci.yml"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
