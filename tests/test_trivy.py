"""Fresh shared input reuse cannot share a mutable scan DB or conceal an unavailable refresh."""

import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from nddev_cicd import trivy
from nddev_cicd.__main__ import main
from nddev_cicd.model import Invalid, Unavailable

IMAGE = "mirror.gcr.io/aquasec/trivy:0.75.0@sha256:" + "a" * 64


def downloaded(root, kind, *, expires=None):
    now = datetime.now(UTC)
    version, filename, _ = trivy.DATABASES[kind]
    path = root / kind
    path.mkdir(exist_ok=True)
    (path / filename).write_bytes(b"native fixture database")
    (path / "metadata.json").write_text(
        json.dumps(
            {
                "Version": version,
                "UpdatedAt": (now - timedelta(minutes=5)).isoformat(),
                "NextUpdate": (
                    expires or now + (timedelta(days=3) if kind == "java-db" else timedelta(hours=6))
                ).isoformat(),
            }
        )
    )


def test_fresh_db_downloads_once_and_analysis_stays_job_local(tmp_path, monkeypatch):
    calls = []

    def download(_image, root, kind):
        calls.append(kind)
        downloaded(root, kind)

    monkeypatch.setattr(trivy, "download", download)
    storage, first, second = (tmp_path / p for p in ("owned", "first", "second"))
    assert trivy.prepare(storage, first, IMAGE, java=True, reserve=0)["reused"] is False
    (first / "fanal").mkdir()
    (first / "fanal/cache.db").write_text("job-local Bolt scan cache")
    assert (first / "db/trivy.db").stat().st_mode & 0o222 == 0
    result = trivy.prepare(storage, second, IMAGE, java=True, reserve=0)
    assert result["reused"] is True
    assert calls == ["db", "java-db"]
    assert (second / "db/trivy.db").read_bytes() == b"native fixture database"
    assert not (second / "fanal").exists()
    assert (first / "db/trivy.db").stat().st_ino == (second / "db/trivy.db").stat().st_ino


def test_cross_filesystem_snapshot_falls_back_to_a_read_only_copy(tmp_path, monkeypatch):
    import errno

    monkeypatch.setattr(trivy, "download", lambda _image, root, kind: downloaded(root, kind))

    def cross_device(*_args, **_kwargs):
        raise OSError(errno.EXDEV, "different native mounts")

    monkeypatch.setattr(trivy.os, "link", cross_device)
    storage, target = tmp_path / "owned", tmp_path / "snapshot"
    trivy.prepare(storage, target, IMAGE, reserve=0)
    original = next(storage.glob("*/current/db/trivy.db"))
    assert original.stat().st_ino != (target / "db/trivy.db").stat().st_ino
    assert (target / "db/trivy.db").stat().st_mode & 0o222 == 0
    assert (target / "db/trivy.db").read_bytes() == b"native fixture database"


def test_parallel_jobs_share_only_the_refresh_lock(tmp_path, monkeypatch):
    calls = []
    mutex = threading.Lock()

    def download(_image, root, kind):
        with mutex:
            calls.append(kind)
        time.sleep(0.05)
        downloaded(root, kind)

    monkeypatch.setattr(trivy, "download", download)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(lambda n: trivy.prepare(tmp_path / "owned", tmp_path / str(n), IMAGE, reserve=0), (1, 2))
        )
    assert calls == ["db"]
    assert sorted(r["reused"] for r in results) == [False, True]
    # No namespace lock survives prepare; independent scans can proceed together.
    with trivy.cache.lock(next((tmp_path / "owned").glob("[a-f0-9]" * 64 + ".lock")), blocking=False):
        pass


def test_java_selection_shares_the_same_vulnerability_db_without_reloading_it(tmp_path, monkeypatch):
    calls = []

    def download(_image, root, kind):
        calls.append(kind)
        downloaded(root, kind)

    monkeypatch.setattr(trivy, "download", download)
    storage = tmp_path / "owned"
    trivy.prepare(storage, tmp_path / "non-java", IMAGE, reserve=0)
    trivy.prepare(storage, tmp_path / "java", IMAGE, java=True, reserve=0)
    trivy.prepare(storage, tmp_path / "non-java-again", IMAGE, reserve=0)
    assert calls == ["db", "java-db"]
    assert len(list(storage.glob("*/current"))) == 1


