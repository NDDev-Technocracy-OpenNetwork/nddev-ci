"""Interpret actual native reports; zero tests and all-skipped runs are not success."""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from .diagnostic_export import register
from .model import Invalid, atomic_json, git


def fresh(root: Path, specification: dict) -> None:
    """Remove only old untracked native report files inside the caller checkout."""
    pattern = specification.get("path", "")
    if not pattern:
        return
    if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
        raise Invalid("Test reports must stay in the caller checkout")
    for old in root.glob(pattern):
        if not old.resolve().is_relative_to(root.resolve()) or old.is_symlink():
            raise Invalid("Test report path escapes the caller checkout")
        if old.is_file():
            if git(root, "ls-files", "--", str(old.relative_to(root))):
                raise Invalid("Do not remove tracked files as old test reports")
            old.unlink()


def retain(root: Path, specification: dict, directory: Path) -> list[str]:
    """Retain only explicitly selected native XML/JSON reports, including failed runs."""
    pattern = specification.get("path", "")
    if not pattern:
        return []
    if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
        raise Invalid("Native reports must stay in the caller checkout")
    saved = []
    for report in sorted(root.glob(pattern)):
        if report.is_symlink() or not report.resolve().is_relative_to(root.resolve()):
            raise Invalid("Native report escapes the caller checkout")
        suffixes = {".xml", ".json", ".trx"}
        if specification.get("kind") == "coverage":
            suffixes |= {".info", ".lcov", ".cover"}
        if not report.is_file() or report.suffix.lower() not in suffixes:
            raise Invalid("Retain only native XML/JSON/TRX reports")
        if report.stat().st_size > 16 * 1024 * 1024:
            raise Invalid("Native report exceeds the bounded retention size")
        relative = report.relative_to(root)
        destination = directory / (
            hashlib.sha256(str(relative).encode()).hexdigest()[:12] + "-" + report.name.lstrip(".")
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(report, destination)
        register(destination)
        saved.append(destination.name)
    return saved


def tests(root: Path, specification: dict, log: Path) -> int:
    kind = specification.get("kind", "junit")
    pattern = specification.get("path", "")
    if kind in {"junit", "trx"}:
        files = sorted(root.glob(pattern))
        if not files or any(not p.is_file() or not p.resolve().is_relative_to(root.resolve()) for p in files):
            raise Invalid("Selected tests produced no contained report")
        total = 0
        for path in files:
            try:
                node = ET.parse(path).getroot()
            except ET.ParseError as error:
                raise Invalid(f"Malformed native XML test report: {path.name}") from error
            if kind == "trx":
                results = [x for x in node.iter() if x.tag.endswith("UnitTestResult")]
                if any(x.attrib.get("outcome") != "Passed" for x in results):
                    raise Invalid("TRX contains a failing or unexecuted selected test")
                total += len(results)
            else:
                cases = list(node.iter("testcase"))
                if any(list(case.iter("failure")) or list(case.iter("error")) for case in cases):
                    raise Invalid("JUnit contains a failing selected test")
                total += sum(not list(case.iter("skipped")) for case in cases)
        if not total:
            raise Invalid("No executed tests (empty/all-skipped reports)")
        return total
    output = log.read_text(encoding="utf-8", errors="replace")
    if kind == "go-json":
        cases = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
        if any(case.get("Action") == "fail" for case in cases):
            raise Invalid("Go reports a failed package/test")
        count = sum(case.get("Action") == "pass" and bool(case.get("Test")) for case in cases)
    elif kind == "dart-json":
        events = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
        if not any(e.get("type") == "done" and e.get("success") is True for e in events):
            raise Invalid("Dart/Flutter did not complete successfully")
        if any(e.get("type") == "error" for e in events):
            raise Invalid("Dart/Flutter reports a test error")
        count = sum(
            e.get("type") == "testDone" and e.get("result") == "success" and not e.get("skipped")
            for e in events
        )
    elif kind == "cargo":
        count = sum(int(n) for n in re.findall(r"test result: ok\. (\d+) passed", output))
    elif kind == "unittest":
        summaries = re.findall(
            r"(?m)^Ran (\d+) tests? in [^\r\n]+\r?\n(?:\r?\n)*OK(?: \(([^)\r\n]*)\))?[ \t]*$",
            output,
        )
        if not summaries:
            raise Invalid("Native unittest did not report OK")
        count = 0
        for total, details in summaries:
            skipped = sum(int(n) for n in re.findall(r"\bskipped=(\d+)", details))
            if skipped > int(total):
                raise Invalid("Native unittest skipped count exceeds its test count")
            count += int(total) - skipped
    elif kind == "native":
        # Project-owned documented regex for a tool lacking JUnit; no default invented success.
        regex = specification.get("positive_pattern")
        if not isinstance(regex, str) or not regex:
            raise Invalid("Native tests need a nonempty positive result expression")
        matches = re.findall(regex, output)
        count = sum(int(n) for n in matches if isinstance(n, str) and n.isdigit())
    else:
        raise Invalid(f"Unsupported test report kind: {kind}")
    if count <= 0:
        raise Invalid("Native tests produced no positive execution result")
    return count


def aggregate(expected: list[str], results: list[dict]) -> dict:
    if not expected or len(set(expected)) != len(expected):
        raise Invalid("A unique nonempty expected result set is required")
    names = [item.get("name") for item in results]
    if len(set(names)) != len(names) or set(names) != set(expected):
        return {"status": "failure", "reason": "Missing, duplicate or unexpected mandatory result"}
    limited = [
        item["name"]
        for item in results
        if item.get("status") == "unavailable"
        and item.get("advisory_outage", {}).get("native_reporter") == "lychee"
        and item.get("advisory_outage", {}).get("issue_refs")
    ]
    failed = [
        item["name"]
        for item in results
        if not (
            item.get("status") == "success"
            or (
                item.get("status") == "not-applicable"
                and isinstance(item.get("reason"), str)
                and item["reason"].strip()
            )
        )
        and item["name"] not in limited
    ]
    return {"status": "failure" if failed else "success", "failed": failed, "limitations": limited}


def scorecard(path: Path, repository: str, required: dict) -> dict:
    """Interpret native assessment availability separately from explicit project score gates."""
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024**2:
        raise Invalid("A bounded regular native Scorecard report is required")
    data = json.loads(path.read_text())
    observed = data.get("repo", {}).get("name", "").removeprefix("https://").rstrip("/")
    if observed.lower() != ("github.com/" + repository).lower():
        raise Invalid("Scorecard assessed a different or unknown caller repository")
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        raise Invalid("Scorecard returned no native assessments")
    actual = {}
    for check in checks:
        name, value = check.get("name"), check.get("score")
        if (
            not isinstance(name, str)
            or not name
            or name in actual
            or type(value) is not int
            or not -1 <= value <= 10
        ):
            raise Invalid("Scorecard check identities/scores are invalid or repeated")
        actual[name] = value
    if not any(value >= 0 for value in actual.values()):
        raise Invalid("Scorecard established no actual available assessment")
    if not isinstance(required, dict) or any(
        name not in actual or type(value) is not int or not 0 <= value <= 10
        for name, value in required.items()
    ):
        raise Invalid("Required Scorecard checks need explicit available names and project scores in 0..10")
    failed = [name for name, minimum in required.items() if actual[name] < minimum]
    return {
        "status": "failure" if failed else "success",
        "assessment": "required-scores" if required else "advisory",
        "scores": actual,
        "failed": failed,
        "unavailable": [name for name, value in actual.items() if value < 0],
    }


def benchmark_history(path: Path, tool: str, repository_url: str, *, comparison: bool = False) -> dict:
    """Validate the vendor SDK's native history, never substitute a new baseline for a comparison."""
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024**2:
        raise Invalid("A bounded regular native benchmark history is required")
    data = json.loads(path.read_text())
    if data.get("repoUrl", "").lower().rstrip("/") != repository_url.lower().rstrip("/"):
        raise Invalid("Benchmark history belongs to a different or unknown caller repository")
    suites = data.get("entries", {}).get("Benchmark")
    if not isinstance(suites, list) or not suites:
        raise Invalid("The native benchmark history has no actual baseline")

    def cases(suite):
        if suite.get("tool") != tool or not suite.get("commit", {}).get("id") or not suite.get("benches"):
            raise Invalid("Native benchmark tool, source or measured cases are missing")
        values = {}
        for case in suite["benches"]:
            name, value, unit = case.get("name"), case.get("value"), case.get("unit")
            if (
                not isinstance(name, str)
                or not name
                or name in values
                or not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value <= 0
                or not isinstance(unit, str)
                or not unit
            ):
                raise Invalid(
                    "Benchmark cases need unique native names, units and positive finite measurements"
                )
            values[name] = unit
        return values

    current = cases(suites[-1])
    if comparison:
        previous = next(
            (
                suite
                for suite in reversed(suites[:-1])
                if suite.get("commit", {}).get("id") != suites[-1]["commit"]["id"]
            ),
            None,
        )
        if previous is None or cases(previous) != current:
            raise Invalid(
                "Comparison needs a distinct native source baseline and exactly matching measured cases/units"
            )
    return data


def benchmark_prepare(
    root: Path,
    temporary: Path,
    measurement: str,
    history: str,
    tool: str,
    mode: str,
    ratio: float,
    repository_url: str,
) -> dict:
    if (
        mode not in {"record", "compare"}
        or not tool
        or type(ratio) not in {int, float}
        or not math.isfinite(ratio)
        or ratio <= 0
    ):
        raise Invalid(
            "Select a native benchmark tool, explicit mode and positive finite project regression ratio"
        )

    def selected(value):
        path = Path(value)
        path = path if path.is_absolute() else root / path
        if (
            path.is_symlink()
            or not path.is_file()
            or not any(path.resolve().is_relative_to(base.resolve()) for base in (root, temporary))
            or path.stat().st_size > 16 * 1024**2
        ):
            raise Invalid("Benchmark inputs must be bounded regular caller/job files")
        return path.resolve()

    report = selected(measurement)
    if not report.stat().st_size:
        raise Invalid("An empty native measurement cannot become a benchmark")
    if mode == "record" and history or mode == "compare" and not history:
        raise Invalid("Record creates a fresh baseline; comparison requires the accepted native history")
    baseline = benchmark_history(selected(history), tool, repository_url) if history else None
    output = Path(tempfile.mkdtemp(prefix="nddev-benchmark-", dir=temporary))
    target = output / "history.json"
    if baseline is not None:
        # Compare only the latest accepted suite. The caller's original history remains immutable.
        baseline["entries"] = {"Benchmark": baseline["entries"]["Benchmark"][-1:]}
        atomic_json(target, baseline)
    return {"measurement": str(report), "history": str(target), "threshold": f"{ratio * 100:g}%"}


def _sarif_rule(tool: dict, descriptor: dict) -> tuple[tuple[int, int], dict]:
    """Resolve one driver/extension rule without borrowing metadata from another rule."""
    component = descriptor.get("toolComponent", {})
    components = [tool["driver"], *tool.get("extensions", [])]
    if "index" in component:
        number = component["index"]
        if type(number) is not int or not 0 <= number < len(components) - 1:
            raise Invalid("Native SARIF references an unknown tool component")
        component_index = number + 1
    elif "guid" in component:
        matches = [i for i, value in enumerate(components) if value.get("guid") == component["guid"]]
        if len(matches) != 1:
            raise Invalid("Native SARIF tool component identity is unknown or ambiguous")
        component_index = matches[0]
    else:
        component_index = 0
    selected = components[component_index]
    if any(name in component and component[name] != selected.get(name) for name in ("name", "guid")):
        raise Invalid("Native SARIF tool component identities disagree")
    rules = selected.get("rules", [])
    index = descriptor.get("index", -1)
    if type(index) is not int or index < -1 or index >= len(rules):
        raise Invalid("Native SARIF references an unknown rule index")
    if index == -1:
        field = "guid" if "guid" in descriptor else "id"
        matches = [i for i, rule in enumerate(rules) if rule.get(field) == descriptor.get(field)]
        if len(matches) != 1:
            raise Invalid("Native SARIF finding has no unique identifiable rule")
        index = matches[0]
    rule = rules[index]
    if not isinstance(rule.get("id"), str) or not rule["id"]:
        raise Invalid("Native SARIF rule has no identity")
    if "guid" in descriptor and descriptor["guid"] != rule.get("guid"):
        raise Invalid("Native SARIF rule index and GUID disagree")
    if "id" in descriptor:
        identity = descriptor["id"]
        prefix = rule["id"] + "/"
        if identity != rule["id"] and not (
            isinstance(identity, str)
            and identity.startswith(prefix)
            and identity[len(prefix) :]
            and "/" not in identity[len(prefix) :]
        ):
            raise Invalid("Native SARIF rule index and identity disagree")
    return (component_index, index), rule


def _sarif_level(run: dict, result: dict, identity: tuple[int, int], rule: dict) -> str:
    """Resolve result severity using SARIF 2.1.0 + Errata 01, sections 3.27.10 and 3.48.6."""
    if "level" in result:
        level = result["level"]
    else:
        configuration = rule.get("defaultConfiguration", {})
        invocations = run["invocations"]
        index = result.get("provenance", {}).get("invocationIndex", 0 if len(invocations) == 1 else -1)
        if type(index) is not int or not -1 <= index < len(invocations):
            raise Invalid("Native SARIF result references an unknown invocation")
        if index >= 0:
            matches = []
            for override in invocations[index].get("ruleConfigurationOverrides", []):
                target, _ = _sarif_rule(run["tool"], override["descriptor"])
                if target == identity:
                    matches.append(override["configuration"])
            if len(matches) > 1:
                raise Invalid("Native SARIF has ambiguous configuration overrides for a rule")
            if matches:
                configuration = configuration | matches[0]
        level = configuration.get("level", "warning")
    if not isinstance(level, str) or level not in {"error", "warning", "note", "none"}:
        raise Invalid("Native SARIF result severity is invalid")
    return level


def sarif(directory: Path, minimum: str = "moderate") -> dict:
    """Gate actual CodeQL SARIF findings without treating an empty/missing analysis as success."""
    import math

    scores = {"low": 0.1, "moderate": 4.0, "high": 7.0, "critical": 9.0}
    if minimum not in scores:
        raise Invalid("Select a known native SARIF security severity")
    files = sorted(directory.rglob("*.sarif")) if directory.is_dir() else []
    if not files or len(files) > 32:
        raise Invalid("Expected bounded native CodeQL SARIF output is missing")
    findings, runs = [], 0
    for file in files:
        if file.is_symlink() or file.stat().st_size > 64 * 1024 * 1024:
            raise Invalid("Native SARIF report is not a bounded regular output")
        document = json.loads(file.read_text())
        if document.get("version") != "2.1.0" or not document.get("runs"):
            raise Invalid("Native SARIF lacks actual analysis runs")
        for run in document["runs"]:
            driver = run.get("tool", {}).get("driver", {})
            invocations = run.get("invocations", [])
            if (
                driver.get("name") != "CodeQL"
                or not invocations
                or any(x.get("executionSuccessful") is not True for x in invocations)
            ):
                raise Invalid("CodeQL did not establish a successful native analysis")
            runs += 1
            for result in run.get("results", []):
                if result.get("kind", "fail") != "fail":
                    continue
                descriptor = dict(result.get("rule", {}))
                for legacy, field in (("ruleId", "id"), ("ruleIndex", "index")):
                    if legacy in result:
                        if field in descriptor and descriptor[field] != result[legacy]:
                            raise Invalid("Native SARIF legacy and descriptor rule identities disagree")
                        descriptor[field] = result[legacy]
                identity, rule = _sarif_rule(run["tool"], descriptor)
                raw = rule.get("properties", {}).get("security-severity")
                score = float(raw) if raw is not None else None
                if score is not None and (not math.isfinite(score) or not 0 <= score <= 10):
                    raise Invalid("Native SARIF security score is invalid")
                blocking = (
                    score >= scores[minimum]
                    if score is not None
                    else _sarif_level(run, result, identity, rule) == "error"
                )
                findings.append(
                    {
                        "rule": rule["id"],
                        "score": score,
                        "blocking": blocking,
                        "message": result.get("message", {}).get("text", ""),
                        "locations": [
                            {
                                "path": location.get("physicalLocation", {})
                                .get("artifactLocation", {})
                                .get("uri"),
                                "line": location.get("physicalLocation", {})
                                .get("region", {})
                                .get("startLine"),
                            }
                            for location in result.get("locations", [])
                        ],
                    }
                )
    return {
        "status": "failure" if any(f["blocking"] for f in findings) else "success",
        "runs": runs,
        "minimum": minimum,
        "findings": findings,
    }
