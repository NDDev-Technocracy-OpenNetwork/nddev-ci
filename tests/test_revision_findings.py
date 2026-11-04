"""Regressions for component selection, author trust, feedback and native PR eligibility."""

import copy
import json
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

import pytest

from nddev_cicd import ci, feedback, github, routing, security
from nddev_cicd.model import Invalid, Unavailable, git


@pytest.mark.parametrize(
    "path,expected",
    [
        ("admin/blocked-users-page.tsx", ["admin", "frontend"]),
        ("admin/pin_lock_guard.dart", ["admin", "frontend"]),
        ("admin/deblock.rs", ["admin", "frontend"]),
        ("admin/block_unit.rs", ["admin", "frontend"]),
        ("admin/bun.lock", ["admin", "frontend"]),
        ("backend/uv.lock", ["backend"]),
        ("mobile/pubspec.lock", ["mobile"]),
        ("services/Cargo.lock", ["services"]),
        ("uv.lock", ["admin", "backend", "frontend", "mobile", "services"]),
        ("unknown/bun.lock", ["admin", "backend", "frontend", "mobile", "services"]),
    ],
)
@pytest.mark.parametrize("operation", ["modify", "delete", "rename"])
def test_implicit_locks_preserve_component_ownership(repository, path, expected, operation):
    root = repository({path: "before", "frontend/app.py": "value = 1"})
    base = git(root, "rev-parse", "HEAD")
    if operation == "modify":
        (root / path).write_text("after")
    elif operation == "delete":
        (root / path).unlink()
    else:
        # Renaming to an unknown scope must retain every obligation.
        git(root, "mv", path, "renamed.py")
        expected = ["admin", "backend", "frontend", "mobile", "services"]
    git(root, "add", "-A")
    git(root, "commit", "-qm", "candidate")
    components = {
        name: {"paths": [name + "/**"], "profiles": ["python"]}
        for name in ["admin", "backend", "frontend", "mobile", "services"]
    }
    components["frontend"]["depends_on"] = ["admin"]
    contract = {"profiles": [], "_path": ".github/nddev-ci.toml", "impact": {"components": components}}
    _, result = ci.selection(root, contract, base=base, head="HEAD")
    assert result["selected_components"] == expected


def test_pr_author_allowlist_is_independent_of_rerunner_and_refuses_forks(tmp_path, monkeypatch):
    event = tmp_path / "event.json"
    data = {
        "repository": {"full_name": "example/private", "visibility": "private"},
        "pull_request": {
            "user": {"login": "dependabot[bot]"},
            "author_association": "NONE",
            "head": {"repo": {"full_name": "example/private"}},
        },
    }
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_REPOSITORY", "example/private")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_ACTOR", "owner")
    monkeypatch.setenv("GITHUB_TRIGGERING_ACTOR", "owner")
    policy = {
        "visibility": "private",
        "platform": "linux",
        "trusted": True,
        "trusted_actors": ["owner", "dependabot[bot]"],
        "private_labels": ["self-hosted", "Linux", "X64", "existing"],
    }
    event.write_text(json.dumps(data))
    assert routing.select(**routing.caller_policy(policy))["availability"] == "not-checked"
    for change in ["untrusted-author", "fork"]:
        altered = copy.deepcopy(data)
        if change == "untrusted-author":
            altered["pull_request"]["user"]["login"] = "outside"
        else:
            altered["pull_request"]["head"]["repo"]["full_name"] = "outside/fork"
        event.write_text(json.dumps(altered))
        with pytest.raises(Unavailable):
            routing.select(**routing.caller_policy(policy))


