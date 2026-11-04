"""Evaluate native leaf results once, with explicit success or non-applicability."""

from __future__ import annotations

import re

from .model import Invalid


def evaluate(needs: dict, expected: dict, scopes: dict | None = None) -> dict:
    if scopes is not None and (
        not isinstance(scopes, dict)
        or not 1 <= len(scopes) <= 256
        or any(not isinstance(k, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,99}", k) for k in scopes)
        or any(v not in ("true", "false") for v in scopes.values())
    ):
        raise Invalid(
            "Classifier scope outputs must be explicit true/false strings, never missing or malformed"
        )
    if (
        not isinstance(needs, dict)
        or not isinstance(expected, dict)
        or not 1 <= len(expected) <= 256
        or any(
            not isinstance(k, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,99}", k) for k in expected
        )
        or any(v not in ("success", "skipped") for v in expected.values())
        or "success" not in expected.values()
    ):
        raise Invalid("A gate requires a bounded explicit job map with expected success/skipped results")
    if needs.keys() != expected.keys():
        raise Invalid("Gate dependencies must exactly match the expected leaf jobs")
    failures = []
    for name, result in expected.items():
        actual = needs[name]
        if not isinstance(actual, dict) or actual.get("result") != result:
            failures.append(name)
    if failures:
        raise Invalid("Unexpected or missing native job results: " + ", ".join(sorted(failures)))
    return {"status": "success", "jobs": {name: expected[name] for name in sorted(expected)}}
