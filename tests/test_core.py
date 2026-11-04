import json
import subprocess
import sys
import tarfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from nddev_cicd import artifacts, cache, ci, config, delivery, documentation, github, impact, reports, routing
from nddev_cicd.model import Invalid, Unavailable, digest, git, identity, source_identity
from nddev_cicd.process import run


def test_routing_before_allocation():
    assert routing.select("public", "linux")["runner"] == ["ubuntu-26.04"]
    private = {"private_labels": ["self-hosted", "Linux", "X64", "fixture-linux"], "trusted": True}
    assert routing.select("private", "linux", **private)["provider"] == "self-hosted"
    with pytest.raises(Invalid):
        routing.select("private", "linux")
    with pytest.raises(Invalid):
        routing.select("private", "windows")
    for platform in ("unknown", "Linux", ""):
        with pytest.raises(Invalid):
            routing.select("public", platform)
    policy = {
        "blacksmith": {
            "enabled": True,
            "guarantee": "email-alert",
            "reference": "alert",
            "platforms": ["windows"],
            "architectures": ["x64"],
            "runners": {"windows": ["paid"]},
        }
    }
    assert routing.select("public", "windows", admission=policy)["provider"] == "github"
    with pytest.raises(Invalid):
        routing.select("private", "windows", admission=policy)
    policy["blacksmith"]["guarantee"] = "hard-no-overage"
    assert routing.select("private", "windows", admission=policy)["provider"] == "blacksmith"
    policy = {"github": {**policy["blacksmith"], "guarantee": "standard-public"}}
    with pytest.raises(Invalid):
        routing.select("public", "windows", admission=policy)


def test_process_failure_missing_timeout_and_output(tmp_path):
    successful = run([sys.executable, "-c", "print(21 * 2)"], tmp_path, tmp_path / "ok.log")
    assert successful["status"] == "success" and "42" in Path(successful["log"]).read_text()
    failed = run(
        [sys.executable, "-c", "raise RuntimeError('native failure')"], tmp_path, tmp_path / "fail.log"
    )
    assert failed["status"] == "failure" and failed["exit_code"] != 0
    assert run(["absent-nddev-tool"], tmp_path, tmp_path / "missing.log")["status"] == "unavailable"
    timed = run(
        [sys.executable, "-c", "import time; time.sleep(10)"], tmp_path, tmp_path / "timed.log", timeout=1
    )
    assert timed["status"] == "failure" and timed["detail"] == "timeout"
    assert timed["seconds"] < 8


def test_native_report_collection(tmp_path):
    log = tmp_path / "test.log"
    report = tmp_path / "tests.xml"
    for contents in (
        "<testsuite/>",
        "<testsuite><testcase><skipped/></testcase></testsuite>",
        "<testsuite><testcase><failure/></testcase></testsuite>",
    ):
        report.write_text(contents)
        with pytest.raises(Invalid):
            reports.tests(tmp_path, {"path": "tests.xml"}, log)
    report.write_text('<testsuite><testcase name="actual"/></testsuite>')
    assert reports.tests(tmp_path, {"path": "tests.xml"}, log) == 1
    log.write_text("test result: ok. 2 passed; 0 failed\n")
    assert reports.tests(tmp_path, {"kind": "cargo"}, log) == 2
    log.write_text(
        "\n".join(
            json.dumps(event)
            for event in [
                {"type": "testDone", "result": "success", "skipped": False},
                {"type": "done", "success": True},
            ]
        )
    )
    assert reports.tests(tmp_path, {"kind": "dart-json"}, log) == 1
    assert reports.aggregate(["a", "b"], [{"name": "a", "status": "success"}])["status"] == "failure"
    assert reports.aggregate(["a"], [{"name": "a", "status": "unavailable"}])["status"] == "failure"


