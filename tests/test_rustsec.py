"""Native input transport retries must never retry or waive audit findings."""

import os
import subprocess
from pathlib import Path

import pytest

from nddev_cicd import rustsec
from nddev_cicd.model import Invalid, Unavailable


def test_real_shallow_git_reuses_objects_and_advances_to_current_source(tmp_path, monkeypatch):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    rustsec.git(upstream, "init", "--quiet")
    for key, value in (("user.name", "Synthetic Fixture"), ("user.email", "fixture@example.invalid")):
        rustsec.git(upstream, "config", key, value)
    (upstream / "advisory.txt").write_text("first fixture")
    rustsec.git(upstream, "add", ".")
    rustsec.git(upstream, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
    monkeypatch.setattr(rustsec, "SOURCE", upstream.as_uri())
    commands, native = [], rustsec.native_run

    def invoke(command, root, log, **kwargs):
        if "cargo" in command and command[command.index("cargo") + 1] == "audit":
            commands.append(command)
            database = Path(command[command.index("--db") + 1])
            assert (database / "advisory.txt").read_text() == (upstream / "advisory.txt").read_text()
            log.write_text("")
            kwargs["stderr_log"].write_text("")
            return {"status": "success", "exit_code": 0, "detail": ""}
        return native(command, root, log, **kwargs)

    monkeypatch.setattr(rustsec, "native_run", invoke)
    storage = tmp_path / "owned"
    for _ in range(2):
        assert rustsec.audit(tmp_path, storage, reserve=0) == 0
    database = next(storage.glob("*/repository"))
    assert rustsec.git(database, "rev-parse", "--is-shallow-repository") == "true"
    before = (database / ".git/objects").stat().st_ino
    (upstream / "advisory.txt").write_text("updated fixture")
    rustsec.git(upstream, "add", ".")
    rustsec.git(upstream, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "updated")
    assert rustsec.audit(tmp_path, storage, reserve=0) == 0
    assert (database / ".git/objects").stat().st_ino == before
    assert len(commands) == 3
    assert all(command[-3:] == ["--no-fetch", "--deny", "warnings"] for command in commands)


@pytest.mark.parametrize("failure", ["timed out", "early EOF", "authentication failed"])
def test_fetch_is_bounded_and_only_retries_transport(failure, monkeypatch, tmp_path):
    calls = []

    def fail(*args):
        calls.append(args)
        raise subprocess.CalledProcessError(128, "git", stderr=failure)

    monkeypatch.setattr(rustsec, "git", fail)
    with pytest.raises(Unavailable, match="infrastructure.external-download"):
        rustsec.fetch(tmp_path)
    assert len(calls) == (1 if failure == "authentication failed" else 2)


def test_audit_verdict_is_not_retried_or_changed(tmp_path, monkeypatch):
    calls = []
    native = rustsec.native_run

    def invoke(command, root, log, **kwargs):
        if "cargo" in command and command[command.index("cargo") + 1] == "audit":
            calls.append(command)
            log.write_text("")
            kwargs["stderr_log"].write_text("")
            return {"status": "failure", "exit_code": 17, "detail": ""}
        return native(command, root, log, **kwargs)

    monkeypatch.setattr(rustsec, "native_run", invoke)
    monkeypatch.setattr(rustsec, "fetch", lambda repo: None)
    original = rustsec.git

    def fixture(repo, *args):
        if args[0] == "checkout":
            return ""
        if args == ("rev-parse", "HEAD"):
            return "a" * 40
        return original(repo, *args)

    monkeypatch.setattr(rustsec, "git", fixture)
    assert rustsec.audit(tmp_path, tmp_path / "cache", reserve=0) == 17
    assert len(calls) == 1


def test_unowned_and_redirected_cache_paths_are_refused(tmp_path):
    owned = tmp_path / "cache"
    owned.mkdir()
    (owned / "foreign").write_text("preserve")
    with pytest.raises(Invalid, match="unowned"):
        rustsec.audit(tmp_path, owned, reserve=0)
    link = tmp_path / "redirected"
    link.symlink_to(owned, target_is_directory=True)
    with pytest.raises(Invalid, match="symlink"):
        rustsec.audit(tmp_path, link, reserve=0)
    assert (owned / "foreign").read_text() == "preserve"


def test_failed_refresh_never_invokes_the_scanner(tmp_path, monkeypatch):
    called = []
    native = rustsec.native_run

    def invoke(command, root, log, **kwargs):
        if "cargo" in command and command[command.index("cargo") + 1] == "audit":
            called.append(command)
        return native(command, root, log, **kwargs)

    def unavailable(_repository):
        raise Unavailable("infrastructure.external-download: fixture")

    monkeypatch.setattr(rustsec, "native_run", invoke)
    monkeypatch.setattr(rustsec, "fetch", unavailable)
    with pytest.raises(Unavailable, match="external-download"):
        rustsec.audit(tmp_path, tmp_path / "cache", reserve=0)
    assert not called


@pytest.mark.parametrize("detail,attempts", [("timeout", 2), ("cancelled", 1)])
def test_native_process_owner_bounds_fetch_and_cancellation_is_not_retried(
    tmp_path, monkeypatch, detail, attempts
):
    calls = []

    def failed(command, root, log, **kwargs):
        calls.append((command, kwargs["timeout"]))
        log.write_text("")
        kwargs["stderr_log"].write_text("")
        return {"status": "failure", "exit_code": -9, "detail": detail}

    monkeypatch.setattr(rustsec, "native_run", failed)
    with pytest.raises(KeyboardInterrupt if detail == "cancelled" else Unavailable):
        rustsec.fetch(tmp_path)
    assert len(calls) == attempts
    assert all(timeout == 150 for _, timeout in calls)


def test_native_cache_git_ignores_foreign_repository_context(tmp_path, monkeypatch):
    repository = tmp_path / "owned"
    repository.mkdir()
    foreign = tmp_path / "must-not-exist"
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"):
        monkeypatch.setenv(key, str(foreign))
    rustsec.git(repository, "init", "--quiet")
    assert Path(rustsec.git(repository, "rev-parse", "--show-toplevel")) == repository
    assert not foreign.exists()
    assert os.environ["GIT_DIR"] == str(foreign)


def test_cache_refuses_a_foreign_git_directory_pointer_before_git_runs(tmp_path, monkeypatch):
    storage = tmp_path / "cache"
    with rustsec.cache.namespace(storage, {"kind": "rustsec", "source": rustsec.SOURCE}) as owned:
        repository = owned / "repository"
        repository.mkdir()
        (repository / ".git").write_text("gitdir: /synthetic/foreign-git-directory\n")

    def unexpected(*_args):
        raise AssertionError("Foreign Git metadata must not be opened")

    monkeypatch.setattr(rustsec, "git", unexpected)
    with pytest.raises(Invalid, match="foreign worktree"):
        rustsec.audit(tmp_path, storage, reserve=0)
