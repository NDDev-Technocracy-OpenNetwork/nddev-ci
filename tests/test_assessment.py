"""Native host assessments are neither empty work nor implicit project policy."""

import json

import pytest

from nddev_cicd import reports
from nddev_cicd.model import Invalid


def test_advisory_assessment_retains_unknown_checks_without_claiming_them_passed(tmp_path):
    path = tmp_path / "native.json"
    path.write_text(
        json.dumps(
            {
                "repo": {"name": "github.com/example/fixture"},
                "checks": [
                    {"name": "Pinned-Dependencies", "score": 8},
                    {"name": "Branch-Protection", "score": -1},
                ],
            }
        )
    )
    result = reports.scorecard(path, "example/fixture", {})
    assert result["assessment"] == "advisory" and result["unavailable"] == ["Branch-Protection"]
    assert reports.scorecard(path, "example/fixture", {"Branch-Protection": 0})["status"] == "failure"
    assert reports.scorecard(path, "example/fixture", {"Pinned-Dependencies": 9})["status"] == "failure"


@pytest.mark.parametrize(
    "checks",
    [
        [],
        [{"name": "Native", "score": -1}],
        [{"name": "Native", "score": True}],
        [{"name": "Native", "score": 7}, {"name": "Native", "score": 9}],
    ],
)
def test_empty_or_unavailable_native_work_is_not_an_assessment(tmp_path, checks):
    path = tmp_path / "native.json"
    path.write_text(json.dumps({"repo": {"name": "github.com/example/fixture"}, "checks": checks}))
    with pytest.raises(Invalid):
        reports.scorecard(path, "example/fixture", {})
