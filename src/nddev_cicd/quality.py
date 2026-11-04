"""Project-selected native coverage feedback, separate from executed-test counts."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from xml.etree.ElementTree import ParseError

from defusedxml.common import DefusedXmlException
from defusedxml.ElementTree import fromstring

from . import reports
from .model import Invalid


def coverage_settings(settings: dict, profiles: dict) -> None:
    if not isinstance(settings, dict):
        raise Invalid("Coverage settings must name explicit project gates")
    for name, spec in settings.items():
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", name)
            or not isinstance(spec, dict)
        ):
            raise Invalid("Coverage needs a bounded gate name and native report settings")
        if set(spec) - {"profile", "path", "format", "minimum_percent", "minimum_branch_percent"}:
            raise Invalid("Unknown native coverage setting")
        if spec.get("profile") not in profiles:
            raise Invalid("Coverage must select its actual source profile")
        path = spec.get("path")
        if not isinstance(path, str) or not path or Path(path).is_absolute() or ".." in Path(path).parts:
            raise Invalid("Coverage reports must use a contained native path or glob")
        if spec.get("format") not in {"cobertura", "lcov", "coverage-json", "go-cover"}:
            raise Invalid("Select a supported native coverage format")
        for key in ("minimum_percent", "minimum_branch_percent"):
            value = spec.get(key)
            if key not in spec and key == "minimum_branch_percent":
                continue
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or not 0 <= value <= 100
            ):
                raise Invalid("Coverage thresholds are explicit finite project percentages in 0..100")
        if spec["format"] == "go-cover" and "minimum_branch_percent" in spec:
            raise Invalid("Native Go coverage measures statements, not branch coverage")


def _count(value) -> int:
    if isinstance(value, bool) or not re.fullmatch(r"\d+", str(value)):
        raise Invalid("Native coverage counters must be nonnegative integers")
    return int(value)


def _lcov(text: str) -> tuple[int, int, int, int]:
    totals = [0, 0, 0, 0]
    files = set()
    record = None
    for line in text.splitlines():
        if line.startswith("SF:"):
            if record is not None or not line[3:] or line[3:] in files:
                raise Invalid("LCOV source records are missing, repeated or incomplete")
            files.add(line[3:])
            record = {"lines": {}, "branches": {}, "summary": {}}
        elif line == "end_of_record":
            if record is None:
                raise Invalid("LCOV has an unmatched record terminator")
            counts = [
                len(record["lines"]),
                sum(record["lines"].values()),
                len(record["branches"]),
                sum(record["branches"].values()),
            ]
            for key, actual in zip(("LF", "LH", "BRF", "BRH"), counts):
                if key in record["summary"] and record["summary"][key] != actual:
                    raise Invalid("LCOV aggregate differs from its native line/branch records")
            totals = [a + b for a, b in zip(totals, counts)]
            record = None
        elif record is not None:
            key, _, value = line.partition(":")
            if key in {"LF", "LH", "BRF", "BRH"}:
                if key in record["summary"]:
                    raise Invalid("LCOV repeats an aggregate counter")
                record["summary"][key] = _count(value)
            elif key == "DA":
                fields = value.split(",")
                if len(fields) not in {2, 3} or _count(fields[0]) < 1 or fields[0] in record["lines"]:
                    raise Invalid("LCOV has an invalid or duplicated source line")
                record["lines"][fields[0]] = int(_count(fields[1]) > 0)
            elif key == "BRDA":
                fields = value.split(",")
                if len(fields) != 4 or any(not field for field in fields[:3]):
                    raise Invalid("LCOV branch identity is invalid")
                identity = tuple(fields[:3])
                if identity in record["branches"]:
                    raise Invalid("LCOV repeats a branch")
                record["branches"][identity] = 0 if fields[3] == "-" else int(_count(fields[3]) > 0)
    if record is not None or not files:
        raise Invalid("LCOV needs complete native source records")
    return totals[0], totals[1], totals[2], totals[3]


def _coverage(text: str, format: str) -> tuple[int, int, int, int]:
    if format == "cobertura":
        node = fromstring(text)
        if node.tag != "coverage":
            raise Invalid("Expected a native Cobertura coverage report")
        values = [
            _count(node.get(key, "0"))
            for key in ("lines-valid", "lines-covered", "branches-valid", "branches-covered")
        ]
        return values[0], values[1], values[2], values[3]
    if format == "coverage-json":
        data = json.loads(text)
        if not data.get("meta", {}).get("version") or not data.get("files"):
            raise Invalid("Expected a native coverage.py JSON report")
        totals = data["totals"]
        values = [
            _count(totals.get(key, 0))
            for key in ("num_statements", "covered_lines", "num_branches", "covered_branches")
        ]
        return values[0], values[1], values[2], values[3]
    if format == "lcov":
        return _lcov(text)
    if format != "go-cover":
        raise Invalid("Unsupported native coverage format")
    lines = text.splitlines()
    if not lines or lines[0] not in {"mode: set", "mode: count", "mode: atomic"}:
        raise Invalid("Expected a native Go coverprofile")
    total = covered = 0
    blocks = set()
    for line in lines[1:]:
        match = re.fullmatch(r"(.+:\d+\.\d+,\d+\.\d+) (\d+) (\d+)", line)
        if not match or match[1] in blocks:
            raise Invalid("Go coverage blocks are invalid or duplicated")
        blocks.add(match[1])
        statements, count = _count(match[2]), _count(match[3])
        total += statements
        covered += statements if count > 0 else 0
    return total, covered, 0, 0


def coverage(root: Path, spec: dict, output: Path) -> dict:
    files = sorted(root.glob(spec["path"]))
    if not files or len(files) > 256:
        raise Invalid("Selected native coverage reports are missing or unbounded")
    totals = [0, 0, 0, 0]
    for path in files:
        if (
            path.is_symlink()
            or not path.is_file()
            or not path.resolve().is_relative_to(root.resolve())
            or path.stat().st_size > 16 * 1024**2
        ):
            raise Invalid("Native coverage requires bounded contained regular reports")
        try:
            values = _coverage(path.read_text(encoding="utf-8"), spec["format"])
        except Invalid:
            raise
        except (DefusedXmlException, ParseError, ValueError, KeyError, TypeError) as error:
            raise Invalid("Malformed native coverage report: " + type(error).__name__) from error
        if values[1] > values[0] or values[3] > values[2]:
            raise Invalid("Covered counters exceed the native measured population")
        totals = [a + b for a, b in zip(totals, values)]
    total, covered, branches, covered_branches = totals
    if total <= 0 or ("minimum_branch_percent" in spec and branches <= 0):
        raise Invalid("Selected coverage needs actual nonempty native measurements")
    percent = 100 * covered / total
    branch_percent = 100 * covered_branches / branches if branches else None
    passed = percent >= spec["minimum_percent"] and (
        "minimum_branch_percent" not in spec or branch_percent >= spec["minimum_branch_percent"]
    )
    retained = reports.retain(root, {"path": spec["path"], "kind": "coverage"}, output)
    return {
        "status": "success" if passed else "failure",
        "metric": "statements" if spec["format"] == "go-cover" else "lines",
        "covered": covered,
        "total": total,
        "percent": percent,
        "branch_percent": branch_percent,
        "minimum_percent": spec["minimum_percent"],
        "minimum_branch_percent": spec.get("minimum_branch_percent"),
        "retained_reports": retained,
    }