def test_feedback_reconciliation_exhausts_filtered_pages_and_names_failed_jobs(monkeypatch):
    created = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    base = {
        "id": 42,
        "run_attempt": 1,
        "repository": {"full_name": "example/project"},
        "path": ".github/workflows/ci.yml",
        "actor": {"login": "owner"},
        "status": "completed",
        "conclusion": "stale",
        "event": "push",
        "head_branch": "main",
        "created_at": created,
    }
    queries, writes = [], []

    def get(path):
        if path == "repos/example/project":
            return {"default_branch": "main"}
        if "/workflows/" in path:
            query = parse_qs(urlparse(path).query)
            queries.append(query)
            assert query["event"] == ["push"] and query["branch"] == ["main"]
            assert query["created"][0].startswith(">=")
            # A full page of mixed PR metadata cannot hide the selected main failure on page two.
            batch = [dict(base, id=100 + n, event="pull_request") for n in range(100)]
            return {"workflow_runs": batch if query["page"] == ["1"] else [base]}
        if "/jobs?" in path:
            return {"jobs": [{"name": "private SAST", "conclusion": "stale"}]}
        return []

    monkeypatch.setattr(feedback.github, "get", get)
    monkeypatch.setattr(
        feedback, "write", lambda path, payload: writes.append(payload) or {"html_url": "issue"}
    )
    args = ("example/project", [base["path"]], ["owner"])
    result = feedback.publish(*args, events=["push"])
    assert len(queries) == 2 and len(result["results"]) == 1
    assert "private SAST (stale)" in writes[0]["body"]
    writes.clear()
    with pytest.raises(Invalid, match="pagination budget"):
        feedback.publish(*args, events=["push"], page_budget=1)
    assert not writes


@pytest.mark.parametrize(
    "defect", [None, "pending", "cancelled", "superseded", "missing", "attempt", "base", "main"]
)
def test_pr_gate_binds_latest_native_attempt_and_current_target(monkeypatch, defect):
    head, base = "a" * 40, "b" * 40
    pull = {
        "state": "open",
        "draft": False,
        "head": {"sha": head, "repo": {"full_name": "example/project"}},
        "base": {"sha": base, "ref": "dev", "repo": {"full_name": "example/project"}},
    }
    run = {
        "id": 42,
        "run_attempt": 2,
        "repository": {"full_name": "example/project"},
        "head_repository": {"full_name": "example/project"},
        "path": ".github/workflows/ci.yml",
        "head_sha": head,
        "event": "pull_request",
        "status": "completed",
        "conclusion": "success",
        "pull_requests": [{"number": 7, "head": {"sha": head}, "base": {"sha": base, "ref": "dev"}}],
    }
    jobs = [{"name": "gate", "status": "completed", "conclusion": "success"}]
    if defect in {"pending", "cancelled"}:
        run.update(status="in_progress" if defect == "pending" else "completed", conclusion=defect)
    if defect == "main":
        run["event"] = "push"
    if defect == "base":
        run["pull_requests"][0]["base"]["sha"] = "c" * 40
    calls = 0

    def get(path):
        nonlocal calls
        if "/pulls/" in path:
            return pull
        if "/jobs?" in path:
            return {"jobs": [] if defect == "missing" else jobs}
        if "/workflows/" in path:
            return {"workflow_runs": [run, dict(run, id=43)] if defect == "superseded" else [run]}
        calls += 1
        return dict(run, run_attempt=3) if defect == "attempt" and calls > 1 else run

    monkeypatch.setattr(github, "get", get)
    args = ("example/project", 42, head, run["path"], 7, "dev")
    if defect:
        with pytest.raises(Invalid):
            github.pr_eligible(*args)
    else:
        assert github.pr_eligible(*args)["attempt"] == "2"


def test_free_security_defaults_require_real_scopes_and_license_policy(repository):
    root = repository({"src/app.py": "value = 1"})
    contract = {"security": {"python": ["src/**/*.py"], "licenses": ["MIT"]}}
    assert security.native_command("security-sast", root, contract) == [
        "bandit",
        "--quiet",
        "--",
        "src/app.py",
    ]
    assert "--licenses=MIT" in security.native_command("security-licenses", root, contract)
    with pytest.raises(Invalid, match="allowlist"):
        security.native_command("security-licenses", root, {})
    contract["security"]["python"] = ["missing/**/*.py"]
    with pytest.raises(Invalid, match="no tracked source"):
        security.native_command("security-sast", root, contract)
