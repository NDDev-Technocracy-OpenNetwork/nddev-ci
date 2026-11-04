"""Consumer regressions exercise real Git inputs, native processes and bounded API contracts."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from nddev_cicd import ci, config, documentation, feedback, impact, reports
from nddev_cicd.model import Invalid, git
from nddev_cicd.process import run


@pytest.mark.parametrize("skipped,executed", [(2, 0), (1, 1), (0, 2), (0, 0)])
def test_unittest_counts_actual_execution(tmp_path, skipped, executed):
    cases = ["import unittest", "class Cases(unittest.TestCase):", " pass"]
    for index in range(skipped):
        cases += [" @unittest.skip('not applicable')", f" def test_skipped_{index}(self): pass"]
    for index in range(executed):
        cases += [f" def test_executed_{index}(self): self.assertEqual(2 + 2, 4)"]
    (tmp_path / "cases.py").write_text("\n".join(cases) + "\n")
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "-v", "cases"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    log = tmp_path / "unittest.log"
    log.write_text(result.stdout + result.stderr)
    if executed:
        assert result.returncode == 0
        assert reports.tests(tmp_path, {"kind": "unittest"}, log) == executed
    else:
        with pytest.raises(Invalid):
            reports.tests(tmp_path, {"kind": "unittest"}, log)


def test_dependency_review_uses_both_pr_source_refs(repository, tmp_path, monkeypatch):
    from nddev_cicd import github

    root = repository({"requirements.txt": "demo==1"})
    base = git(root, "rev-parse", "HEAD")
    (root / "requirements.txt").write_text("demo==2")
    git(root, "commit", "-am", "dependency candidate")
    head = git(root, "rev-parse", "HEAD")
    (root / "README.md").write_text("synthetic merge context")
    git(root, "add", "README.md")
    git(root, "commit", "-m", "merge context")
    event = tmp_path / "event.json"
    event.write_text(
        json.dumps({"before": "c" * 40, "pull_request": {"base": {"sha": base}, "head": {"sha": head}}})
    )
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    assert github.dependency_review_refs(root) == {"base": base, "head": head}


DOC_COMMANDS = """schema=1
profiles=["documentation"]
[commands.documentation]
external-links=["git","diff","--exit-code"]
generate=["git","diff","--exit-code"]
examples=["git","diff","--exit-code"]
"""


@pytest.mark.parametrize(
    "path,pattern,expected",
    [
        ("uv.lock", "**/*lock*", True),
        ("backend/Cargo.lock", "**/*lock*", True),
        ("a/b/c.py", "a/**", True),
        ("a/c.py", "a/**/c.py", True),
        ("a/b/c.py", "a/*.py", False),
        ("a/pyproject.toml", "pyproject.toml", False),
        ("pyproject.toml", "pyproject.toml", True),
    ],
)
def test_impact_globs_are_anchored_and_recursive(path, pattern, expected):
    assert impact.matches(path, pattern) is expected


def test_lock_change_selects_every_component_and_nested_scope_is_precise(repository):
    root = repository({"uv.lock": "a", "backend/deep/app.py": "a", "docs/index.md": "a"})
    base = git(root, "rev-parse", "HEAD")
    components = {"backend": {"paths": ["backend/**"]}, "docs": {"paths": ["docs/**"]}}
    (root / "backend/deep/app.py").write_text("b")
    git(root, "commit", "-am", "change nested source")
    assert impact.affected(root, base, "HEAD", components, ["**/*lock*"]) == ["backend"]
    base = git(root, "rev-parse", "HEAD")
    (root / "uv.lock").write_text("b")
    git(root, "commit", "-am", "change shared root lock")
    assert impact.affected(root, base, "HEAD", components, ["**/*lock*"]) == ["backend", "docs"]


def test_nested_lock_mutation_cannot_pass(repository, tmp_path):
    root = repository(
        {
            "README.md": "# Source\n",
            "admin/bun.lock": "original",
            "backend/Cargo.lock": "original",
            ".github/nddev-ci.toml": DOC_COMMANDS,
        }
    )
    contract = config.load(root)
    contract["commands"]["documentation"]["examples"] = [
        sys.executable,
        "-c",
        "from pathlib import Path; Path('admin/bun.lock').write_text('changed')",
    ]
    result = ci.execute(root, contract, tmp_path / "out")
    assert set(result["identity"]["locks"]) == {"admin/bun.lock", "backend/Cargo.lock"}
    assert result["status"] == "failure"
    assert result["results"][-1]["changed_inputs"] == ["admin/bun.lock"]


def test_failed_native_diagnostics_are_bounded_redacted_and_visible(
    repository, tmp_path, monkeypatch, capsys
):
    root = repository({"README.md": "# Source\n", ".github/nddev-ci.toml": DOC_COMMANDS})
    monkeypatch.setenv("TEST_SECRET_TOKEN", "private-fixture-value")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary.md"))
    contract = config.load(root)
    contract["diagnostics"] = {"tail_lines": 2}
    contract["commands"]["documentation"]["examples"] = [
        sys.executable,
        "-c",
        "print('discarded'); print('assertion failed'); print('private-fixture-value'); raise SystemExit(1)",
    ]
    result = ci.execute(root, contract, tmp_path / "out")
    text = capsys.readouterr().out
    summary = (tmp_path / "summary.md").read_text()
    assert result["status"] == "failure" and "assertion failed" in text and "assertion failed" in summary
    assert "private-fixture-value" not in text + summary and "discarded" not in text
    assert "stop-commands" in text
    exported = tmp_path / "out"
    assert (exported / ".diagnostics-ready").is_file()
    assert "assertion failed" in (exported / "documentation.examples.log").read_text()
    assert all(
        b"private-fixture-value" not in path.read_bytes() for path in exported.rglob("*") if path.is_file()
    )


def test_yaml_merge_override_is_valid_and_malformed_input_is_named(repository):
    root = repository(
        {"compose.yml": "base: &base\n  readonly: true\nweb:\n  <<: *base\n  readonly: false\n"}
    )
    assert documentation.check(root)["files"] == 1
    (root / "compose.yml").write_text("web:\n  port: 1\n  port: 2\n")
    with pytest.raises(Invalid, match="compose.yml"):
        documentation.check(root)
    (root / "compose.yml").write_text("web: [\n")
    with pytest.raises(Invalid, match="compose.yml"):
        documentation.check(root)


def test_bad_yaml_is_a_failed_stage_and_other_checks_still_run(repository, tmp_path):
    root = repository({"compose.yml": "web: [\n", ".github/nddev-ci.toml": DOC_COMMANDS})
    result = ci.execute(root, config.load(root), tmp_path / "out")
    assert result["failed"] == ["documentation.syntax"]
    assert result["results"][-2]["status"] == "success"


def test_output_directories_are_owned_per_invocation(repository, tmp_path):
    root = repository({"README.md": "# Source\n", ".github/nddev-ci.toml": DOC_COMMANDS})
    a = ci.execute(root, config.load(root), tmp_path / "a")
    b = ci.execute(root, config.load(root), tmp_path / "b")
    assert a["status"] == b["status"] == "success"
    with pytest.raises(FileExistsError):
        ci.execute(root, config.load(root), tmp_path / "a")


def test_not_applicable_is_explicit_and_cannot_waive_tests(repository, tmp_path):
    contract = """schema=1