def test_artifact_bytes_mode_escape_and_tampering(repository, tmp_path):
    root = repository({"site/index.html": "revision-one", "bin/tool": "#!/bin/sh\nexit 0\n"})
    (root / "bin/tool").chmod(0o755)
    source = source_identity(root)
    archive = tmp_path / "artifact.tar.gz"
    manifest = artifacts.pack(root, ["site/*", "bin/*"], archive, source)
    artifacts.verify(archive, manifest, source)
    destination = tmp_path / "installed"
    artifacts.unpack(archive, manifest, destination, source)
    assert (destination / "bin/tool").stat().st_mode & 0o777 == 0o755
    assert (destination / "site/index.html").read_text() == "revision-one"
    with pytest.raises(Invalid):
        artifacts.verify(archive, manifest, {**source, "tested_revision": "0" * 40})
    with pytest.raises(Invalid):
        artifacts.pack(root, ["../*"], archive, source)
    (root / "leak").symlink_to(tmp_path / "outside")
    (tmp_path / "outside").write_text("outside")
    with pytest.raises(Invalid):
        artifacts.pack(root, ["leak"], archive, source)
    (root / ".env").write_text("not-a-secret-but-private")
    with pytest.raises(Invalid):
        artifacts.pack(root, [".env"], archive, source)
    archive.write_bytes(archive.read_bytes() + b"modified")
    with pytest.raises(Invalid):
        artifacts.verify(archive, manifest, source)


def test_malicious_tar_is_rejected(tmp_path):
    archive = tmp_path / "evil.tar.gz"
    import io

    with tarfile.open(archive, "w:gz") as tar:
        member = tarfile.TarInfo("../escape")
        member.size = 1
        tar.addfile(member, io.BytesIO(b"x"))
    source = {"repository": "fixture/source", "tested_revision": "a" * 40}
    manifest = {
        "schema": 1,
        "archive_sha256": digest(archive),
        "source": source,
        "files": {"../escape": {"sha256": "unused", "mode": 0o644}},
    }
    manifest["artifact_identity"] = identity(manifest)
    with pytest.raises(Invalid):
        artifacts.unpack(archive, manifest, tmp_path / "target", source)
    assert not (tmp_path / "escape").exists()


def test_cache_ownership_actual_lock_and_budget(tmp_path):
    root = tmp_path / "cache"
    with cache.namespace(root, {"repo": "one"}) as owned:
        (owned / "data").write_bytes(b"x" * 100)
        # A separate process cannot enter or delete an active namespace.
        code = "from pathlib import Path; from nddev_cicd.cache import lock; import sys;\nwith lock(Path(sys.argv[1]),blocking=False): pass"
        result = subprocess.run(
            [sys.executable, "-c", code, str(root / (owned.name + ".lock"))], check=False, capture_output=True
        )
        assert result.returncode != 0
        assert cache.reclaim(root, 1, 0, 1) == []
    assert cache.reclaim(root, 1, 0, 1) == []
    assert (owned / "data").read_bytes() == b"x" * 100
    alien = tmp_path / "alien"
    alien.mkdir()
    (alien / "valuable").write_text("keep")
    with pytest.raises(Invalid), cache.namespace(alien, {"repo": "one"}):
        pass
    assert (alien / "valuable").read_text() == "keep"


def test_impact_deletion_dependency_and_uncertainty(repository):
    root = repository({"core/a": "one", "app/a": "two", "shared/lock": "three"})
    base = git(root, "rev-parse", "HEAD")
    (root / "core/a").unlink()
    git(root, "add", "-A")
    git(root, "commit", "-qm", "delete input")
    components = {"core": {"paths": ["core/*"]}, "app": {"paths": ["app/*"], "depends_on": ["core"]}}
    assert impact.affected(root, base, "HEAD", components, ["shared/*"]) == ["app", "core"]
    assert impact.affected(root, "missing-base", "HEAD", components, ["shared/*"]) == ["app", "core"]
    rename_base = git(root, "rev-parse", "HEAD")
    git(root, "mv", "app/a", "core/moved")
    git(root, "commit", "-qm", "move between independent components")
    components = {
        "core": {"paths": ["core/*"]},
        "app": {"paths": ["app/*"]},
        "consumer": {"paths": ["consumer/*"], "depends_on": ["app"]},
    }
    assert impact.affected(root, rename_base, "HEAD", components, []) == ["app", "consumer", "core"]


