"""A final native gate cannot hide missing leaves or failed selected work."""

import json

import pytest

from nddev_cicd.__main__ import main
from nddev_cicd.gate import evaluate
from nddev_cicd.model import Invalid


def test_scope_and_event_non_applicability_remain_explicit():
    expected = {"classifier": "success", "selected": "success", "unaffected": "skipped", "main": "skipped"}
    actual = {name: {"result": result, "outputs": {}} for name, result in expected.items()}
    assert evaluate(actual, expected)["jobs"] == expected


@pytest.mark.parametrize("result", ["skipped", "failure", "cancelled", "timed_out", None, ""])
def test_selected_work_must_actually_succeed(result):
    with pytest.raises(Invalid, match="selected"):
        evaluate({"selected": {"result": result}}, {"selected": "success"})


@pytest.mark.parametrize("actual", [{}, {"other": {"result": "success"}}, {"selected": "success"}])
def test_missing_unknown_or_malformed_leaves_never_pass(actual):
    with pytest.raises(Invalid):
        evaluate(actual, {"selected": "success"})


@pytest.mark.parametrize(
    "expected", [{}, {"irrelevant": "skipped"}, {"a": "failure"}, {"bad\njob": "success"}, []]
)
def test_empty_or_invalid_expectation_is_not_success(expected):
    with pytest.raises(Invalid):
        evaluate({}, expected)


def test_unselected_job_running_is_a_scope_mismatch():
    with pytest.raises(Invalid, match="unaffected"):
        evaluate(
            {"classifier": {"result": "success"}, "unaffected": {"result": "success"}},
            {"classifier": "success", "unaffected": "skipped"},
        )


@pytest.mark.parametrize("scopes", [{}, {"backend": ""}, {"backend": "unknown"}, {"backend": False}, []])
def test_missing_or_malformed_classifier_outputs_cannot_hide_selected_work(scopes):
    with pytest.raises(Invalid, match="Classifier"):
        evaluate({"classifier": {"result": "success"}}, {"classifier": "success"}, scopes)


def test_raw_classifier_outputs_are_validated_before_the_leaf_verdict():
    assert (
        evaluate(
            {"classifier": {"result": "success"}},
            {"classifier": "success"},
            {"backend": "true", "docs": "false"},
        )["status"]
        == "success"
    )


def test_native_cli_preserves_failure(monkeypatch, capsys):
    monkeypatch.setattr(
        "sys.argv", ["nddev-cicd", "gate", "--needs", "{}", "--expected", '{"lint":"success"}']
    )
    assert main() == 2
    assert "exactly match" in capsys.readouterr().err
    monkeypatch.setattr(
        "sys.argv",
        [
            "nddev-cicd",
            "gate",
            "--needs",
            '{"lint":{"result":"success"}}',
            "--expected",
            '{"lint":"success"}',
        ],
    )
    assert main() == 0
    assert json.loads(capsys.readouterr().out)["status"] == "success"
