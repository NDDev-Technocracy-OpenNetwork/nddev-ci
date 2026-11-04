"""Verify actual recursive checkout identities before scanning/building a reusable workspace."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .model import Invalid, contained, git


def submodules(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    boundary = root.resolve()

    def visit(repository: Path) -> None:
        for entry in git(repository, "ls-tree", "-r", "-z", "HEAD").split("\0"):
            if not entry:
                continue
            metadata, _, name = entry.partition("\t")
            mode, _kind, expected = metadata.split()
            if mode != "160000":
                continue
            cursor = repository
            for part in Path(name).parts:
                cursor /= part
                if cursor.is_symlink():
                    raise Invalid("A tracked submodule checkout cannot be a symlink")
            actual = contained(repository, name, exists=True)
            if not actual.is_dir() or Path(git(actual, "rev-parse", "--show-toplevel")).resolve() != actual:
                raise Invalid("Initialize each selected submodule at its recorded gitlink before validation")
            if not actual.is_relative_to(boundary):
                raise Invalid("Recursive submodule checkout leaves the caller boundary")
            relative = actual.relative_to(boundary).as_posix()
            if relative in found:
                raise Invalid("Recursive submodule identity is cyclic or duplicated")
            if git(actual, "rev-parse", "HEAD") != expected:
                raise Invalid("Submodule checkout differs from its recorded gitlink: " + relative)
            dirty = subprocess.run(
                [
                    "git",
                    "-C",
                    str(actual),
                    "-c",
                    "core.fsmonitor=false",
                    "diff",
                    "--quiet",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "--",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if dirty.returncode or git(
                actual, "-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard"
            ):
                raise Invalid("Submodule has modified or untracked source inputs: " + relative)
            found[relative] = expected
            visit(actual)

    visit(boundary)
    return found