def test_docs_real_local_links_and_generation(repository):
    root = repository(
        {"README.md": "[guide](docs/guide.md)\n", "docs/guide.md": "# Guide\n", "data.yaml": "ok: true\n"}
    )
    assert documentation.check(root)["local_links"] == 1
    (root / "docs/guide.md").unlink()
    with pytest.raises(Invalid):
        documentation.check(root)
    with pytest.raises(Invalid):
        documentation.generation_clean(root)


def test_selected_native_failure_remains_failure(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Real source\n",
            ".github/nddev-ci.toml": """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["python3","-c","raise RuntimeError('broken example')"]
generate=["git","diff","--exit-code"]
examples=["python3","-c","assert 2+2==4"]
""",
        }
    )
    result = ci.execute(root, config.load(root), tmp_path / "report")
    assert result["status"] == "failure"
    assert "documentation.external-links" in result["failed"]
    assert next(x for x in result["results"] if x["name"] == "documentation.examples")["status"] == "success"


def test_static_delivery_actual_health_stale_data_guard_and_recovery(repository, tmp_path):
    root = repository({"index.html": "actual-application-revision"})
    source = source_identity(root)
    archive = tmp_path / "site.tar.gz"
    (root / "public").mkdir()
    (root / "public/index.html").write_text("actual-application-revision " + source["tested_revision"])
    manifest = artifacts.pack(root, ["public/index.html"], archive, source)
    target = tmp_path / "target"
    target.mkdir()
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(target)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = {
        "module": "static-web",
        "entrypoint": "public/index.html",
        "target_directory": str(target),
        "generation": 1,
        "expected_previous": None,
        "health_url": f"http://127.0.0.1:{server.server_port}/current/public/index.html",
        "health_contains": "actual-application-revision",
    }
    try:
        with pytest.raises(Invalid):
            delivery.apply(archive, manifest, source, settings, authorized=False)
        with pytest.raises(Invalid):
            delivery.apply(
                archive, manifest, source, {**settings, "data_migration": ["false"]}, authorized=True
            )
        record = delivery.apply(archive, manifest, source, settings, authorized=True)
        assert record["status"] == "success" and record["health"]["status"] == 200
        with pytest.raises(Invalid):
            delivery.apply(archive, manifest, source, settings, authorized=True)
        # Simulate cancellation after activation but before the durable success write.
        state_path = target / ".nddev-deployment.json"
        record.update(pending=True, status="failure")
        state_path.write_text(json.dumps(record))
        with pytest.raises(Invalid):
            delivery.apply(archive, manifest, source, settings, authorized=True)
        recovered = delivery.apply(
            archive, manifest, source, {**settings, "recover_partial": True}, authorized=True
        )
        assert recovered["status"] == "success" and not recovered["pending"]
        assert (target / "current/public/index.html").read_text() == "actual-application-revision " + source[
            "tested_revision"
        ]
        # A subsequent valid delivery must still replace the owned current symlink.
        previous_release = (target / "current").resolve()
        (root / "public/index.html").write_text(
            "next actual-application-revision " + source["tested_revision"]
        )
        next_archive = tmp_path / "next-site.tar.gz"
        next_manifest = artifacts.pack(root, ["public/index.html"], next_archive, source)
        next_record = delivery.apply(
            next_archive,
            next_manifest,
            source,
            {**settings, "generation": 2, "expected_previous": record["artifact"]},
            authorized=True,
        )
        assert next_record["status"] == "success" and next_record["generation"] == 2
        assert (target / "current").is_symlink() and (target / "current").resolve() != previous_release
        assert previous_release.is_dir()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_github_lineage_rejects_other_tree_and_attempt(monkeypatch):
    repository = "fixture/source"
    revision, head, base, tested, tree = [c * 40 for c in "abcde"]
    run = {
        "repository": {"full_name": repository},
        "head_repository": {"full_name": repository},
        "event": "pull_request",
        "status": "completed",
        "conclusion": "success",
        "path": ".github/workflows/ci.yml",
        "pull_requests": [{"number": 1}],
        "head_sha": head,
        "run_attempt": 2,
    }
    pull = {
        "merged": True,
        "merge_commit_sha": revision,
        "head": {"sha": head, "repo": {"full_name": repository}},
    }
    responses = {
        f"repos/{repository}/actions/runs/1": run,
        f"repos/{repository}/pulls/1": pull,
        f"repos/{repository}/git/commits/{tested}": {
            "tree": {"sha": tree},
            "parents": [{"sha": head}, {"sha": base}],
        },
        f"repos/{repository}/git/commits/{revision}": {"tree": {"sha": tree}},
    }
    monkeypatch.setattr(github, "get", lambda path: responses[path])
    source = {
        "repository": repository,
        "head": head,
        "base": base,
        "run_id": "1",
        "attempt": "2",
        "event": "pull_request",
        "tested_revision": tested,
        "tested_tree": tree,
    }
    assert github.eligible(repository, 1, revision, run["path"], source)["attempt"] == "2"
    run["pull_requests"] = []
    responses[f"repos/{repository}/commits/{revision}/pulls"] = [
        {**pull, "number": 1, "merged_at": "2026-10-19T00:00:00Z"}
    ]
    assert github.eligible(repository, 1, revision, run["path"], source)["head"] == head
    with pytest.raises(Invalid):
        github.eligible(repository, 1, revision, run["path"], {**source, "attempt": "1"})
    responses[f"repos/{repository}/git/commits/{revision}"]["tree"] = {"sha": "f" * 40}
    with pytest.raises(Invalid):
        github.eligible(repository, 1, revision, run["path"], source)