def test_expired_vulnerability_db_keeps_the_still_fresh_java_database(tmp_path, monkeypatch):
    calls = []

    def download(_image, root, kind):
        calls.append(kind)
        downloaded(root, kind, expires=datetime.now(UTC) + timedelta(days=1 if kind == "db" else 3))

    monkeypatch.setattr(trivy, "download", download)
    storage = tmp_path / "owned"
    trivy.prepare(storage, tmp_path / "first", IMAGE, java=True, reserve=0)
    calls.clear()

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(days=1, seconds=1)

    monkeypatch.setattr(trivy, "datetime", Later)

    # Refreshed native input must actually be newer than the advanced fixture clock.
    def refresh(_image, root, kind):
        calls.append(kind)
        downloaded(root, kind, expires=Later.now(UTC) + timedelta(days=1))

    monkeypatch.setattr(trivy, "download", refresh)
    trivy.prepare(storage, tmp_path / "second", IMAGE, reserve=0)
    assert calls == ["db"]
    assert next(storage.glob("*/current/java-db/trivy-java.db")).is_file()


def test_expired_db_refresh_failure_never_creates_a_successful_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(trivy, "download", lambda _image, root, kind: downloaded(root, kind))
    storage = tmp_path / "owned"
    trivy.prepare(storage, tmp_path / "first", IMAGE, reserve=0)
    current = next(storage.glob("*/current"))

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(hours=7)

    monkeypatch.setattr(trivy, "datetime", Later)

    def unavailable(*_):
        raise Unavailable("infrastructure.external-download: fixture")

    monkeypatch.setattr(trivy, "download", unavailable)
    with pytest.raises(Unavailable):
        trivy.prepare(storage, tmp_path / "failed", IMAGE, reserve=0)
    assert not (tmp_path / "failed").exists()
    assert (current / "db/trivy.db").read_bytes() == b"native fixture database"


def test_downloaded_but_expired_or_incompatible_data_does_not_pass(tmp_path, monkeypatch):
    monkeypatch.setattr(
        trivy,
        "download",
        lambda _image, root, kind: downloaded(root, kind, expires=datetime.now(UTC) - timedelta(seconds=1)),
    )
    with pytest.raises(Invalid, match="expired"):
        trivy.prepare(tmp_path / "owned", tmp_path / "failed", IMAGE, reserve=0)
    assert not (tmp_path / "failed").exists()


def test_foreign_cache_and_existing_job_directory_are_preserved(tmp_path):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    (foreign / "keep").write_text("not ours")
    with pytest.raises(Invalid, match="unowned"):
        trivy.prepare(foreign, tmp_path / "fresh", IMAGE, reserve=0)
    assert (foreign / "keep").read_text() == "not ours"
    with pytest.raises(Invalid, match="fresh"):
        trivy.prepare(tmp_path / "owned", foreign, IMAGE, reserve=0)


def test_refresh_timeout_removes_only_its_named_container_and_keeps_failure(tmp_path, monkeypatch):
    commands = []
    monkeypatch.setattr(trivy.docker, "rootless", lambda: True)
    monkeypatch.setattr(trivy.time, "sleep", lambda _: None)

    def run(command, **_):
        commands.append(command)
        if command[1] == "run":
            raise subprocess.TimeoutExpired(command, 330)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(trivy.subprocess, "run", run)
    with pytest.raises(Unavailable, match="external-download"):
        trivy.download(IMAGE, tmp_path, "db")
    assert len(commands) == 4
    for start, cleanup in zip(commands[::2], commands[1::2], strict=True):
        assert cleanup == ["docker", "rm", "--force", start[start.index("--name") + 1]]
        assert start[start.index("--user") + 1] == "0:0"
        assert "--env" not in start


def test_only_typed_input_unavailability_emits_infrastructure_metadata(tmp_path, monkeypatch, capsys):
    def unavailable(*_a, **_k):
        raise Unavailable("infrastructure.external-download: fixture")

    monkeypatch.setattr(trivy, "prepare", unavailable)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setattr(
        "sys.argv",
        [
            "nddev-cicd",
            "trivy-db",
            "--storage",
            str(tmp_path / "owned"),
            "--destination",
            str(tmp_path / "fresh"),
            "--image",
            IMAGE,
        ],
    )
    assert main() == 2
    assert (
        "::error title=NDDev infrastructure input::infrastructure.external-download"
        in capsys.readouterr().out
    )
