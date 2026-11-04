"""Free native security commands; callers own source scopes and license policy."""

from __future__ import annotations

import json
import re
from pathlib import Path

from .impact import matches
from .model import Invalid, contained, git


def semgrep_sources(root: Path, settings: dict) -> list[str]:
    scopes = settings.get("paths")
    if not isinstance(scopes, list) or not scopes:
        raise Invalid("Semgrep requires explicit tracked source scopes")
    tracked = [name for name in git(root, "ls-files", "-z").split("\0") if name]
    selected = set()
    for scope in scopes:
        if not isinstance(scope, str) or not scope or Path(scope).is_absolute() or ".." in Path(scope).parts:
            raise Invalid("Semgrep source scopes must stay in the caller checkout")
        found = [name for name in tracked if matches(name, scope)]
        if not found:
            raise Invalid("Semgrep source scope has no tracked files: " + scope)
        for name in found:
            if (root / name).is_symlink() or not contained(root, name, exists=True).is_file():
                raise Invalid("Semgrep scans contained regular source files")
        selected.update(found)
    return sorted(selected)


def verify_semgrep(root: Path, settings: dict, log: Path) -> int:
    report = json.loads(log.read_text())
    if not report.get("version") or report.get("errors") or report.get("results"):
        raise Invalid("Semgrep did not establish a clean complete native analysis")
    scanned = report.get("paths", {}).get("scanned", [])
    actual = set()
    for name in scanned:
        path = Path(name)
        path = path if path.is_absolute() else root / path
        if not path.resolve().is_relative_to(root.resolve()):
            raise Invalid("Semgrep reported an unexpected source target")
        actual.add(path.resolve().relative_to(root.resolve()).as_posix())
    if actual != set(semgrep_sources(root, settings)):
        raise Invalid("Semgrep did not analyze every explicitly selected source file")
    return len(actual)


def native_command(helper: str, root: Path, contract: dict) -> list[str]:
    settings = contract.get("security", {})
    if helper == "security-licenses":
        licenses = settings.get("licenses")
        if (
            not isinstance(licenses, list)
            or not licenses
            or any(
                not isinstance(x, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+-]*", x) for x in licenses
            )
        ):
            raise Invalid("Default license checking requires an explicit SPDX security.licenses allowlist")
        return ["osv-scanner", "scan", "source", "--recursive", "--licenses=" + ",".join(licenses), "."]
    if settings.get("engine") == "semgrep":
        rules = settings.get("rules")
        if not isinstance(rules, list) or not 1 <= len(rules) <= 32:
            raise Invalid("Semgrep CE requires an explicit bounded local rule selection")
        command = [
            "semgrep",
            "scan",
            "--oss-only",
            "--metrics=off",
            "--disable-version-check",
            "--strict",
            "--error",
            "--json",
            "--no-git-ignore",
        ]
        for rule in rules:
            if not isinstance(rule, str):
                raise Invalid("Semgrep rules must be tracked local files")
            path = contained(root, rule, exists=True)
            if not path.is_file() or (root / rule).is_symlink() or not git(root, "ls-files", "--", rule):
                raise Invalid("Semgrep rules must be contained tracked regular files")
            command.extend(["--config", str(path)])
        return [*command, "--", *semgrep_sources(root, settings)]
    scopes = settings.get("python")
    if (
        not isinstance(scopes, list)
        or not scopes
        or any(
            not isinstance(x, str) or not x or Path(x).is_absolute() or ".." in Path(x).parts for x in scopes
        )
    ):
        raise Invalid("Default Python SAST requires explicit security.python tracked source globs")
    tracked = [x for x in git(root, "ls-files", "-z").split("\0") if x.endswith(".py")]
    selected = set()
    for scope in scopes:
        found = [x for x in tracked if matches(x, scope)]
        if not found:
            raise Invalid("Python SAST scope has no tracked source: " + scope)
        for relative in found:
            if (root / relative).is_symlink() or not contained(root, relative, exists=True).is_file():
                raise Invalid("Python SAST requires contained regular source files")
        selected.update(found)
    return ["bandit", "--quiet", "--", *sorted(selected)]