def test_impact_unknown_changed_path_keeps_all_obligations(repository):
    root = repository({"core/a": "one", "other/contract": "two"})
    base = git(root, "rev-parse", "HEAD")
    (root / "core/a").write_text("changed")
    (root / "other/contract").write_text("changed")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "mixed known and unknown inputs")
    components = {"core": {"paths": ["core/*"]}, "separate": {"paths": ["separate/*"]}}
    assert impact.affected(root, base, "HEAD", components, []) == ["core", "separate"]
    components["core"]["depends_on"] = ["separate"]
    components["separate"]["depends_on"] = ["core"]
    with pytest.raises(Invalid):
        impact.affected(root, base, "HEAD", components, [])


def test_requested_tool_version_is_actually_checked(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Source\n",
            ".github/nddev-ci.toml": """schema=1
profiles=["documentation"]
[tools.python]
command=["python3","--version"]
pattern="^Python 0.0.0$"
[commands.documentation]
external-links=["git","diff","--exit-code"]
generate=["git","diff","--exit-code"]
examples=["python3","-c","assert 2*3==6"]
""",
        }
    )
    result = ci.execute(root, config.load(root), tmp_path / "report")
    assert result["status"] == "failure" and "tool.python" in result["failed"]
    tool = next(item for item in result["results"] if item["name"] == "tool.python")
    assert tool["detail"] == "Executed tool version differs from selected contract"
    path = root / ".github/nddev-ci.toml"
    path.write_text(
        path.read_text()
        .replace(
            'command=["python3","--version"]',
            'command=["python3","-c","import sys; print(\'bootstrap information\', file=sys.stderr); print(\'Python \' + sys.version.split()[0])"]',
        )
        .replace('pattern="^Python 0.0.0$"', 'pattern="^Python [0-9]+[.][0-9]+[.][0-9]+$"')
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "select real wrapper output")
    wrapped = ci.execute(root, config.load(root), tmp_path / "wrapper-report")
    assert wrapped["status"] == "success"


def test_selected_extra_cannot_reuse_an_old_positive_report(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Source\n",
            ".github/nddev-ci.toml": """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["git","diff","--exit-code"]
generate=["git","diff","--exit-code"]
examples=["python3","-c","assert 3+3==6"]
[extras.native-tests]
purpose="Reject stale positive test reports"
command=["python3","-c","pass"]
report={kind="junit",path=".nddev-reports/extra.xml"}
""",
        }
    )
    report = root / ".nddev-reports/extra.xml"
    report.parent.mkdir()
    report.write_text('<testsuite><testcase name="old"/></testsuite>')
    result = ci.execute(root, config.load(root), tmp_path / "result")
    assert result["status"] == "failure" and "extra.native-tests" in result["failed"]
    assert not report.exists()


