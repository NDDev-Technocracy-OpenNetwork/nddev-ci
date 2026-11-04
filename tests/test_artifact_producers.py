"""A retained source is the same native execution, not an arbitrary older successful artifact."""

import copy
import hashlib
import io
import json
import zipfile

import pytest

from nddev_cicd import github
from nddev_cicd.model import Invalid

REPOSITORY, REVISION = "example/project", "a" * 40


@pytest.fixture
def producer(monkeypatch):
    run = {
        "run_attempt": 2,
        "repository": {"full_name": REPOSITORY},
        "head_repository": {"full_name": REPOSITORY},
        "head_sha": REVISION,
        "status": "in_progress",
    }
    source = {
        "repository": REPOSITORY,
        "run_id": "7",
        "attempt": "1",
        "check_run_id": "11",
        "tested_revision": REVISION,
    }
    built = {
        "id": 11,
        "check_run_url": f"https://api.github.com/repos/{REPOSITORY}/check-runs/11",
        "run_id": 7,
        "run_attempt": 1,
        "name": "native source",
        "head_sha": REVISION,
        "status": "completed",
        "conclusion": "success",
        "runner_id": 8,
        "runner_name": "jit-one-job",
        "started_at": "2026-01-01T01:00:00Z",
        "completed_at": "2026-01-01T01:01:00Z",
        "steps": [{"name": "native checks", "conclusion": "success", "number": 1}],
    }
    clone = copy.deepcopy(built) | {
        "id": 22,
        "run_attempt": 2,
        "check_run_url": f"https://api.github.com/repos/{REPOSITORY}/check-runs/22",
    }
    original, latest = [built], [clone]

    def get(path):
        if "/attempts/1/jobs?" in path:
            return {"jobs": original}
        if "/jobs?filter=latest" in path:
            return {"jobs": latest}
        if path == f"repos/{REPOSITORY}/actions/runs/7":
            return run
        raise AssertionError(path)

    monkeypatch.setattr(github, "get", get)
    return run, source, original, latest


def test_native_rerun_clone_retains_execution_with_new_job_check_and_attempt(producer):
    _, source, _, _ = producer
    proof = github.producer(REPOSITORY, 7, REVISION, source)
    assert proof == {
        "producer_attempt": "1",
        "validation_attempt": "2",
        "check_run_id": "11",
        "latest_job_id": "22",
    }
    # An in-progress caller may check provenance; this alone never admits delivery.


@pytest.mark.parametrize(
    "field,value",
    [
        ("started_at", "2026-01-01T02:00:00Z"),
        ("completed_at", "2026-01-01T02:01:00Z"),
        ("runner_id", 99),
        ("runner_name", "a-new-runner"),
        ("name", "another source"),
        ("steps", [{"name": "different execution"}]),
        ("status", "in_progress"),
        ("conclusion", "failure"),
        ("head_sha", "b" * 40),
        ("run_attempt", 1),
    ],
)
def test_rerun_or_changed_execution_cannot_reuse_an_old_payload(producer, field, value):
    _, source, _, latest = producer
    latest[0][field] = value
    with pytest.raises(Invalid, match="replaced|absent"):
        github.producer(REPOSITORY, 7, REVISION, source)


def test_failed_original_and_ambiguous_latest_execution_are_refused(producer):
    _, source, original, latest = producer
    original[0]["conclusion"] = "failure"
    with pytest.raises(Invalid, match="not successful"):
        github.producer(REPOSITORY, 7, REVISION, source)
    original[0]["conclusion"] = "success"
    latest.append(copy.deepcopy(latest[0]))
    with pytest.raises(Invalid, match="replaced|absent"):
        github.producer(REPOSITORY, 7, REVISION, source)


@pytest.mark.parametrize(
    "field,value",
    [
        ("check_run_id", "22"),
        ("check_run_id", "unknown"),
        ("attempt", "3"),
        ("repository", "foreign/project"),
        ("tested_revision", "b" * 40),
    ],
)
def test_producer_identity_cannot_move_between_attempts_or_repositories(producer, field, value):
    _, source, _, _ = producer
    with pytest.raises(Invalid):
        github.producer(REPOSITORY, 7, REVISION, source | {field: value})


@pytest.mark.parametrize(
    "field,value,predicate",
    [
        ("status", "in_progress", "status_completed"),
        ("conclusion", "failure", "conclusion_success"),
        ("run_attempt", 2, "attempt_matches"),
        ("run_id", 8, "run_matches"),
        ("head_sha", "b" * 40, "revision_matches"),
        ("started_at", None, "started_at_present"),
        ("completed_at", None, "completed_at_present"),
        ("runner_name", "", "runner_name_present"),
        ("runner_id", "8", "runner_id_integer"),
        ("steps", {}, "steps_nonempty_list"),
        ("steps", [], "steps_nonempty_list"),
    ],
)
def test_rejection_identifies_the_observed_incomplete_field_without_more_reads(
    producer, monkeypatch, field, value, predicate
):
    _, source, original, _ = producer
    original[0][field] = value
    get = github.get
    calls = []

    def observed(path):
        calls.append(path)
        return get(path)

    monkeypatch.setattr(github, "get", observed)
    with pytest.raises(Invalid) as error:
        github.producer(REPOSITORY, 7, REVISION, source)
    evidence = json.loads(str(error.value).split("; producer_observation=", 1)[1])
    assert evidence["phase"] == "original-completion"
    assert evidence["run_id"] == 7 and evidence["check_run_id"] == 11
    assert evidence["revision"] == REVISION and evidence["job_id"] == 11
    assert [key for key, passed in evidence["predicates"].items() if not passed] == [predicate]
    assert calls == [
        "repos/example/project/actions/runs/7",
        "repos/example/project/actions/runs/7/attempts/1/jobs?per_page=100&page=1",
    ]


