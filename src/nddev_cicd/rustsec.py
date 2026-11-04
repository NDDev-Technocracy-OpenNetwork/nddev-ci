"""Fetch RustSec with native shallow Git, then run the unchanged native audit."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import cache
from .model import Invalid, Unavailable
from .process import run as native_run

SOURCE = "https://github.com/RustSec/advisory-db"


def isolated_git_context(command: list[str]) -> list[str]:
    # The shared process owner merges the caller's environment. Native env removes
    # pre-commit/bare-repository selectors without changing that global owner API.
    names = [
        key
        for key in os.environ
        if key.startswith("GIT_") and not key.startswith("GIT_CONFIG_") and key != "GIT_TERMINAL_PROMPT"
    ]
    return ["env", *(word for name in names for word in ("-u", name)), *command] if names else command


def git(repository: Path, *arguments: str) -> str:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    command = isolated_git_context(
        ["git", "-c", f"core.hooksPath={os.devnull}", "-C", str(repository), *arguments]
    )
    with tempfile.TemporaryDirectory(prefix="nddev-rustsec-git-") as temporary:
        output, errors = (Path(temporary) / name for name in ("stdout", "stderr"))
        result = native_run(command, repository, output, env=environment, timeout=150, stderr_log=errors)
        if result["detail"] == "cancelled":
            raise KeyboardInterrupt
        if result["detail"] == "timeout":
            raise subprocess.TimeoutExpired(command, 150)
        if result["status"] != "success":
            raise subprocess.CalledProcessError(
                result["exit_code"] or 127, command, stderr=errors.read_text(errors="replace")[-65536:]
            )
        return output.read_text().strip()


def fetch(repository: Path) -> None:
    for attempt in range(2):
        try:
            git(repository, "fetch", "--depth=1", "--no-tags", "origin", "HEAD")
            return
        except subprocess.TimeoutExpired:
            retry = True
        except subprocess.CalledProcessError as error:
            diagnostic = (error.stderr or "").lower()
            retry = any(
                word in diagnostic
                for word in (
                    "timed out",
                    "connection reset",
                    "could not resolve host",
                    "remote end hung",
                    "rpc failed",
                    "early eof",
                    "failed to connect",
                    "http/2",
                    "ssl_error",
                    "http code = 5",
                    "requested url returned error: 5",
                )
            )
        if not retry or attempt == 1:
            raise Unavailable("infrastructure.external-download: native RustSec fetch did not complete")


def audit(root: Path, storage: Path, *, reserve: int = 32 * 1024**3) -> int:
    if reserve < 0:
        raise Invalid("RustSec free-space reserve cannot be negative")
    storage = storage.absolute()
    if storage.resolve() != storage:
        raise Invalid("RustSec cache cannot redirect writes through symlinks")
    try:
        with cache.namespace(storage, {"kind": "rustsec", "source": SOURCE}, blocking=False) as owned:
            cache.reclaim(storage, 512 * 1024**2, reserve, 7 * 86400)
            if shutil.disk_usage(storage).free < reserve:
                raise Unavailable("infrastructure.disk-reserve: RustSec cache has insufficient free space")
            repository = owned / "repository"
            if repository.is_symlink() or (repository / ".git").is_symlink():
                raise Invalid("RustSec native repository cannot redirect cache writes")
            if repository.exists() and not (repository / ".git").is_dir():
                raise Invalid(
                    "RustSec cache requires its own Git directory; foreign worktree pointers are refused"
                )
            if not repository.exists():
                repository.mkdir()
                git(repository, "init", "--quiet")
                git(repository, "remote", "add", "origin", SOURCE)
            if (
                Path(git(repository, "rev-parse", "--show-toplevel")) != repository.resolve()
                or git(repository, "remote", "get-url", "origin") != SOURCE
            ):
                raise Invalid("The cached Git repository does not belong to the selected RustSec source")
            fetch(repository)
            git(repository, "checkout", "--quiet", "--detach", "--force", "FETCH_HEAD")
            if cache.size(owned) > 512 * 1024**2:
                raise Invalid(
                    "Native RustSec input exceeds its retained-cache budget; owner reconciliation required"
                )
            revision = git(repository, "rev-parse", "HEAD")
            print("RustSec native input: " + json.dumps({"revision": revision, "depth": 1}), flush=True)
            # No stale fallback or vulnerability retry: the native scanner owns its verdict.
            with tempfile.TemporaryDirectory(prefix="nddev-rustsec-audit-") as temporary:
                output, errors = (Path(temporary) / name for name in ("stdout", "stderr"))
                result = native_run(
                    isolated_git_context(
                        ["cargo", "audit", "--db", str(repository), "--no-fetch", "--deny", "warnings"]
                    ),
                    root,
                    output,
                    timeout=900,
                    stderr_log=errors,
                )
                for path, stream in ((output, sys.stdout), (errors, sys.stderr)):
                    with path.open() as content:
                        shutil.copyfileobj(content, stream)
                if result["detail"] == "cancelled":
                    raise KeyboardInterrupt
                if result["detail"] == "timeout":
                    return 124
                code = result["exit_code"]
                return 127 if code is None else code if code >= 0 else 128 - code
    except BlockingIOError as error:
        raise Unavailable("infrastructure.cache-busy: this native RustSec cache is in use") from error
    except subprocess.SubprocessError as error:
        raise Invalid(
            "Native RustSec Git/audit command did not complete; cache needs reconciliation"
        ) from error
