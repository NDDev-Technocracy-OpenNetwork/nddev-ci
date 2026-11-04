"""Bind native successful source runs, API-downloaded artifacts and integrated source trees."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .model import Invalid
from .reports import aggregate


def request(path: str) -> urllib.request.Request:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise Invalid("A read-scoped caller token is required for native run provenance")
    return urllib.request.Request(
        "https://api.github.com/" + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "nddev-cicd",
        },
    )


def get(path: str):
    with urllib.request.urlopen(request(path), timeout=30) as response:
        return json.load(response)


def records(path: str, key: str, limit: int = 5) -> list[dict]:
    """Exhaust a bounded native Actions collection or fail without claiming complete coverage."""
    result = []
    for page in range(1, limit + 1):
        response = get(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        batch = response.get(key) if isinstance(response, dict) else None
        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
            raise Invalid("Unexpected native Actions collection")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise Invalid("Native Actions pagination budget exhausted")


def ensure_main(repository: str, workflow: str, *, dispatch: bool = False, grace_seconds: int = 90) -> dict:
    """Observe current main validation; explicit dispatch never certifies or retries a failed run."""
    from datetime import UTC, datetime
    from urllib.parse import urlencode

    if (
        not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
        or not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", workflow)
        or type(grace_seconds) is not int
        or not 0 <= grace_seconds <= 3600
    ):
        raise Invalid("Main reconciliation requires an exact repository/workflow and bounded grace")
    prefix = f"repos/{repository}"
    head_path = f"{prefix}/git/ref/heads/main"
    head = get(head_path).get("object", {}).get("sha")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise Invalid("Current native main identity is unavailable")
    endpoint = f"{prefix}/actions/workflows/{workflow.rsplit('/', 1)[1]}"
    descriptor = get(endpoint)
    result = {"repository": repository, "workflow": workflow, "head": head}
    if descriptor.get("path") != workflow or descriptor.get("state") != "active":
        return {**result, "status": "workflow-unavailable"}

    def observed():
        query = urlencode({"branch": "main", "head_sha": head})
        runs = records(endpoint + "/runs?" + query, "workflow_runs")
        selected = [
            item
            for item in runs
            if (
                item.get("repository", {}).get("full_name") == repository
                and item.get("head_repository", {}).get("full_name") == repository
                and item.get("head_sha") == head
                and item.get("head_branch") == "main"
                and item.get("path") == workflow
                and item.get("event") in {"push", "workflow_dispatch"}
            )
        ]
        if not selected:
            return None
        if any(type(item.get("id")) is not int or item["id"] < 1 for item in selected):
            raise Invalid("Native main validation history has no exact run identity")
        latest = max(selected, key=lambda item: item["id"])
        status = (
            "validated"
            if latest.get("status") == "completed" and latest.get("conclusion") == "success"
            else "existing"
        )
        return {
            **result,
            "status": status,
            "run_id": latest["id"],
            "run_status": latest.get("status"),
            "conclusion": latest.get("conclusion"),
            "attempt": latest.get("run_attempt"),
            "event": latest["event"],
        }

    prior = observed()
    if prior is not None:
        return prior
    if not dispatch:
        return {**result, "status": "missing"}
    if grace_seconds:
        commit = get(f"{prefix}/git/commits/{head}")
        date = commit.get("committer", {}).get("date")
        if not isinstance(date, str):
            raise Invalid("Main commit time is unavailable; dispatch grace cannot be established")
        committed_at = datetime.fromisoformat(date)
        if committed_at.tzinfo is None:
            raise Invalid("Main commit time must have its native timezone")
        age = (datetime.now(UTC) - committed_at).total_seconds()
        if age < grace_seconds:
            return {**result, "status": "awaiting-native-trigger"}
    if get(head_path).get("object", {}).get("sha") != head:
        return {**result, "status": "superseded"}
    prior = observed()
    if prior is not None:
        return prior
    native = request(endpoint + "/dispatches")
    native.method = "POST"
    native.data = json.dumps({"ref": "main"}).encode()
    native.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(native, timeout=30) as response:
        response.read(65536)
    current = get(head_path).get("object", {}).get("sha")
    return {
        **result,
        "status": "dispatched" if current == head else "main-advanced-during-dispatch",
        "current_head": current,
    }


def pr_eligible(
    repository: str,
    run_id: int,
    revision: str,
    workflow: str,
    pull_number: int,
    target: str,
    aggregate_job: str = "gate",
) -> dict:
    """Read the existing short workflow aggregate; no second inventory of its checks."""
    import urllib.parse

    if (
        not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
        or not re.fullmatch(r"[0-9a-f]{40}", revision)
        or not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", workflow)
        or run_id < 1
        or pull_number < 1
        or not target
        or not aggregate_job
    ):
        raise Invalid("PR admission requires exact repository, workflow, head, target and aggregate")
    prefix = f"repos/{repository}"
    pull = get(f"{prefix}/pulls/{pull_number}")
    if (
        pull.get("state") != "open"
        or pull.get("draft") is not False
        or pull.get("head", {}).get("sha") != revision
        or pull.get("base", {}).get("ref") != target
        or pull.get("base", {}).get("repo", {}).get("full_name") != repository
    ):
        raise Invalid("PR is not the current ready candidate for the intended target")
    base = pull["base"]["sha"]
    run = get(f"{prefix}/actions/runs/{run_id}")

    def candidate(item):
        return (
            item.get("repository", {}).get("full_name") == repository
            and item.get("head_repository", {}).get("full_name") == pull["head"]["repo"]["full_name"]
            and item.get("path") == workflow
            and item.get("event") == "pull_request"
            and item.get("head_sha") == revision
            and any(
                p.get("number") == pull_number
                and p.get("head", {}).get("sha") == revision
                and p.get("base", {}).get("sha") == base
                and p.get("base", {}).get("ref") == target
                for p in item.get("pull_requests", [])
            )
        )

    if not candidate(run) or run.get("status") != "completed" or run.get("conclusion") != "success":
        raise Invalid("Short PR workflow has no complete successful result for the current head/base")
    query = urllib.parse.urlencode({"event": "pull_request", "head_sha": revision})
    history = records(
        f"{prefix}/actions/workflows/{workflow.rsplit('/', 1)[1]}/runs?{query}", "workflow_runs"
    )
    matching = [item for item in history if candidate(item)]
    if not matching or max(item["id"] for item in matching) != run_id:
        raise Invalid("Short PR workflow run was superseded or cannot be established")
    attempt = run.get("run_attempt")
    if type(attempt) is not int or attempt < 1:
        raise Invalid("Native PR run attempt is absent")
    jobs = records(f"{prefix}/actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs")
    selected = [job for job in jobs if job.get("name") == aggregate_job]
    if (
        len(selected) != 1
        or selected[0].get("status") != "completed"
        or selected[0].get("conclusion") != "success"
    ):
        raise Invalid("The expected short PR aggregate is missing, incomplete or not successful")
    # Reconcile mutable candidate and attempt after reading the aggregate. This is not an atomic base lock.
    current_pull = get(f"{prefix}/pulls/{pull_number}")
    current_run = get(f"{prefix}/actions/runs/{run_id}")
    if (
        current_pull.get("state") != "open"
        or current_pull.get("head", {}).get("sha") != revision
        or current_pull.get("base", {}).get("sha") != base
        or current_pull.get("base", {}).get("ref") != target
        or current_run.get("run_attempt") != attempt
        or current_run.get("status") != "completed"
        or current_run.get("conclusion") != "success"
    ):
        raise Invalid("PR candidate or its latest run attempt changed during admission")
    return {
        "phase": "pr",
        "repository": repository,
        "workflow": workflow,
        "run_id": str(run_id),
        "attempt": str(attempt),
        "pull_request": pull_number,
        "head": revision,
        "base": base,
        "target": target,
        "aggregate": aggregate_job,
    }


def producer(repository: str, run_id: int, revision: str, source: dict, *, run: dict | None = None) -> dict:
    """Prove a source execution is successful in the latest native graph; this is not delivery admission."""
    if (
        type(run_id) is not int
        or run_id < 1
        or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
        or not re.fullmatch(r"[0-9a-f]{40}", revision)
    ):
        raise Invalid("Native producer proof requires an exact repository and revision")
    run = get(f"repos/{repository}/actions/runs/{run_id}") if run is None else run
    if not isinstance(run, dict):
        raise Invalid("Native source run metadata is unavailable")
    latest = run.get("run_attempt")
    attempt, check = source.get("attempt"), source.get("check_run_id")
    if (
        type(latest) is not int
        or latest < 1
        or not isinstance(attempt, str)
        or not re.fullmatch(r"[1-9][0-9]{0,8}", attempt)
        or int(attempt) > latest
        or not isinstance(check, str)
        or not re.fullmatch(r"[1-9][0-9]{0,19}", check)
        or source.get("repository") != repository
        or source.get("run_id") != str(run_id)
        or source.get("tested_revision") != revision
        or run.get("repository", {}).get("full_name") != repository
        or run.get("head_repository", {}).get("full_name") != repository
        or run.get("head_sha") != revision
    ):
        raise Invalid("Source producer identity differs from its native run")

    def bounded_number(value):
        return value if type(value) is int and 0 < value < 10**20 else None

    def rejected(message: str, phase: str, observation: dict) -> Invalid:
        # Only caller-validated identities and fixed predicate names reach this
        # failure message. Never export API names, steps, URLs or arbitrary text.
        evidence = {
            "phase": phase,
            "run_id": bounded_number(run_id),
            "revision": revision,
            "producer_attempt": int(attempt),
            "check_run_id": int(check),
            "latest_attempt": bounded_number(latest),
            **observation,
        }
        return Invalid(message + "; producer_observation=" + json.dumps(evidence, sort_keys=True))

    prefix = f"repos/{repository}/actions/runs/{run_id}"
    original = records(f"{prefix}/attempts/{attempt}/jobs", "jobs")
    check_url = f"https://api.github.com/repos/{repository}/check-runs/{check}"
    matches = [item for item in original if item.get("check_run_url") == check_url]
    if len(matches) != 1:
        raise rejected(
            "No unique source producer in its original native attempt",
            "original-selection",
            {"records": len(original), "matches": len(matches)},
        )
    built = matches[0]
    predicates = {
        "status_completed": built.get("status") == "completed",
        "conclusion_success": built.get("conclusion") == "success",
        "attempt_matches": built.get("run_attempt") == int(attempt),
        "run_matches": built.get("run_id") == run_id,
        "revision_matches": built.get("head_sha") == revision,
        "started_at_present": bool(built.get("started_at")),
        "completed_at_present": bool(built.get("completed_at")),
        "runner_name_present": bool(built.get("runner_name")),
        "runner_id_integer": type(built.get("runner_id")) is int,
        "steps_nonempty_list": isinstance(built.get("steps"), list) and bool(built["steps"]),
    }
    if not all(predicates.values()):
        raise rejected(
            "Native source producer is incomplete or not successful",
            "original-completion",
            {"job_id": bounded_number(built.get("id")), "predicates": predicates},
        )
    current = records(f"{prefix}/jobs?filter=latest", "jobs")
    # Failed-only reruns clone retained successful jobs with new check IDs and
    # attempt/creation metadata. Their actual execution metadata is unchanged.
    fields = ("name", "runner_id", "runner_name", "started_at", "completed_at", "steps")
    retained = [item for item in current if all(item.get(key) == built.get(key) for key in fields)]
    current_producer = retained[0] if len(retained) == 1 else {}
    predicates = {"unique_execution": len(retained) == 1}
    if len(retained) == 1:
        predicates.update(
            status_completed=current_producer.get("status") == "completed",
            conclusion_success=current_producer.get("conclusion") == "success",
            revision_matches=current_producer.get("head_sha") == revision,
            run_matches=current_producer.get("run_id") == run_id,
            attempt_matches=current_producer.get("run_attempt") == latest,
            job_id_positive_integer=type(current_producer.get("id")) is int and current_producer["id"] >= 1,
        )
    if not all(predicates.values()):
        raise rejected(
            "The successful producer execution was replaced or is absent from the latest graph",
            "latest-execution",
            {
                "records": len(current),
                "matches": len(retained),
                "selected_job_id": bounded_number(current_producer.get("id")),
                "predicates": predicates,
                "execution_comparisons": [
                    {
                        "job_id": bounded_number(item.get("id")),
                        "same_execution": {key: item.get(key) == built.get(key) for key in fields},
                    }
                    for item in current[:4]
                ],
                "comparisons_truncated": len(current) > 4,
            },
        )
    return {
        "producer_attempt": attempt,
        "validation_attempt": str(latest),
        "check_run_id": check,
        "latest_job_id": str(retained[0]["id"]),
    }


def eligible(
    repository: str, run_id: int, integrated_revision: str, expected_workflow: str, source: dict | None = None
) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise Invalid("Invalid caller repository")
    if not re.fullmatch(r"[0-9a-f]{40}", integrated_revision) or run_id < 1:
        raise Invalid("Exact integrated revision and numeric build run are required")
    run = get(f"repos/{repository}/actions/runs/{run_id}")
    if (
        run["repository"]["full_name"] != repository
        or run["head_repository"]["full_name"] != repository
        or run["event"] not in {"pull_request", "push", "workflow_dispatch"}
        or run["status"] != "completed"
        or run["conclusion"] != "success"
        or run["path"] != expected_workflow
    ):
        raise Invalid("Build run is not the expected successful same-repository source validation")
    if run["event"] in {"push", "workflow_dispatch"}:
        if run.get("head_branch") != "main" or run.get("head_sha") != integrated_revision:
            raise Invalid("Delivery requires the exact successful main candidate")
        current = get(f"repos/{repository}/git/ref/heads/main")
        if current.get("object", {}).get("sha") != integrated_revision:
            raise Invalid("Main candidate was superseded before delivery admission")
        binding = {
            "repository": repository,
            "head": integrated_revision,
            "run_id": str(run_id),
            "attempt": str(run["run_attempt"]),
            "event": run["event"],
        }
        if source is not None:
            if source.get("check_run_id") is not None:
                proof = producer(repository, run_id, integrated_revision, source, run=run)
                if proof["producer_attempt"] != binding["attempt"]:
                    binding["validation_attempt"] = binding["attempt"]
                    binding["attempt"] = proof["producer_attempt"]
            if (
                any(source.get(k) != v for k, v in binding.items() if k != "validation_attempt")
                or source.get("tested_revision") != integrated_revision
            ):
                raise Invalid("Artifact source differs from the successful main run/attempt")
            candidate = get(f"repos/{repository}/git/commits/{integrated_revision}")
            if candidate.get("tree", {}).get("sha") != source.get("tested_tree"):
                raise Invalid("Main artifact differs from its tested source tree")
            refreshed = get(f"repos/{repository}/actions/runs/{run_id}")
            if (
                refreshed.get("run_attempt") != run["run_attempt"]
                or refreshed.get("status") != "completed"
                or refreshed.get("conclusion") != "success"
            ):
                raise Invalid("Main validation changed during producer admission")
        return {**binding, "integrated_revision": integrated_revision, "workflow": expected_workflow}
    pulls = run.get("pull_requests", [])
    if not pulls:
        # GitHub can clear a completed PR run's mutable association list after merge.
        # Recover only from the actual integrated commit, retaining the immutable run head.
        associated = get(f"repos/{repository}/commits/{integrated_revision}/pulls")
        pulls = [
            pull
            for pull in associated
            if pull.get("merged_at")
            and pull.get("merge_commit_sha") == integrated_revision
            and pull.get("head", {}).get("sha") == run["head_sha"]
        ]
    if len(pulls) != 1:
        raise Invalid("Exactly one source PR must bind the build candidate")
    pull = get(f"repos/{repository}/pulls/{pulls[0]['number']}")
    if (
        not pull["merged"]
        or pull["merge_commit_sha"] != integrated_revision
        or pull["head"]["sha"] != run["head_sha"]
        or pull["head"]["repo"]["full_name"] != repository
    ):
        raise Invalid("The integrated candidate differs from the trusted completed PR run")
    binding = {
        "repository": repository,
        "head": run["head_sha"],
        "run_id": str(run_id),
        "attempt": str(run["run_attempt"]),
        "event": "pull_request",
    }
    if source is not None:
        if any(source.get(k) != v for k, v in binding.items()):
            raise Invalid("Artifact source differs from the actual PR run/attempt")
        tested = source.get("tested_revision", "")
        if not re.fullmatch(r"[0-9a-f]{40}", tested):
            raise Invalid("Artifact must name an exact tested revision")
        candidate = get(f"repos/{repository}/git/commits/{tested}")
        integrated = get(f"repos/{repository}/git/commits/{integrated_revision}")
        if candidate["tree"]["sha"] != source.get("tested_tree") or candidate["tree"] != integrated["tree"]:
            raise Invalid("Integrated source tree differs from the tested artifact tree")
        parents = {p["sha"] for p in candidate["parents"]}
        if tested != binding["head"] and not {binding["head"], source.get("base")} <= parents:
            raise Invalid("Tested PR merge does not bind the declared head/base")
    return {**binding, "integrated_revision": integrated_revision, "workflow": expected_workflow}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(repository: str, artifact_id: int, destination: Path) -> None:
    # GitHub returns a short-lived object-store URL. Never forward the GitHub token there.
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request(f"repos/{repository}/actions/artifacts/{artifact_id}/zip"), timeout=30)
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise
        location = error.headers["Location"]
        if not location.startswith("https://"):
            raise Invalid("Artifact redirect must use HTTPS")
        response = urllib.request.urlopen(location, timeout=60)
    with response, destination.open("wb") as output:
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > 512 * 1024 * 1024:
                raise Invalid("Artifact exceeds the bounded 512MiB delivery bundle limit")
            output.write(chunk)


def bundle(
    repository: str, run_id: int, revision: str, workflow: str, directory: Path
) -> tuple[Path, dict, dict]:
    binding = eligible(repository, run_id, revision, workflow)
    response = get(f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100")
    if response.get("total_count", len(response["artifacts"])) > 100:
        raise Invalid("Native source artifact selection exceeds its bounded page")
    pattern = re.compile(rf"nddev-source-{run_id}-([1-9][0-9]{{0,8}})-primary")
    candidates = [
        (int(match[1]), item)
        for item in response["artifacts"]
        if (match := pattern.fullmatch(item["name"]))
        and not item["expired"]
        and int(match[1]) <= int(binding["attempt"])
    ]
    selected_attempt = max((attempt for attempt, _ in candidates), default=0)
    matches = [item for attempt, item in candidates if attempt == selected_attempt]
    if len(matches) != 1:
        raise Invalid("No unique nonexpired source artifact candidate for the successful run")
    directory.mkdir(parents=True, exist_ok=False)
    downloaded = directory / "source.zip"
    download(repository, matches[0]["id"], downloaded)
    digest = matches[0].get("digest")
    if digest is not None:
        with downloaded.open("rb") as stream:
            observed_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if (
            not isinstance(digest, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
            or observed_digest != digest[7:]
        ):
            raise Invalid("Downloaded native artifact differs from its immutable archive digest")
    elif selected_attempt != int(binding["attempt"]):
        raise Invalid("A retained native source artifact requires its immutable archive digest")
    required = {"result.json", "artifact.tar.gz", "artifact.tar.gz.json"}
    with zipfile.ZipFile(downloaded) as archive:
        selected = [i for i in archive.infolist() if i.filename in required]
        if len(selected) != 3 or {i.filename for i in selected} != required:
            raise Invalid("Build bundle lacks unique result/archive/manifest members")
        if sum(i.file_size for i in selected) > 512 * 1024 * 1024:
            raise Invalid("Expanded delivery bundle exceeds its limit")
        for member in selected:
            (directory / member.filename).write_bytes(archive.read(member))
    result = json.loads((directory / "result.json").read_text())
    manifest = json.loads((directory / "artifact.tar.gz.json").read_text())
    if (
        result.get("status") != "success"
        or aggregate(result["expected"], result["results"])["status"] != "success"
        or result["identity"] != manifest["source"]
    ):
        raise Invalid("Artifact lacks a complete successful native result")
    if manifest["source"].get("attempt") != str(selected_attempt):
        raise Invalid("Artifact name and native producer attempt differ")
    if selected_attempt != int(binding["attempt"]) and not manifest["source"].get("check_run_id"):
        raise Invalid(
            "Retained source artifacts require native producer provenance; legacy sources rerun fully"
        )
    eligible(repository, run_id, revision, workflow, manifest["source"])
    for field, environment in (
        ("library_repository", "NDDEV_LIBRARY_REPOSITORY"),
        ("library_ref", "NDDEV_LIBRARY_REF"),
    ):
        if not os.environ.get(environment) or manifest["source"].get(field) != os.environ[environment]:
            raise Invalid("Build and delivery require the same explicitly selected library identity")
    return directory / "artifact.tar.gz", manifest, manifest["source"]


def authorized_revision(run_id: int, workflow: str, *, allow_dispatch: bool = False) -> str:
    """Legacy integration or a trusted completed main workflow; event metadata is checked again by API."""
    event, ref = os.environ.get("GITHUB_EVENT_NAME"), os.environ.get("GITHUB_REF")
    if event == "push" and ref in {"refs/heads/dev", "refs/heads/main"}:
        return os.environ.get("GITHUB_SHA", "")
    if allow_dispatch and event == "workflow_dispatch" and ref == "refs/heads/main":
        return os.environ.get("GITHUB_SHA", "")
    if event != "workflow_run" or ref != "refs/heads/main" or not os.environ.get("GITHUB_EVENT_PATH"):
        raise Invalid("Delivery requires successful main CI or an explicit legacy integration event")
    payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    run = payload.get("workflow_run", {})
    if (
        run.get("id") != run_id
        or run.get("path") != workflow
        or run.get("event") not in {"push", "workflow_dispatch"}
        or run.get("head_branch") != "main"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        raise Invalid("Completion event does not identify the selected successful main workflow")
    revision = run.get("head_sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise Invalid("Completion event lacks an exact main revision")
    return revision


def successful_main_base(root: Path, workflow: str) -> str | None:
    """A pending/failed/superseded push cannot advance the checked impact baseline."""
    from .model import git

    if not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", workflow):
        raise Invalid("Select the exact main validation workflow")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return None
    try:
        runs = get(
            f"repos/{repository}/actions/workflows/{workflow.rsplit('/', 1)[1]}/runs?branch=main&event=push&status=success&per_page=20"
        )["workflow_runs"]
        head = git(root, "rev-parse", "HEAD")
        candidates = []
        for run in runs:
            revision = run.get("head_sha", "")
            if (
                run.get("repository", {}).get("full_name") != repository
                or run.get("path") != workflow
                or run.get("event") != "push"
                or run.get("head_branch") != "main"
                or run.get("status") != "completed"
                or run.get("conclusion") != "success"
                or not re.fullmatch(r"[0-9a-f]{40}", revision)
                or revision == head
            ):
                continue
            try:
                git(root, "merge-base", "--is-ancestor", revision, head)
                distance = int(git(root, "rev-list", "--count", f"{revision}..{head}"))
            except Invalid:
                continue
            candidates.append((distance, revision))
        return min(candidates)[1] if candidates else None
    except (OSError, ValueError, KeyError, TypeError):
        # Unavailable metadata keeps all obligations; it is never an empty change set.
        return None


def dependency_review_refs(
    root: Path, base: str | None = None, workflow: str = ".github/workflows/main-ci.yml"
) -> dict:
    """Review PR source refs or every main change since an accepted ancestor."""
    from .model import git, source_identity

    source = source_identity(root)
    if source["event"] == "pull_request":
        base, head = source["base"], source["head"]
    elif (
        source["event"] in {"push", "workflow_dispatch"} and os.environ.get("GITHUB_REF") == "refs/heads/main"
    ):
        base, head = base or successful_main_base(root, workflow), source["tested_revision"]
        if base:
            git(root, "merge-base", "--is-ancestor", base, head)
    else:
        raise Invalid("Dependency review requires a PR or main push")
    if not all(isinstance(ref, str) and re.fullmatch(r"[0-9a-f]{40}", ref) for ref in (base, head)):
        raise Invalid("Dependency review requires exact source refs and an accepted main baseline")
    return {"base": base, "head": head}