profiles=["python"]
[not_applicable.python]
build="Application is deployed as source; no distribution is published"
consumer="Application has no wheel consumer; its entrypoint is tested directly"
[commands.python]
setup=["git","status","--porcelain"]
toolchain=["python3","--version"]
format=["python3","-m","compileall","-q","app.py"]
lint=["python3","-m","py_compile","app.py"]
type=["python3","-m","py_compile","app.py"]
test=["python3","-m","unittest","-v","test_app.py"]
[reports.python]
kind="unittest"
"""
    root = repository(
        {
            "requirements.txt": "# The fixture uses the caller-provided standard library.\n",
            "app.py": "def parse_port(value):\n    port = int(value)\n    if not 0 < port < 65536: raise ValueError('port')\n    return port\n",
            "test_app.py": "import unittest\nfrom app import parse_port\nclass Ports(unittest.TestCase):\n def test_parse(self): self.assertEqual(parse_port('8080'),8080)\n def test_reject(self):\n  with self.assertRaises(ValueError): parse_port('70000')\n",
            ".github/nddev-ci.toml": contract,
        }
    )
    result = ci.execute(root, config.load(root), tmp_path / "out")
    assert result["status"] == "success"
    assert [r["name"] for r in result["results"] if r["status"] == "not-applicable"] == [
        "python.build",
        "python.consumer",
    ]
    assert next(r for r in result["results"] if r["name"] == "python.test")["tests_executed"] == 2
    (root / ".github/nddev-ci.toml").write_text(contract.replace('build="Application', 'test="Application'))
    with pytest.raises(Invalid, match="cannot be waived"):
        config.load(root)
    assert reports.aggregate(["x"], [{"name": "x", "status": "not-applicable"}])["status"] == "failure"


@pytest.mark.parametrize(
    "manager,lock",
    [("npm", "package-lock.json"), ("bun", "bun.lock"), ("pnpm", "pnpm-lock.yaml"), ("yarn", "yarn.lock")],
)
def test_node_managers_follow_native_locks(repository, manager, lock):
    root = repository({"package.json": json.dumps({"packageManager": manager + "@1.2.3"}), lock: "{}"})
    definition = config.resolve(root, {}, ["typescript-javascript", "web"])
    for name in definition:
        if name not in {"typescript-javascript", "web"}:
            continue
        assert definition[name]["stages"]["setup"][0] == manager
        assert definition[name]["stages"]["test"][0] == manager
        assert definition[name]["locked_inputs"] == [lock]
    (root / "yarn.lock" if manager != "yarn" else root / "bun.lock").write_text("ambiguous")
    with pytest.raises(Invalid, match="unambiguous"):
        config.resolve(root, {}, ["web"])


@pytest.mark.parametrize(
    "name,manifest",
    [
        ("sql-data", "alembic.ini"),
        ("sql-data", "apps/api/migrations/versions/initial.py"),
        ("sql-data", "deploy/prod/sql/initial.sql"),
        ("container", "docker/web.Dockerfile"),
        ("container", "docker/Dockerfile.web"),
        ("container", "Containerfile"),
        ("shell-powershell", "deploy/prod/check.sh"),
    ],
)
def test_native_layouts_do_not_need_placeholder_manifests(repository, name, manifest):
    root = repository({manifest: "# native fixture\n"})
    assert name in config.resolve(root, {}, [name])


def test_cleanup_runs_after_native_failure_and_cannot_hide_it(repository, tmp_path):
    root = repository(
        {"Containerfile": "FROM scratch\n", ".github/nddev-ci.toml": 'schema=1\nprofiles=["container"]\n'}
    )
    contract = config.load(root)
    command = [sys.executable, "-c", "raise SystemExit(2)"]
    contract["commands"] = {
        "container": {stage: command for stage in ["lint", "build", "test", "scan", "sbom"]}
    }
    contract["commands"]["container"]["cleanup"] = [
        sys.executable,
        "-c",
        "from pathlib import Path; Path('cleaned').write_text('this run only')",
    ]
    result = ci.execute(root, contract, tmp_path / "out")
    assert result["status"] == "failure" and (root / "cleaned").read_text() == "this run only"
    assert next(r for r in result["results"] if r["name"] == "container.cleanup")["status"] == "success"


def test_git_config_injection_does_not_reach_native_children(repository, tmp_path, monkeypatch):
    root = repository({"file": "text"})
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "color.ui")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "always")
    result = run(["git", "config", "--get", "color.ui"], root, tmp_path / "config.log")
    assert result["status"] == "success" and Path(result["log"]).read_text().strip() == "false"


def test_shallow_history_and_zero_scanned_commits_fail(repository, tmp_path, monkeypatch):
    root = repository({"app.py": "x=1", ".github/nddev-ci.toml": 'schema=1\nprofiles=["security"]\n'})
    contract = config.load(root)
    defaults = config.catalog()
    defaults["security"]["stages"]["secrets"] = [
        sys.executable,
        "-c",
        "print('0 commits scanned. no leaks found')",
    ]
    monkeypatch.setattr(config, "catalog", lambda: defaults)
    contract["commands"] = {
        "security": {
            s: [sys.executable, "-c", "print('native override')"]
            for s in ["dependencies", "sast", "licenses"]
        }
    }
    result = ci.execute(root, contract, tmp_path / "zero")
    assert result["status"] == "failure" and "security.secrets" in result["failed"]
    clone = tmp_path / "shallow"
    subprocess.run(
        ["git", "clone", "--depth", "1", root.as_uri(), str(clone)], check=True, capture_output=True
    )
    result = ci.execute(clone, config.load(clone) | {"commands": contract["commands"]}, tmp_path / "depth")
    assert "fetch-depth: 0" in result["results"][0]["detail"]


def test_feedback_deduplicates_closed_markers_and_distinguishes_attempts(monkeypatch):
    run_data = {
        "id": 42,
        "run_attempt": 1,
        "repository": {"full_name": "example/project"},
        "path": ".github/workflows/ci.yml",
        "actor": {"login": "owner"},
        "status": "completed",
        "conclusion": "failure",
        "created_at": "2026-10-19T00:00:00Z",
        "event": "push",
        "head_branch": "main",
    }
    issues, writes = [], []

    def get(path):
        if path.endswith("/jobs?per_page=100&page=1"):
            return {"jobs": [{"name": "native security", "conclusion": "failure"}]}
        if "/actions/runs/" in path:
            return run_data
        if path == "repos/example/project":
            return {"default_branch": "main"}
        return issues

    def write(path, body):
        writes.append(body)
        issues.append(
            {
                "number": len(issues) + 1,
                "body": body["body"],
                "state": "closed",
                "user": {"login": "github-actions[bot]"},
            }
        )
        return {"html_url": "https://example.invalid/issue"}

    monkeypatch.setattr(feedback.github, "get", get)
    monkeypatch.setattr(feedback, "write", write)
    args = ("example/project", [".github/workflows/ci.yml"], ["owner"])
    assert feedback.publish(*args, run_id=42)["results"][0]["action"] == "published"
    assert feedback.publish(*args, run_id=42)["results"][0]["action"] == "existing"
    run_data["run_attempt"] = 2
    feedback.publish(*args, run_id=42)
    assert len(writes) == 2
    run_data["actor"] = {"login": "untrusted"}
    assert feedback.publish(*args, run_id=42)["results"] == []


def test_feedback_page_limit_fails_before_publication(monkeypatch):
    monkeypatch.setattr(feedback.github, "get", lambda path: [{}] * 100)
    with pytest.raises(Invalid, match="pagination budget"):
        feedback.pages("repos/example/project/issues", limit=2)


def test_failure_is_published_before_a_later_contract_error(repository, tmp_path, capsys):
    root = repository({"README.md": "# Source\n", ".github/nddev-ci.toml": DOC_COMMANDS})
    contract = config.load(root)
    contract["commands"]["documentation"]["examples"] = [
        sys.executable,
        "-c",
        "raise AssertionError('earlier native failure')",
    ]
    contract["extras"] = {"invalid": {"command": ["git", "status"]}}
    with pytest.raises(Invalid, match="concrete purpose"):
        ci.execute(root, contract, tmp_path / "out")
    assert "earlier native failure" in capsys.readouterr().out


@pytest.mark.parametrize("reason", ["", "   ", 42])
def test_non_applicability_requires_a_real_reason(repository, reason):
    root = repository(
        {
            ".github/nddev-ci.toml": 'schema=1\nprofiles=["python"]\n[not_applicable.python]\nconsumer='
            + json.dumps(reason)
            + "\n"
        }
    )
    with pytest.raises(Invalid, match="nonempty reason"):
        config.load(root)


def test_main_impact_keeps_changes_from_unverified_pushes(repository, monkeypatch):
    from nddev_cicd import github

    root = repository({"runtime/app.py": "a", "docs/guide.md": "a"})
    accepted = git(root, "rev-parse", "HEAD")
    (root / "runtime/app.py").write_text("b")
    git(root, "commit", "-am", "unverified runtime change")
    previous = git(root, "rev-parse", "HEAD")
    (root / "docs/guide.md").write_text("b")
    git(root, "commit", "-am", "new push while prior CI is pending")
    monkeypatch.setenv("GITHUB_REPOSITORY", "example/project")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setattr(
        github,
        "get",
        lambda path: {
            "workflow_runs": [
                {
                    "repository": {"full_name": "example/project"},
                    "path": ".github/workflows/main-ci.yml",
                    "head_sha": accepted,
                    "event": "push",
                    "head_branch": "main",
                    "status": "completed",
                    "conclusion": "success",
                }
            ]
        },
    )
    monkeypatch.setattr(
        ci,
        "source_identity",
        lambda root: {"base": previous, "tested_revision": git(root, "rev-parse", "HEAD")},
    )
    contract = {
        "profiles": ["workflows"],
        "_path": ".github/impact.toml",
        "impact": {
            "baseline_workflow": ".github/workflows/main-ci.yml",
            "components": {
                "runtime": {"paths": ["runtime/**"], "profiles": ["python"]},
                "docs": {"paths": ["docs/**"], "profiles": ["documentation"]},
            },
        },
    }
    _, plan = ci.selection(root, contract)
    assert plan["base"] == accepted and plan["selected_components"] == ["docs", "runtime"]
    assert github.dependency_review_refs(root) == {"base": accepted, "head": git(root, "rev-parse", "HEAD")}
    assert "runtime/app.py" in git(root, "diff", "--name-only", accepted, "HEAD")
    monkeypatch.setattr(github, "get", lambda path: {"workflow_runs": []})
    _, plan = ci.selection(root, contract)
    assert plan["base"] is None and plan["selected_components"] == ["docs", "runtime"]
    with pytest.raises(Invalid, match="accepted main baseline"):
        github.dependency_review_refs(root)


def test_main_artifact_eligibility_rejects_obsolete_revision_and_other_tree(monkeypatch):
    from nddev_cicd import github

    revision, tree = "a" * 40, "b" * 40
    run_data = {
        "repository": {"full_name": "example/project"},
        "head_repository": {"full_name": "example/project"},
        "event": "push",
        "head_branch": "main",
        "status": "completed",
        "conclusion": "success",
        "path": ".github/workflows/main-ci.yml",
        "head_sha": revision,
        "run_attempt": 2,
    }

    def get(path):
        if "/actions/runs/" in path:
            return run_data
        if "/git/ref/" in path:
            return {"object": {"sha": revision}}
        return {"tree": {"sha": tree}}

    monkeypatch.setattr(github, "get", get)
    source = {
        "repository": "example/project",
        "head": revision,
        "run_id": "42",
        "attempt": "2",
        "event": "push",
        "tested_revision": revision,
        "tested_tree": tree,
    }
    assert github.eligible("example/project", 42, revision, run_data["path"], source)["event"] == "push"
    with pytest.raises(Invalid, match="tested source tree"):
        github.eligible("example/project", 42, revision, run_data["path"], source | {"tested_tree": "c" * 40})
    original = get
    monkeypatch.setattr(
        github, "get", lambda path: {"object": {"sha": "c" * 40}} if "/git/ref/" in path else original(path)
    )
    with pytest.raises(Invalid, match="superseded"):
        github.eligible("example/project", 42, revision, run_data["path"], source)


def test_completed_main_event_binds_delivery_to_the_source_revision(tmp_path, monkeypatch):
    from nddev_cicd import github

    revision = "a" * 40
    payload = {
        "workflow_run": {
            "id": 42,
            "path": ".github/workflows/main-ci.yml",
            "event": "push",
            "head_branch": "main",
            "status": "completed",
            "conclusion": "success",
            "head_sha": revision,
        }
    }
    event_file = tmp_path / "event.json"
    event_file.write_text(json.dumps(payload))
    for key, value in {
        "GITHUB_EVENT_NAME": "workflow_run",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": "b" * 40,
        "GITHUB_EVENT_PATH": str(event_file),
    }.items():
        monkeypatch.setenv(key, value)
    assert github.authorized_revision(42, ".github/workflows/main-ci.yml") == revision
    with pytest.raises(Invalid, match="selected successful"):
        github.authorized_revision(43, ".github/workflows/main-ci.yml")
    payload["workflow_run"]["event"] = "pull_request"
    event_file.write_text(json.dumps(payload))
    with pytest.raises(Invalid, match="selected successful"):
        github.authorized_revision(42, ".github/workflows/main-ci.yml")


def test_main_fixture_scope_is_the_native_driver_inventory():
    import runpy
    import tomllib

    root = Path(__file__).resolve().parent.parent
    native = runpy.run_path(str(root / "tests/run_native.py"))["SOURCES"]
    scope = tomllib.loads((root / ".github/impact.toml").read_text())["impact"]["components"]
    assert {name.removeprefix("fixture-") for name in scope if name.startswith("fixture-")} == set(native)


def test_main_job_scope_keeps_native_platforms_and_dependents():
    import runpy
    import tomllib

    root = Path(__file__).resolve().parent.parent
    module = runpy.run_path(str(root / "scripts/plan-main-jobs.py"))
    scope = tomllib.loads((root / ".github/impact.toml").read_text())["impact"]["components"]
    apple = module["plan"](["fixture-swift"], scope)
    assert apple["apple"] and not apple["windows"] and not apple["native"]
    python = module["plan"](["fixture-python"], scope)
    assert python["windows"] and python["native"] and not python["apple"]
    all_jobs = module["plan"](list(scope), scope)
    assert all_jobs["advanced"] and "swift" not in all_jobs["matrix"]["profile"]
    for name in ("quality", "benchmark", "assessment", "clusterfuzz"):
        assert all_jobs[name]
        selected = module["plan"](["native-" + name], scope)
        assert selected[name] and not selected["native"] and not selected["runtime"]
    for name, component in scope.items():
        if name.startswith("fixture-"):
            assert "runtime" in component["depends_on"]
            manifest = root / "tests/native" / name.removeprefix("fixture-") / ".github/nddev-ci.toml"
            assert component["profiles"] == tomllib.loads(manifest.read_text())["profiles"]
