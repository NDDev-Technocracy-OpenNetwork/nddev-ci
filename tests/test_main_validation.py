"""Native dispatch reconciles absence; a failed, queued or superseded run is never replayed."""

import json
from datetime import UTC, datetime

import pytest

from nddev_cicd import github

REPOSITORY, WORKFLOW, REVISION = "example/project", ".github/workflows/ci.yml", "a" * 40


@pytest.fixture
def native(monkeypatch):
    state = {"heads": [REVISION], "runs": [], "history_reads": 0, "sent": [], "workflow_state": "active"}

    def get(path):
        if path.endswith("/git/ref/heads/main"):
            return {
                "object": {"sha": state["heads"].pop(0) if len(state["heads"]) > 1 else state["heads"][0]}
            }
        if "/git/commits/" in path:
            return {"committer": {"date": datetime.now(UTC).isoformat()}}
        if "/runs?" in path:
            state["history_reads"] += 1
            return {"workflow_runs": state["runs"]}
        if path.endswith("/actions/workflows/ci.yml"):
            return {"path": WORKFLOW, "state": state["workflow_state"]}
        raise AssertionError(path)

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def read(self, _):
            return b""

    def send(request, **_):
        state["sent"].append((request.get_method(), request.full_url, json.loads(request.data)))
        return Response()

    monkeypatch.setattr(github, "get", get)
    monkeypatch.setattr(github.urllib.request, "urlopen", send)
    monkeypatch.setenv("GH_TOKEN", "synthetic-read-or-dispatch-token")
    return state


def test_missing_main_is_read_only_until_dispatch_is_explicit(native):
    assert github.ensure_main(REPOSITORY, WORKFLOW)["status"] == "missing"
    assert native["sent"] == []
    result = github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)
    assert result["status"] == "dispatched" and result["head"] == REVISION
    assert native["sent"] == [
        (
            "POST",
            f"https://api.github.com/repos/{REPOSITORY}/actions/workflows/ci.yml/dispatches",
            {"ref": "main"},
        )
    ]


@pytest.mark.parametrize(
    "status,conclusion",
    [
        ("queued", None),
        ("in_progress", None),
        ("completed", "failure"),
        ("completed", "cancelled"),
        ("completed", "success"),
    ],
)
def test_existing_run_is_never_automatically_retried(native, status, conclusion):
    native["runs"] = [
        {
            "id": 7,
            "repository": {"full_name": REPOSITORY},
            "head_repository": {"full_name": REPOSITORY},
            "head_branch": "main",
            "head_sha": REVISION,
            "path": WORKFLOW,
            "event": "workflow_dispatch",
            "status": status,
            "conclusion": conclusion,
            "run_attempt": 2,
        }
    ]
    result = github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)
    assert result["run_id"] == 7 and result["conclusion"] == conclusion
    assert (result["status"] == "validated") == (conclusion == "success")
    assert native["sent"] == []


def test_latest_native_run_wins_over_an_older_success(native):
    base = {
        "repository": {"full_name": REPOSITORY},
        "head_repository": {"full_name": REPOSITORY},
        "head_branch": "main",
        "head_sha": REVISION,
        "path": WORKFLOW,
        "event": "push",
        "run_attempt": 1,
        "status": "completed",
    }
    native["runs"] = [base | {"id": 7, "conclusion": "success"}, base | {"id": 8, "conclusion": "failure"}]
    result = github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)
    assert result["status"] == "existing" and result["run_id"] == 8
    assert not native["sent"]


def test_recent_commit_allows_the_ordinary_push_trigger_to_appear(native):
    assert github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True)["status"] == "awaiting-native-trigger"
    assert not native["sent"]


def test_main_changed_before_dispatch_is_not_dispatched(native):
    native["heads"] = [REVISION, "b" * 40]
    assert github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)["status"] == "superseded"
    assert not native["sent"]


def test_main_change_during_dispatch_never_certifies_either_head(native):
    native["heads"] = [REVISION, REVISION, "b" * 40]
    result = github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)
    assert result["status"] == "main-advanced-during-dispatch" and result["current_head"] == "b" * 40
    assert len(native["sent"]) == 1


def test_disabled_workflow_is_reported_without_enabling_or_dispatching(native):
    native["workflow_state"] = "disabled_manually"
    assert (
        github.ensure_main(REPOSITORY, WORKFLOW, dispatch=True, grace_seconds=0)["status"]
        == "workflow-unavailable"
    )
    assert not native["sent"]