def test_latest_failure_bounds_observation_and_does_not_export_hostile_api_text(producer, monkeypatch):
    _, source, original, latest = producer
    sentinel = 'synthetic-known-secret-<"\n' + "x" * 20_000
    monkeypatch.setenv("FIXTURE_SECRET", sentinel)
    for field in ("name", "runner_name", "started_at", "completed_at"):
        original[0][field] = sentinel
    original[0]["steps"] = [{"name": sentinel}]
    latest[:] = [
        copy.deepcopy(original[0])
        | {"id": number, "run_attempt": 2, "steps": [{"name": sentinel, "conclusion": sentinel}]}
        for number in range(20, 83)
    ]
    before = copy.deepcopy((original, latest))
    with pytest.raises(Invalid) as error:
        github.producer(REPOSITORY, 7, REVISION, source)
    message = str(error.value)
    assert "synthetic-known-secret" not in message and len(message) < 3000
    evidence = json.loads(message.split("; producer_observation=", 1)[1])
    assert evidence["phase"] == "latest-execution" and evidence["matches"] == 0
    assert evidence["predicates"] == {"unique_execution": False}
    assert evidence["records"] == 63 and evidence["comparisons_truncated"] is True
    assert [row["job_id"] for row in evidence["execution_comparisons"]] == [20, 21, 22, 23]
    assert all(not row["same_execution"]["steps"] for row in evidence["execution_comparisons"])
    assert (original, latest) == before


def test_successful_retained_proof_keeps_its_reads_and_result_without_diagnostics(producer, monkeypatch):
    _, source, _, _ = producer
    get = github.get
    calls = []

    def observed(path):
        calls.append(path)
        return get(path)

    monkeypatch.setattr(github, "get", observed)
    result = github.producer(REPOSITORY, 7, REVISION, source)
    assert result == {
        "producer_attempt": "1",
        "validation_attempt": "2",
        "check_run_id": "11",
        "latest_job_id": "22",
    }
    assert calls == [
        "repos/example/project/actions/runs/7",
        "repos/example/project/actions/runs/7/attempts/1/jobs?per_page=100&page=1",
        "repos/example/project/actions/runs/7/jobs?filter=latest&per_page=100&page=1",
    ]


@pytest.mark.parametrize("count", [0, 2])
def test_original_selection_observation_keeps_missing_and_ambiguous_producers_rejected(producer, count):
    _, source, original, _ = producer
    original[:] = [copy.deepcopy(original[0]) for _ in range(count)]
    with pytest.raises(Invalid) as error:
        github.producer(REPOSITORY, 7, REVISION, source)
    evidence = json.loads(str(error.value).split("; producer_observation=", 1)[1])
    assert evidence["phase"] == "original-selection"
    assert evidence["records"] == evidence["matches"] == count


def test_latest_invalid_identity_is_not_exported_as_a_native_job_id(producer):
    _, source, _, latest = producer
    latest[0]["id"] = "synthetic-secret-arbitrary-api-text"
    with pytest.raises(Invalid) as error:
        github.producer(REPOSITORY, 7, REVISION, source)
    assert "synthetic-secret" not in str(error.value)
    evidence = json.loads(str(error.value).split("; producer_observation=", 1)[1])
    assert evidence["selected_job_id"] is None
    assert evidence["predicates"]["unique_execution"] is True
    assert evidence["predicates"]["job_id_positive_integer"] is False


def test_bundle_downloads_one_digest_bound_candidate_and_requires_retained_proof(tmp_path, monkeypatch):
    source = {
        "attempt": "1",
        "check_run_id": "11",
        "library_repository": "example/library",
        "library_ref": "c" * 40,
    }
    result = {
        "status": "success",
        "expected": ["native"],
        "results": [{"name": "native", "status": "success"}],
        "identity": source,
    }
    manifest = {"source": source}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("result.json", json.dumps(result))
        archive.writestr("artifact.tar.gz", b"native payload")
        archive.writestr("artifact.tar.gz.json", json.dumps(manifest))
    blob = buffer.getvalue()
    selected = {
        "id": 17,
        "name": "nddev-source-7-1-primary",
        "expired": False,
        "digest": "sha256:" + hashlib.sha256(blob).hexdigest(),
    }
    monkeypatch.setattr(github, "get", lambda _: {"artifacts": [selected]})
    calls = []

    def admitted(_repo, _run, _revision, _workflow, observed=None):
        calls.append(observed)
        if observed is not None:
            assert observed == source
        return {"attempt": "2"}

    monkeypatch.setattr(github, "eligible", admitted)
    monkeypatch.setattr(
        github, "download", lambda _repo, ident, output: output.write_bytes(blob) if ident == 17 else None
    )
    monkeypatch.setenv("NDDEV_LIBRARY_REPOSITORY", source["library_repository"])
    monkeypatch.setenv("NDDEV_LIBRARY_REF", source["library_ref"])
    archive, _, observed = github.bundle(
        REPOSITORY, 7, REVISION, ".github/workflows/ci.yml", tmp_path / "bound"
    )
    assert archive.read_bytes() == b"native payload" and observed == source
    assert calls == [None, source]
    selected["digest"] = "sha256:" + "0" * 64
    with pytest.raises(Invalid, match="archive digest"):
        github.bundle(REPOSITORY, 7, REVISION, ".github/workflows/ci.yml", tmp_path / "corrupt")
