"""Regressions reproduced by the independent review, using owned real processes and targets."""

import json
import os
import signal
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from nddev_cicd import artifacts, delivery, routing
from nddev_cicd.model import Invalid


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group regression; Windows uses taskkill /T")
@pytest.mark.parametrize("cancel", [False, True], ids=["timeout", "sigterm-cancellation"])
def test_owned_descendant_is_gone_after_leader_exits(tmp_path, cancel):
    marker = tmp_path / "owned.json"
    descendant = (
        "import os,signal,time,json; from pathlib import Path; "
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        f"Path({str(marker)!r}).write_text(json.dumps({{'pid':os.getpid(),'group':os.getpgrp()}})); "
        "time.sleep(60)"
    )
    leader = (
        f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{descendant!r}]); time.sleep(60)"
    )
    worker = (
        "import os,signal,sys,threading,json; from pathlib import Path; from nddev_cicd.process import run; "
        + ("threading.Timer(0.7,lambda:os.kill(os.getpid(),signal.SIGTERM)).start(); " if cancel else "")
        + f"print(json.dumps(run([sys.executable,'-c',{leader!r}],Path({str(tmp_path)!r}),"
        f"Path({str(tmp_path / 'native.log')!r}),timeout={5 if cancel else 1})))"
    )
    try:
        completed = subprocess.run(
            [sys.executable, "-c", worker], check=True, capture_output=True, text=True, timeout=15
        )
        result = json.loads(completed.stdout)
        assert result["status"] == "failure"
        assert result["detail"] == ("cancelled" if cancel else "timeout")
        owned = json.loads(marker.read_text())
        state = Path("/proc") / str(owned["pid"]) / "stat"
        # A killed orphan may await init reaping; it must no longer execute.
        assert not state.exists() or state.read_text().split(") ", 1)[1][0] == "Z"
    finally:
        if marker.exists():
            owned = json.loads(marker.read_text())
            try:
                assert owned["group"] != os.getpgrp() and os.getpgid(owned["pid"]) == owned["group"]
                os.kill(owned["pid"], signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize(
    "settings",
    [
        {"module": "static-web", "entrypoint": "index.html", "health_url": "http://127.0.0.1:bad/health"},
        {"module": "static-web", "entrypoint": "index.html", "health_url": "http://invalid host/health"},
        {
            "module": "systemd-binary",
            "service": "not-a-service-unit",
            "health_url": "http://127.0.0.1/health",
        },
        {
            "module": "compose",
            "project": "INVALID PROJECT",
            "services": ["app"],
            "health_url": "http://127.0.0.1/health",
        },
        {
            "module": "packages",
            "publisher": "python",
            "registry": "http://unsafe.invalid",
            "package_file": "index.html",
        },
        {"module": "static-web", "entrypoint": "missing.html", "health_url": "http://127.0.0.1/health"},
    ],
)
def test_invalid_operation_never_starts_backup_or_migration(tmp_path, settings):
    source = tmp_path / "source"
    source.mkdir()
    (source / "index.html").write_text("real selected payload")
    identity = {"repository": "example:preflight", "tested_revision": "fixture"}
    archive = tmp_path / "artifact.tar.gz"
    manifest = artifacts.pack(source, ["index.html"], archive, identity)
    target = tmp_path / "target"
    target.mkdir()
    backup, migration = tmp_path / "backup-ran", tmp_path / "migration-ran"
    config = {
        "target_directory": str(target),
        "generation": 1,
        "expected_previous": None,
        "backup_command": [sys.executable, "-c", f"from pathlib import Path; Path({str(backup)!r}).touch()"],
        "data_migration": [
            sys.executable,
            "-c",
            f"from pathlib import Path; Path({str(migration)!r}).touch()",
        ],
        **settings,
    }
    with pytest.raises(Invalid):
        delivery.apply(archive, manifest, identity, config, authorized=True)
    assert not backup.exists() and not migration.exists()
    assert list(target.iterdir()) == []


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_unowned_current_is_rejected_before_backup_migration_or_release(tmp_path, kind):
    source = tmp_path / "source"
    source.mkdir()
    (source / "index.html").write_text("valid selected payload")
    identity = {"repository": "example:current-conflict", "tested_revision": "fixture"}
    archive = tmp_path / "artifact.tar.gz"
    manifest = artifacts.pack(source, ["index.html"], archive, identity)
    target = tmp_path / "target"
    target.mkdir()
    current = target / "current"
    if kind == "directory":
        current.mkdir()
    existing = current / "existing.txt" if kind == "directory" else current
    existing.write_bytes(b"existing owner data\x00\n")
    backup, migration = tmp_path / "backup-ran", tmp_path / "migration-ran"
    config = {
        "module": "static-web",
        "entrypoint": "index.html",
        "health_url": "http://127.0.0.1/health",
        "target_directory": str(target),
        "generation": 1,
        "expected_previous": None,
        "backup_command": [sys.executable, "-c", f"from pathlib import Path; Path({str(backup)!r}).touch()"],
        "data_migration": [
            sys.executable,
            "-c",
            f"from pathlib import Path; Path({str(migration)!r}).touch()",
        ],
    }
    with pytest.raises(Invalid, match="unowned target"):
        delivery.apply(archive, manifest, identity, config, authorized=True)
    assert not backup.exists() and not migration.exists()
    assert not (target / ".nddev-releases").exists()
    assert not (target / ".nddev-deployment.json").exists()
    assert existing.read_bytes() == b"existing owner data\x00\n"
    assert not current.is_symlink()
    assert sorted(p.name for p in target.iterdir()) == [".nddev-deploy.lock", "current"]


@pytest.mark.parametrize("platform,architecture", [("linux", "x64"), ("windows", "x64"), ("macos", "arm64")])
def test_public_always_uses_standard_github_even_with_blacksmith_admission(platform, architecture):
    admission = {
        "blacksmith": {
            "enabled": True,
            "guarantee": "hard-no-overage",
            "reference": "fixture-owner-confirmation",
            "platforms": [platform],
            "architectures": [architecture],
            "runners": {platform: ["blacksmith-example"]},
        }
    }
    result = routing.select("public", platform, architecture=architecture, admission=admission)
    assert result["provider"] == "github" and result["runner"] == [routing.STANDARD[platform]]


@pytest.mark.parametrize(
    "suffix,entry", [("apk", "AndroidManifest.xml"), ("aab", "base/manifest/AndroidManifest.xml")]
)
def test_mobile_filename_and_zip_entry_never_establish_native_validity(tmp_path, suffix, entry):
    path = tmp_path / ("fake." + suffix)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(entry, "arbitrary text is not an Android manifest")
    # Missing native SDK is an unavailable validation, never a successful ZIP-only fallback.
    with pytest.raises(Invalid):
        delivery.mobile_format(path)


@pytest.mark.parametrize("key", ["GITHUB_TOKEN", "SSH_AUTH_SOCK", "PATH"])
def test_remote_environment_refuses_forwarding_runner_authority(key):
    from nddev_cicd.remote import environment_values

    with pytest.raises(Invalid):
        environment_values({key: "fixture-value"})


def test_native_sarif_missing_failed_analysis_and_blocking_findings(tmp_path):
    from nddev_cicd.__main__ import main
    from nddev_cicd.reports import sarif

    with pytest.raises(Invalid):
        sarif(tmp_path)
    report = tmp_path / "python.sarif"
    run = {
        "tool": {
            "driver": {
                "name": "CodeQL",
                "rules": [{"id": "example-rule", "properties": {"security-severity": "8.5"}}],
            }
        },
        "invocations": [{"executionSuccessful": True}],
        "results": [],
    }
    document = {"version": "2.1.0", "runs": [run]}
    report.write_text(json.dumps(document))
    assert sarif(tmp_path)["status"] == "success"
    run["results"] = [{"ruleIndex": 0, "ruleId": "example-rule", "message": {"text": "controlled finding"}}]
    report.write_text(json.dumps(document))
    assert main(["sarif-check", "--directory", str(tmp_path), "--minimum", "high"]) == 1
    # Native CodeQL combines query packs through SARIF tool extensions.
    run["tool"]["extensions"] = [{"name": "native-query-pack", "rules": run["tool"]["driver"]["rules"]}]
    run["tool"]["driver"]["rules"] = []
    run["results"][0]["rule"] = {"id": "example-rule", "index": 0, "toolComponent": {"index": 0}}
    report.write_text(json.dumps(document))
    assert main(["sarif-check", "--directory", str(tmp_path), "--minimum", "high"]) == 1
    run["invocations"][0]["executionSuccessful"] = False
    report.write_text(json.dumps(document))
    with pytest.raises(Invalid):
        sarif(tmp_path)


def test_native_structured_output_is_not_mixed_with_tool_diagnostics(tmp_path):
    from nddev_cicd.process import run

    output, diagnostics = tmp_path / "result.json", tmp_path / "diagnostics.log"
    result = run(
        [
            sys.executable,
            "-c",
            "import json,sys; print(json.dumps({'value':42})); print('SDK bootstrap progress',file=sys.stderr)",
        ],
        tmp_path,
        output,
        stderr_log=diagnostics,
    )
    assert result["status"] == "success" and json.loads(output.read_text()) == {"value": 42}
    assert diagnostics.read_text().strip() == "SDK bootstrap progress"
