"""Reuse fresh native Trivy databases; keep mutable scan caches job-local."""

from __future__ import annotations

import errno
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path

from . import cache, docker
from .model import Invalid, Unavailable, atomic_json

DATABASES = {
    "db": (2, "trivy.db", "--download-db-only"),
    "java-db": (1, "trivy-java.db", "--download-java-db-only"),
}


def metadata(root: Path, kind: str, now: datetime) -> dict | None:
    version, filename, _ = DATABASES[kind]
    path = root / kind
    try:
        if (
            path.is_symlink()
            or (path / filename).is_symlink()
            or not (path / filename).is_file()
            or (path / filename).stat().st_size == 0
            or (path / "metadata.json").is_symlink()
        ):
            return None
        value = json.loads((path / "metadata.json").read_text())
        updated = datetime.fromisoformat(value["UpdatedAt"])
        expires = datetime.fromisoformat(value["NextUpdate"])
        if value["Version"] != version or not updated <= now < expires:
            return None
        return {"schema": version, "updated_at": updated.isoformat(), "next_update": expires.isoformat()}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def download(image: str, root: Path, kind: str) -> None:
    # No host/registry credential variables are forwarded into the scanner container.
    user = "0:0" if docker.rootless() else f"{os.getuid()}:{os.getgid()}"
    command = [
        "docker",
        "run",
        "--rm",
        "--user",
        user,
        "--volume",
        f"{root}:/cache",
        "--entrypoint",
        "trivy",
        image,
        "image",
        "--cache-dir",
        "/cache",
        "--no-progress",
        "--timeout",
        "5m",
        DATABASES[kind][2],
    ]
    for attempt in range(2):
        name = "nddev-trivy-db-" + uuid.uuid4().hex
        try:
            result = subprocess.run(
                [*command[:3], "--name", name, *command[3:]], capture_output=True, timeout=330, check=False
            )
            if result.returncode == 0:
                return
        except subprocess.TimeoutExpired:
            pass
        finally:
            subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=30, check=False)
        if attempt == 0:
            time.sleep(2)
    # Native OCI pulling checks the upstream content digest. Never use an expired DB on failure.
    # Keep diagnostics bounded and omit raw registry responses, URLs and credential-bearing config.
    raise Unavailable(
        f"infrastructure.external-download: Trivy {kind} unavailable after two bounded attempts"
    )


def snapshot(source: Path, destination: Path, kind: str) -> None:
    """Keep the immutable DB generation alive; mutable analysis never uses these hardlinks."""
    (destination / kind).mkdir()
    for filename in (DATABASES[kind][1], "metadata.json"):
        original, target = source / kind / filename, destination / kind / filename
        original.chmod(0o444)
        try:
            os.link(original, target)
        except OSError as error:
            if error.errno not in {errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP}:
                raise
            subprocess.run(
                ["cp", "--reflink=auto", str(original), str(target)],
                capture_output=True,
                timeout=120,
                check=True,
            )
        target.chmod(0o444)


def prepare(
    storage: Path,
    destination: Path,
    image: str,
    *,
    java: bool = False,
    budget: int = 4 * 1024**3,
    reserve: int = 32 * 1024**3,
    ttl: int = 7 * 86400,
    wait_seconds: int = 660,
) -> dict:
    if not re.fullmatch(r"[a-z0-9][a-z0-9./_:-]*@sha256:[a-f0-9]{64}", image):
        raise Invalid("Trivy database preparation requires the caller's exact digest-pinned scanner image")
    if (
        not storage.is_absolute()
        or not destination.is_absolute()
        or storage.resolve() != storage
        or destination.resolve() != destination
        or storage == destination
        or storage in destination.parents
        or destination in storage.parents
        or any(c in str(storage) + str(destination) for c in ":\r\n\0")
        or type(java) is not bool
        or any(type(v) is not int for v in (budget, reserve, ttl, wait_seconds))
        or budget < 1024**2
        or reserve < 0
        or ttl < 1
        or not 0 <= wait_seconds <= 660
    ):
        raise Invalid(
            "Select separate absolute owned DB/scan caches and finite byte, reserve, TTL and wait budgets"
        )
    if destination.exists():
        raise Invalid("Prepare the database snapshot in a fresh job-owned scan cache")
    kinds = ["db", *(["java-db"] if java else [])]
    # Optional Java use does not create a second copy of the same vulnerability database.
    inputs = {"kind": "trivy-databases", "image": image, "schemas": {k: DATABASES[k][0] for k in DATABASES}}
    deadline = time.monotonic() + wait_seconds
    with ExitStack() as stack:
        while True:
            try:
                owned = stack.enter_context(cache.namespace(storage, inputs, blocking=False))
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Unavailable(
                        "infrastructure.cache-busy: Trivy database refresh wait budget exhausted"
                    ) from None
                time.sleep(min(1, max(0, deadline - time.monotonic())))
        cache.reclaim(storage, budget, reserve, ttl)
        if shutil.disk_usage(storage).free < reserve:
            raise Unavailable("infrastructure.disk-reserve: Trivy database cache reserve unavailable")
        current = owned / "current"
        if current.is_symlink():
            raise Invalid("The owned Trivy database generation cannot follow a symlink")
        now = datetime.now(UTC)
        existing = {k: metadata(current, k, now) for k in DATABASES}
        observations = {k: existing[k] for k in kinds}
        reused = all(observations.values())
        if not reused:
            with tempfile.TemporaryDirectory(prefix="refresh-", dir=owned) as temporary:
                pending = Path(temporary)
                prepared_kinds = []
                for kind in DATABASES:
                    if existing[kind]:
                        snapshot(current, pending, kind)
                    elif kind in kinds:
                        # Refresh only this expired/missing database, not a still-fresh Java DB.
                        download(image, pending, kind)
                    else:
                        continue
                    prepared_kinds.append(kind)
                now = datetime.now(UTC)
                observations = {k: metadata(pending, k, now) for k in kinds}
                if not all(observations.values()):
                    raise Invalid("Downloaded Trivy databases are missing, incompatible or expired")
                if cache.size(pending) > budget:
                    raise Invalid("Downloaded Trivy databases exceed the selected cache byte budget")
                if current.exists():
                    shutil.rmtree(
                        current
                    )  # owned inactive generation; every scan gets an independent snapshot
                current.mkdir()
                for kind in prepared_kinds:
                    os.replace(pending / kind, current / kind)
        destination.mkdir(mode=0o700, parents=True)
        try:
            for kind in kinds:
                snapshot(current, destination, kind)
            atomic_json(
                destination / ".nddev-trivy-databases.json", {"image": image, "databases": observations}
            )
        except BaseException:
            shutil.rmtree(destination)  # only the fresh directory created by this operation
            raise
        os.utime(owned, None)
        result = {
            "status": "success",
            "reused": reused,
            "cache_dir": str(destination),
            "databases": observations,
        }
    cache.reclaim(storage, budget, reserve, ttl)
    return result
