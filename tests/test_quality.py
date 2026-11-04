"""Native report and CI-contract boundaries; fixtures are not coverage measurements."""

import json
import sys

import pytest

from nddev_cicd import advanced, ci, config, quality
from nddev_cicd.model import Invalid


@pytest.mark.parametrize(
    "format,suffix,body,metric",
    [
        (
            "cobertura",
            "xml",
            '<coverage lines-valid="4" lines-covered="3" branches-valid="2" branches-covered="1"/>',
            "lines",
        ),
        (
            "coverage-json",
            "json",
            json.dumps(
                {
                    "meta": {"version": "native-fixture"},
                    "files": {"source.py": {}},
                    "totals": {
                        "num_statements": 4,
                        "covered_lines": 3,
                        "num_branches": 2,
                        "covered_branches": 1,
                    },
                }
            ),
            "lines",
        ),
        (
            "lcov",
            "info",
            "SF:source.js\nDA:1,1\nDA:2,2\nDA:3,0\nDA:4,1\nLF:4\nLH:3\nend_of_record\n",
            "lines",
        ),
        (
            "go-cover",
            "cover",
            "mode: atomic\nexample.invalid/source.go:1.1,2.2 3 1\nexample.invalid/source.go:3.1,4.2 1 0\n",
            "statements",
        ),
    ],
)
def test_native_coverage_thresholds_and_retained_original(tmp_path, format, suffix, body, metric):
    source = tmp_path / ("coverage." + suffix)
    source.write_text(body)
    spec = {"profile": "python", "path": source.name, "format": format, "minimum_percent": 75}
    quality.coverage_settings({"fixture": spec}, config.catalog())
    report = quality.coverage(tmp_path, spec, tmp_path / "output")
    assert report["status"] == "success" and report["percent"] == 75 and report["metric"] == metric
    assert (tmp_path / "output" / report["retained_reports"][0]).read_text() == body
    assert (
        quality.coverage(tmp_path, {**spec, "minimum_percent": 76}, tmp_path / "negative")["status"]
        == "failure"
    )


@pytest.mark.parametrize(
    "body",
    [
        '<coverage lines-valid="0" lines-covered="0"/>',
        '<coverage lines-valid="4" lines-covered="5"/>',
        '<coverage lines-valid="4" lines-covered="NaN"/>',
        '<!DOCTYPE coverage [<!ENTITY external SYSTEM "file:///etc/passwd">]><coverage>&external;</coverage>',
        '<!DOCTYPE coverage [<!ENTITY value "4">]><coverage lines-valid="&value;" lines-covered="4"/>',
        '<coverage lines-valid="4" lines-covered="4">',
    ],
)
def test_empty_invalid_or_entity_coverage_is_not_a_pass(tmp_path, body):
    (tmp_path / "coverage.xml").write_text(body)
    with pytest.raises(Invalid):
        quality.coverage(
            tmp_path, {"path": "coverage.xml", "format": "cobertura", "minimum_percent": 0}, tmp_path / "out"
        )


def test_native_lcov_cannot_claim_summary_without_executed_lines(tmp_path):
    (tmp_path / "coverage.info").write_text("SF:source.js\nLF:100\nLH:100\nend_of_record\n")
    with pytest.raises(Invalid, match="aggregate"):
        quality.coverage(
            tmp_path, {"path": "coverage.info", "format": "lcov", "minimum_percent": 90}, tmp_path / "out"
        )


@pytest.mark.parametrize("threshold", [-1, 101, True, float("nan"), float("inf"), None])
def test_coverage_budget_cannot_be_implicit_or_invalid(threshold):
    with pytest.raises(Invalid):
        quality.coverage_settings(
            {
                "native": {
                    "profile": "python",
                    "path": "coverage.xml",
                    "format": "cobertura",
                    "minimum_percent": threshold,
                }
            },
            config.catalog(),
        )


def test_coverage_cannot_reuse_a_previous_attempt_or_hide_from_aggregate(repository, tmp_path):
    contract = """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["EXECUTABLE","-c","print('native fixture')"]
generate=["EXECUTABLE","-c","print('native fixture')"]
examples=["EXECUTABLE","-c","print('native fixture')"]
[coverage.native]
profile="documentation"
path=".nddev-reports/coverage.xml"
format="cobertura"
minimum_percent=90
""".replace("EXECUTABLE", sys.executable.replace("\\", "/"))
    root = repository(
        {
            "README.md": "# Coverage contract fixture\n",
            ".github/nddev-ci.toml": contract,
            ".gitignore": ".nddev-reports/\n",
        }
    )
    (root / ".nddev-reports").mkdir()
    (root / ".nddev-reports/coverage.xml").write_text('<coverage lines-valid="10" lines-covered="10"/>')
    result = ci.execute(root, config.load(root), tmp_path / "run")
    assert result["status"] == "failure" and "coverage.native" in result["failed"]
    assert "coverage.native" in result["expected"]
    assert not (root / ".nddev-reports/coverage.xml").exists()
    assert not any(
        "tests_executed" in item for item in result["results"] if item["name"].startswith("coverage.")
    )


def test_branch_coverage_requires_actual_native_branches(tmp_path):
    (tmp_path / "coverage.xml").write_text('<coverage lines-valid="10" lines-covered="10"/>')
    with pytest.raises(Invalid, match="nonempty"):
        quality.coverage(
            tmp_path,
            {
                "path": "coverage.xml",
                "format": "cobertura",
                "minimum_percent": 90,
                "minimum_branch_percent": 0,
            },
            tmp_path / "out",
        )


def test_native_mutation_never_adopts_or_deletes_an_existing_workspace(tmp_path):
    source = tmp_path / "project"
    previous = source / "mutants"
    previous.mkdir(parents=True)
    (previous / "user-result.json").write_text("preserved")
    with pytest.raises(Invalid):
        advanced.mutation(source, tmp_path / "new-output", engine="mutmut")
    assert (previous / "user-result.json").read_text() == "preserved"
    assert [p.name for p in previous.iterdir()] == ["user-result.json"]
