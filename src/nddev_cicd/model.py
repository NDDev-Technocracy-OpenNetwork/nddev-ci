"""Small result vocabulary shared by native entrypoints."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


class Invalid(ValueError):
    """Unsupported or inconsistent invocation; never a successful skipped check."""


class Unavailable(Invalid):
    """A selected tool, target or entitlement is unavailable."""


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def identity(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def contained(root: Path, relative: str, *, exists: bool = False) -> Path:
    p = Path(relative)
    if p.is_absolute() or ".." in p.parts:
        raise Invalid(f"Expected a contained relative path: {relative}")
    path = (root / p).resolve()
    if not path.is_relative_to(root.resolve()):
        raise Invalid(f"Path leaves its owned root: {relative}")
    if exists and not path.exists():
        raise Invalid(f"Required path is absent: {relative}")
    return path


def atomic_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def git_environment(environment: dict | None = None) -> dict:
    """Discard inherited Git injection/config and make machine output uncoloured."""
    values = dict(os.environ if environment is None else environment)
    values = {k: v for k, v in values.items() if not k.startswith("GIT_CONFIG_")}
    values.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_SYSTEM=os.devnull,
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_COUNT="2",
        GIT_CONFIG_KEY_0="color.ui",
        GIT_CONFIG_VALUE_0="false",
        GIT_CONFIG_KEY_1="log.showSignature",
        GIT_CONFIG_VALUE_1="false",
    )
    return values


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args], check=False, capture_output=True, text=True, env=git_environment()
    )
    if result.returncode:
        raise Invalid(result.stderr.strip() or "Git operation failed")
    return result.stdout.strip()


def source_identity(root: Path, library: Path | None = None) -> dict:
    """Keep caller candidate and callee implementation separate, including local execution."""
    event = {}
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path:
        event = json.loads(Path(event_path).read_text())
    pr = event.get("pull_request", {})
    code = Path(__file__).parent
    implementation = {
        str(p.relative_to(code)): digest(p)
        for p in sorted(code.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }
    result = {
        "repository": os.environ.get("GITHUB_REPOSITORY", "local"),
        "event": os.environ.get("GITHUB_EVENT_NAME", "local"),
        "tested_revision": git(root, "rev-parse", "HEAD"),
        "tested_tree": git(root, "rev-parse", "HEAD^{tree}"),
        "head": pr.get("head", {}).get("sha", git(root, "rev-parse", "HEAD")),
        "base": pr.get("base", {}).get("sha")
        or (event.get("before") if event.get("before") != "0" * 40 else None),
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "library_repository": os.environ.get("NDDEV_LIBRARY_REPOSITORY", "local"),
        "library_ref": os.environ.get("NDDEV_LIBRARY_REF", "local"),
        "implementation_digest": identity(implementation),
    }
    check = os.environ.get("NDDEV_SOURCE_CHECK_RUN_ID", "")
    if check:
        if not re.fullmatch(r"[1-9][0-9]{0,19}", check):
            raise Invalid("The native source check-run identity must be numeric")
        result["check_run_id"] = check
    return result
