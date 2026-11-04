"""Owned bounded local cache namespaces with native process locking."""

from __future__ import annotations

import contextlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

from .model import Invalid, atomic_json, identity


def nds_environment(environment: dict) -> tuple[dict, dict] | None:
    """Use the same native admission before bootstrap and after package preparation."""
    from .native_cache import InvalidNativeCache, admit_environment

    try:
        return admit_environment(environment)
    except InvalidNativeCache as error:
        raise Invalid(str(error)) from error


@contextlib.contextmanager
def lock(path: Path, *, blocking: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise Invalid("An owned lock cannot follow a symlink")
    with path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt

            stream.seek(0)
            if not path.stat().st_size:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt

                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream, fcntl.LOCK_UN)


@contextlib.contextmanager
def namespace(root: Path, inputs: dict, *, blocking: bool = True):
    if root.is_symlink():
        raise Invalid("A cache owner root cannot be a symlink")
    if (
        root.exists()
        and any(p.name != ".owner.lock" for p in root.iterdir())
        and not (root / ".nddev-cache-owner.json").is_file()
        # An initializer holds this lock before publishing its atomic marker.
        # Inspect that state under the lock, preserving write-free rejection of
        # foreign directories which have no existing ownership lock.
        and not (root / ".owner.lock").exists()
    ):
        raise Invalid("Do not adopt an existing unowned cache directory")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner = root / ".nddev-cache-owner.json"
    with lock(root / ".owner.lock"):
        if owner.exists() and json.loads(owner.read_text()) != {"schema": 1, "owner": "nddev-cicd"}:
            raise Invalid("Cache root belongs to another owner")
        if not owner.exists() and any(p.name != ".owner.lock" for p in root.iterdir()):
            raise Invalid("Do not adopt an existing unowned cache directory")
        atomic_json(owner, {"schema": 1, "owner": "nddev-cicd"})
    name = identity(inputs)
    path = root / name
    with lock(root / f"{name}.lock", blocking=blocking):
        if path.is_symlink():
            raise Invalid("Cache namespace cannot be a symlink")
        path.mkdir(exist_ok=True)
        atomic_json(path / "identity.json", inputs)
        os.utime(path, None)
        yield path


@contextlib.contextmanager
def compiler(root: Path, policy: dict, environment: dict, contract_path: str):
    """One bounded ccache namespace, with a native launcher and no daemon or host-wide prune."""
    from .model import digest

    values: list[int] = []
    for key in ("cache_budget_bytes", "cache_min_free_bytes", "cache_ttl_seconds"):
        value = policy.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            raise Invalid("Compiler caches require explicit byte budget, free-disk reserve and TTL")
        values.append(value)
    budget, reserve, ttl = values
    if budget < 1024**2 or reserve < 0 or ttl < 1:
        raise Invalid("Compiler cache budget/TTL must be positive and reserve nonnegative")
    location = os.environ.get("NDDEV_CCACHE_ROOT")
    if not location:
        raise Invalid("Selected compiler cache needs an owner-provided NDDEV_CCACHE_ROOT")
    storage = Path(location)
    if (
        not storage.is_absolute()
        or storage.resolve() == Path(os.environ.get("NDDEV_CACHE_ROOT", ".")).resolve()
    ):
        raise Invalid("Compiler and Cargo caches need separate absolute owner roots and budgets")
    process_environment = {**os.environ, **{str(k): str(v) for k, v in environment.items()}}
    executable = shutil.which("ccache", path=process_environment.get("PATH"))
    if not executable:
        raise Invalid("Selected compiler cache requires its actual native ccache tool")
    for key in ("CMAKE_C_COMPILER_LAUNCHER", "CMAKE_CXX_COMPILER_LAUNCHER"):
        if process_environment.get(key, "ccache") not in {"ccache", executable}:
            raise Invalid("Selected compiler cache conflicts with an existing native launcher")
    version = subprocess.check_output(
        [executable, "--version"], text=True, env=process_environment, timeout=30
    )
    inputs = {
        "kind": "ccache",
        "repository": os.environ.get("GITHUB_REPOSITORY", str(root.resolve())),
        "platform": platform.system(),
        "architecture": platform.machine(),
        "toolchain": version.splitlines()[0],
        "trust": [os.environ.get("GITHUB_EVENT_NAME", "local"), os.environ.get("GITHUB_REF", "local")],
        "configuration": digest(root / contract_path),
    }
    try:
        with namespace(storage, inputs) as owned:
            reclaim(storage, budget, reserve, ttl)
            if shutil.disk_usage(storage).free < reserve:
                raise Invalid("Available disk is below the compiler cache owner's reserve")
            yield {
                "CCACHE_DIR": str(owned / "compiler"),
                "CCACHE_BASEDIR": str(root.resolve()),
                "CCACHE_MAXSIZE": str(max(1, budget // 1024**2 - 1)) + "Mi",
                "CCACHE_COMPILERCHECK": "content",
                "CMAKE_C_COMPILER_LAUNCHER": executable,
                "CMAKE_CXX_COMPILER_LAUNCHER": executable,
            }
    finally:
        if (storage / ".nddev-cache-owner.json").is_file():
            reclaim(storage, budget, reserve, ttl)


def size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())


def reclaim(root: Path, budget: int, min_free: int, ttl_seconds: int) -> list[str]:
    """Retain opaque compiler payloads until a pinned native Cleaner owns them.

    Namespace mtime, an unlocked library wrapper and storage pressure do not
    prove completed native use or the absence of an inherited child/pin. This
    compatibility entry point validates ownership without adopting/deleting
    legacy data. Admission still enforces the caller's free-space reserve.
    """
    if budget <= 0 or min_free < 0 or ttl_seconds < 1:
        raise Invalid("Explicit positive cache budget/TTL and available-disk reserve are required")
    owner = root / ".nddev-cache-owner.json"
    if (
        root.is_symlink()
        or not owner.exists()
        or owner.is_symlink()
        or json.loads(owner.read_text()) != {"schema": 1, "owner": "nddev-cicd"}
    ):
        raise Invalid("No matching cache owner; nothing reclaimed")
    return []