def test_cache_reclamation_preserves_a_server_pending_reconciliation(tmp_path):
    root = tmp_path / "cache"
    with cache.namespace(root, {"repository": "fixture/cache"}) as owned:
        (owned / ".sccache-active.json").write_text('{"socket":"owned-pending-socket"}')
        (owned / "data").write_bytes(b"x" * 128)
    assert cache.reclaim(root, 1, 0, 1) == []
    assert (owned / "data").read_bytes() == b"x" * 128
    (owned / ".sccache-active.json").unlink()
    assert cache.reclaim(root, 1, 0, 1) == []
    assert (owned / "data").read_bytes() == b"x" * 128


def test_deployment_rejects_foreign_release_owner_and_unscoped_waiver(repository, tmp_path):
    root = repository({"index.html": "verified fixture"})
    source = source_identity(root)
    archive = tmp_path / "site.tar.gz"
    manifest = artifacts.pack(root, ["index.html"], archive, source)
    target = tmp_path / "target"
    releases = target / ".nddev-releases"
    releases.mkdir(parents=True)
    (releases / ".nddev-owner").write_text("another-producer\n")
    (releases / "valuable").write_text("keep")
    settings = {
        "health_url": "http://127.0.0.1/fixture-health",
        "module": "static-web",
        "target_directory": str(target),
        "generation": 1,
        "expected_previous": None,
    }
    with pytest.raises(Invalid, match="unowned release"):
        delivery.apply(archive, manifest, source, settings, authorized=True)
    assert (releases / "valuable").read_text() == "keep"
    with pytest.raises(Invalid, match="waiver needs"):
        delivery.apply(
            archive,
            manifest,
            source,
            {**settings, "data_migration": ["false"], "backup_waiver": True},
            authorized=True,
        )
    assert not (target / "current").exists()


def test_explicit_external_timeout_remains_unavailable_and_broken_urls_fail(repository):
    root = repository({"README.md": "# Source\n", ".gitignore": ".nddev-reports/\n"})
    native_report = root / ".nddev-reports/links.json"
    native_report.parent.mkdir()
    settings = {
        "external_link_report": ".nddev-reports/links.json",
        "network_timeouts": {
            "https://unavailable.example.invalid/": "https://github.com/fixture/source/issues/1"
        },
    }
    payload = {
        "errors": 0,
        "unknown": 0,
        "timeouts": 1,
        "timeout_map": {"README.md": [{"url": "https://unavailable.example.invalid/"}]},
    }
    native_report.write_text(json.dumps(payload))
    limited = documentation.external_outage(root, settings, {"status": "failure"})
    assert limited is not None and limited["status"] == "unavailable"
    result = reports.aggregate(["links"], [{"name": "links", **limited}])
    assert result["status"] == "success" and result["limitations"] == ["links"]
    payload.update(errors=1, error_map={"README.md": [{"url": "https://broken.example.invalid/"}]})
    native_report.write_text(json.dumps(payload))
    assert documentation.external_outage(root, settings, {"status": "failure"}) is None
    assert reports.aggregate(["links"], [{"name": "links", "status": "failure"}])["status"] == "failure"


def test_native_failure_report_is_retained_and_escape_rejected(repository, tmp_path):
    root = repository({"README.md": "# Fixture\n"})
    native = root / ".nddev-reports" / "failed.xml"
    native.parent.mkdir()
    native.write_text(
        '<testsuite><testcase name="failure"><failure>counterexample</failure></testcase></testsuite>'
    )
    directory = tmp_path / "retained"
    assert len(reports.retain(root, {"path": ".nddev-reports/*.xml"}, directory)) == 1
    assert next(directory.glob("*-failed.xml")).read_bytes() == native.read_bytes()
    native.unlink()
    native.symlink_to(tmp_path / "outside.xml")
    with pytest.raises(Invalid):
        reports.retain(root, {"path": ".nddev-reports/*.xml"}, directory)


