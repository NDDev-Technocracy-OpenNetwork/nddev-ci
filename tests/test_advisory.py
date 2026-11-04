"""An explicit exception compares actual runtime packages, never repository source guesses."""

import copy

import pytest

from nddev_cicd.advisory import compare
from nddev_cicd.model import Invalid

CANDIDATE = "sha256:" + "a" * 64
PRODUCTION = "sha256:" + "b" * 64
PURL = "pkg:pypi/example@1.2.3"


def report(image, *, purl=PURL, version="1.2.3", finding=False, kind="python-pkg"):
    row = {
        "Class": "lang-pkgs",
        "Type": kind,
        "Target": "/app/requirements.txt",
        "Packages": [{"Identifier": {"PURL": purl}, "Version": version}],
    }
    if finding:
        row["Vulnerabilities"] = [
            {"VulnerabilityID": "GHSA-fixture", "PkgIdentifier": {"PURL": purl}, "InstalledVersion": version}
        ]
    return {
        "SchemaVersion": 2,
        "ArtifactType": "container_image",
        "Metadata": {"ImageID": image},
        "Results": [row],
    }


def evaluate(candidate=None, production=None):
    return compare(
        candidate or report(CANDIDATE, finding=True),
        production or report(PRODUCTION),
        candidate_image=CANDIDATE,
        production_image=PRODUCTION,
        component="backend",
    )


def test_new_upstream_advisory_on_existing_runtime_package_is_compared_without_fabricating_green_ci():
    result = evaluate()
    assert result["disposition"] == "preexisting-packages-only"
    assert len(result["preexisting"]) == 1 and not result["introduced"]
    assert "status" not in result


@pytest.mark.parametrize(
    "production",
    [
        report(PRODUCTION, purl="pkg:pypi/example@2.0.0", version="2.0.0"),
        report(PRODUCTION, purl="pkg:npm/example@1.2.3", kind="npm"),
    ],
)
def test_reintroducing_a_fixed_version_or_another_ecosystems_package_is_new(production):
    result = evaluate(production=production)
    assert result["disposition"] == "introduced-advisories"
    assert len(result["introduced"]) == 1


def test_a_package_only_at_another_runtime_path_does_not_establish_unchanged_exposure():
    baseline = report(PRODUCTION)
    baseline["Results"][0]["Target"] = "/build/requirements.txt"
    assert evaluate(production=baseline)["introduced"]


@pytest.mark.parametrize("mutation", ["other-image", "missing-packages", "missing-purl", "source-lock-only"])
def test_missing_or_unbound_production_inventory_never_admits_an_exception(mutation):
    baseline = report(PRODUCTION)
    if mutation == "other-image":
        baseline["Metadata"]["ImageID"] = CANDIDATE
    elif mutation == "missing-packages":
        del baseline["Results"][0]["Packages"]
    elif mutation == "missing-purl":
        baseline["Results"][0]["Packages"][0]["Identifier"] = {}
    else:
        baseline = {"package": [{"name": "example", "version": "1.2.3"}]}
    with pytest.raises(Invalid):
        evaluate(production=baseline)


def test_empty_failed_report_and_unidentifiable_finding_are_not_advisory_evidence():
    with pytest.raises(Invalid, match="actual reported findings"):
        evaluate(candidate=report(CANDIDATE))
    missing = report(CANDIDATE, finding=True)
    del missing["Results"][0]["Vulnerabilities"][0]["PkgIdentifier"]
    with pytest.raises(Invalid):
        evaluate(candidate=missing)


def test_comparison_preserves_the_original_native_reports():
    candidate, production = report(CANDIDATE, finding=True), report(PRODUCTION)
    before = copy.deepcopy([candidate, production])
    evaluate(candidate, production)
    assert [candidate, production] == before
