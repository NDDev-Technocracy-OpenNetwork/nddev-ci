"""Native SARIF severity resolution controls for issue 173 (OASIS 2.1.0 + Errata 01)."""

import copy
import json

import pytest

from nddev_cicd.model import Invalid
from nddev_cicd.reports import sarif


def report(tmp_path, *, extension=False, default="error"):
    rule = {"id": "example/rule", "guid": "11111111-1111-4111-8111-111111111111"}
    if default is not None:
        rule["defaultConfiguration"] = {"level": default}
    driver = {"name": "CodeQL", "rules": [rule]}
    reference = {"index": 0, "id": rule["id"]}
    tool = {"driver": driver}
    if extension:
        tool["extensions"] = [{"name": "example-pack", "rules": [rule]}]
        driver["rules"] = []
        reference["toolComponent"] = {"index": 0}
    result = {"rule": reference, "message": {"text": "Synthetic native severity finding"}}
    run = {"tool": tool, "invocations": [{"executionSuccessful": True}], "results": [result]}
    return run, result, rule


def check(tmp_path, run):
    (tmp_path / "result.sarif").write_text(json.dumps({"version": "2.1.0", "runs": [run]}))
    return sarif(tmp_path)


@pytest.mark.parametrize("extension", [False, True])
@pytest.mark.parametrize("level", ["error", "warning", "note", None])
def test_inherited_rule_level(tmp_path, extension, level):
    run, _, _ = report(tmp_path, extension=extension, default=level)
    actual = check(tmp_path, run)
    assert actual["findings"][0]["blocking"] is (level == "error")
    assert actual["status"] == ("failure" if level == "error" else "success")


@pytest.mark.parametrize("extension", [False, True])
@pytest.mark.parametrize("level", ["error", "warning", "note", "none"])
def test_explicit_result_level_wins_over_rule_and_invocation(tmp_path, extension, level):
    run, result, _ = report(tmp_path, extension=extension)
    run["invocations"][0]["ruleConfigurationOverrides"] = [
        {"descriptor": copy.deepcopy(result["rule"]), "configuration": {"level": "error"}}
    ]
    result["level"] = level
    assert check(tmp_path, run)["findings"][0]["blocking"] is (level == "error")


@pytest.mark.parametrize("extension", [False, True])
@pytest.mark.parametrize("override", ["error", "warning", "note", None])
def test_single_invocation_default_and_partial_configuration(tmp_path, extension, override):
    run, result, _ = report(tmp_path, extension=extension)
    configuration = {"enabled": True} if override is None else {"level": override}
    run["invocations"][0]["ruleConfigurationOverrides"] = [
        {"descriptor": copy.deepcopy(result["rule"]), "configuration": configuration}
    ]
    assert check(tmp_path, run)["findings"][0]["blocking"] is (override in {"error", None})


@pytest.mark.parametrize("index,blocking", [(0, True), (1, False), (-1, True), (None, True)])
def test_multiple_invocations_do_not_borrow_another_invocations_override(tmp_path, index, blocking):
    run, result, _ = report(tmp_path)
    run["invocations"].append(
        {
            "executionSuccessful": True,
            "ruleConfigurationOverrides": [
                {"descriptor": {"index": 0}, "configuration": {"level": "warning"}}
            ],
        }
    )
    if index is not None:
        result["provenance"] = {"invocationIndex": index}
    assert check(tmp_path, run)["findings"][0]["blocking"] is blocking


def test_override_is_scoped_to_exact_component_and_descriptor(tmp_path):
    run, result, _ = report(tmp_path, extension=True)
    run["tool"]["driver"]["rules"] = [{"id": "example/rule"}]
    run["invocations"][0]["ruleConfigurationOverrides"] = [
        {"descriptor": {"index": 0}, "configuration": {"level": "warning"}}
    ]
    assert check(tmp_path, run)["status"] == "failure"
    result["rule"] = {"index": 0}
    assert check(tmp_path, run)["status"] == "success"


def test_guid_references_and_hierarchical_subrule_keep_the_same_rule(tmp_path):
    run, result, rule = report(tmp_path, extension=True)
    component = run["tool"]["extensions"][0]
    component["guid"] = "22222222-2222-4222-8222-222222222222"
    result["rule"] = {
        "guid": rule["guid"],
        "id": rule["id"] + "/subcase",
        "toolComponent": {"guid": component["guid"]},
    }
    run["invocations"][0]["ruleConfigurationOverrides"] = [
        {
            "descriptor": {"index": 0, "toolComponent": {"index": 0}},
            "configuration": {"level": "warning"},
        }
    ]
    assert check(tmp_path, run)["status"] == "success"


@pytest.mark.parametrize("score,level,blocking", [("8.5", "note", True), ("0.5", "error", False)])
def test_numeric_codeql_security_severity_keeps_existing_threshold(tmp_path, score, level, blocking):
    run, result, rule = report(tmp_path)
    rule["properties"] = {"security-severity": score}
    result["level"] = level
    assert check(tmp_path, run)["findings"][0]["blocking"] is blocking


@pytest.mark.parametrize("index", [True, 1.5, -2, 8])
def test_invalid_invocation_reference_is_not_success(tmp_path, index):
    run, result, _ = report(tmp_path)
    result["provenance"] = {"invocationIndex": index}
    with pytest.raises(Invalid):
        check(tmp_path, run)


@pytest.mark.parametrize(
    "reference",
    [
        {"index": 9, "id": "example/rule"},
        {"index": True},
        {"index": 0, "id": "another-rule"},
        {"index": 0, "guid": "33333333-3333-4333-8333-333333333333"},
        {"index": 0, "toolComponent": {"index": 9}},
        {"index": 0, "toolComponent": {"name": "foreign-driver"}},
    ],
)
def test_unknown_or_conflicting_descriptor_is_rejected(tmp_path, reference):
    run, result, _ = report(tmp_path)
    result["rule"] = reference
    with pytest.raises(Invalid):
        check(tmp_path, run)


def test_conflicting_legacy_and_descriptor_identity_is_rejected(tmp_path):
    run, result, _ = report(tmp_path)
    result["ruleId"] = "foreign-rule"
    with pytest.raises(Invalid):
        check(tmp_path, run)


def test_ambiguous_id_and_duplicate_overrides_cannot_choose_a_nonblocking_rule(tmp_path):
    run, result, rule = report(tmp_path)
    run["tool"]["driver"]["rules"].append(copy.deepcopy(rule))
    result["rule"] = {"id": rule["id"]}
    with pytest.raises(Invalid):
        check(tmp_path, run)
    result["rule"] = {"index": 0}
    run["invocations"][0]["ruleConfigurationOverrides"] = [
        {"descriptor": {"index": 0}, "configuration": {"level": "warning"}},
        {"descriptor": {"index": 0}, "configuration": {"level": "note"}},
    ]
    with pytest.raises(Invalid):
        check(tmp_path, run)


@pytest.mark.parametrize("level", ["critical", "", None, True])
def test_invalid_inherited_level_is_not_a_nonblocking_result(tmp_path, level):
    run, _, rule = report(tmp_path)
    rule["defaultConfiguration"]["level"] = level
    with pytest.raises(Invalid):
        check(tmp_path, run)
