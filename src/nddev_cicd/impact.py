"""Conservative affected-component closure; uncertainty retains every selected obligation."""

from __future__ import annotations

import subprocess
from fnmatch import fnmatchcase
from functools import cache
from graphlib import CycleError, TopologicalSorter
from pathlib import Path

from .model import Invalid, git_environment


def matches(path: str, pattern: str) -> bool:
    """Root-anchored POSIX globs: * stays in a segment; ** spans zero or more segments."""
    parts, scopes = path.split("/"), pattern.split("/")

    @cache
    def visit(i: int, j: int) -> bool:
        if j == len(scopes):
            return i == len(parts)
        if scopes[j] == "**":
            return visit(i, j + 1) or (i < len(parts) and visit(i + 1, j))
        return i < len(parts) and fnmatchcase(parts[i], scopes[j]) and visit(i + 1, j + 1)

    return visit(0, 0)


def affected(root: Path, base: str, head: str, components: dict, shared: list[str]) -> list[str]:
    if not components or any(not value.get("paths") for value in components.values()):
        raise Invalid("Impact selection requires nonempty declared component scopes")
    for value in components.values():
        if set(value.get("depends_on", [])) - components.keys():
            raise Invalid("Unknown component dependency")
    try:
        list(
            TopologicalSorter(
                {name: value.get("depends_on", []) for name, value in components.items()}
            ).static_order()
        )
    except CycleError as error:
        raise Invalid("Component dependencies contain a cycle") from error
    result = subprocess.run(
        ["git", "-C", str(root), "diff", "--name-only", "--no-renames", "-z", base, head],
        check=False,
        capture_output=True,
        env=git_environment(),
    )
    if result.returncode:
        return sorted(components)
    paths = [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]
    if any(matches(path, pattern) for path in paths for pattern in shared):
        return sorted(components)
    selected = {
        name
        for name, value in components.items()
        if any(matches(path, pattern) for path in paths for pattern in value["paths"])
    }
    if any(
        not any(matches(path, pattern) for value in components.values() for pattern in value["paths"])
        for path in paths
    ):
        return sorted(components)
    while True:
        additions = {
            name for name, value in components.items() if set(value.get("depends_on", [])) & selected
        }
        if additions <= selected:
            return sorted(selected)
        selected |= additions