def test_documentation_scopes_keep_archives_frozen_and_access_failures_explicit(repository):
    root = repository({"README.md": "# Active\n", "archive/old/README.md": "[past](absent.md)\n"})
    assert documentation.check(root, {"exclude": ["archive/"]})["files"] == 1
    with pytest.raises(Invalid):
        documentation.check(root)
    report = root / "links.json"
    settings = {
        "external_link_report": "links.json",
        "access_outages": {
            "https://example.invalid/guide": {
                "status": 403,
                "reason": "Scanner access denied",
                "issue": "https://example.invalid/issue/1",
            }
        },
    }
    payload = {
        "unknown": 0,
        "unsupported": 0,
        "timeouts": 0,
        "errors": 1,
        "error_map": {
            "README.md": [
                {"url": "https://example.invalid/guide", "status": {"code": 403, "text": "Forbidden"}}
            ]
        },
    }
    report.write_text(json.dumps(payload))
    assert documentation.external_outage(root, settings, {"status": "failure"})["status"] == "unavailable"
    payload["error_map"]["README.md"][0]["status"]["code"] = 404
    report.write_text(json.dumps(payload))
    assert documentation.external_outage(root, settings, {"status": "failure"}) is None


def test_validation_cannot_change_its_locked_inputs(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Inputs\n",
            "uv.lock": "version=1\n",
            ".github/nddev-ci.toml": """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["git","diff","--exit-code"]
generate=["git","diff","--exit-code"]
examples=["python3","-c","from pathlib import Path; Path('uv.lock').write_text('version=2')"]
""",
        }
    )
    result = ci.execute(root, config.load(root), tmp_path / "report")
    assert result["status"] == "failure"
    integrity = next(row for row in result["results"] if row["name"] == "inputs.lock-integrity")
    assert integrity["changed_inputs"] == ["uv.lock"]


def test_admission_uses_actual_caller_visibility_and_fork_trust(tmp_path, monkeypatch, capsys):
    from nddev_cicd.__main__ import main

    event = tmp_path / "event.json"
    policy = tmp_path / "policy.json"
    event.write_text(json.dumps({"repository": {"full_name": "fixture/private", "visibility": "private"}}))
    policy.write_text(json.dumps({"visibility": "public", "platform": "windows"}))
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_REPOSITORY", "fixture/private")
    assert main(["route", "--policy", str(policy)]) == 2
    output = capsys.readouterr()
    assert not output.out and "actual caller" in output.err
    event.write_text(
        json.dumps(
            {
                "repository": {"full_name": "fixture/private", "visibility": "private"},
                "pull_request": {"head": {"repo": {"full_name": "outside/fork"}}},
            }
        )
    )
    selected = routing.caller_policy(
        {
            "visibility": "private",
            "platform": "linux",
            "trusted": True,
            "private_labels": ["self-hosted", "Linux", "X64", "existing"],
        }
    )
    with pytest.raises(Unavailable):
        routing.select(**selected)
    with pytest.raises(Invalid):
        routing.select("public", "windows", admission={"blacksmith": {"enabled": "false"}})


def test_trusted_actor_policy_does_not_depend_on_an_optional_webhook_association(tmp_path, monkeypatch):
    event = tmp_path / "event.json"
    event.write_text(
        json.dumps(
            {
                "repository": {"full_name": "fixture/private", "visibility": "private"},
                "pull_request": {
                    "head": {"repo": {"full_name": "fixture/private"}},
                    "user": {"login": "fixture-owner"},
                },
            }
        )
    )
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_REPOSITORY", "fixture/private")
    monkeypatch.setenv("GITHUB_ACTOR", "fixture-owner")
    policy = {
        "visibility": "private",
        "platform": "linux",
        "trusted": True,
        "private_labels": ["self-hosted", "Linux", "X64", "existing"],
        "trusted_actors": ["fixture-owner"],
    }
    assert routing.select(**routing.caller_policy(policy))["provider"] == "self-hosted"
    data = json.loads(event.read_text())
    data["pull_request"]["user"]["login"] = "untrusted-bot"
    event.write_text(json.dumps(data))
    with pytest.raises(Unavailable):
        routing.select(**routing.caller_policy(policy))
