"""Bounded metadata-only failure feedback; candidate code and logs are never executed."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta

from . import github
from .model import Invalid

CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}


def input_hints(repository: str, job: dict) -> list[str]:
    """Read bounded native annotations only; hints never establish eligibility or replay authority."""
    prefix = f"https://api.github.com/repos/{repository}/check-runs/"
    url = job.get("check_run_url", "")
    if not isinstance(url, str) or not url.startswith(prefix) or not url[len(prefix) :].isdecimal():
        return []
    try:
        rows = github.get(f"repos/{repository}/check-runs/{url[len(prefix) :]}/annotations?per_page=100")
    except urllib.error.HTTPError:
        return []  # unavailable optional metadata must not invent a cause or prevent ordinary feedback
    if not isinstance(rows, list):
        raise Invalid("Unexpected native check annotation metadata")
    allowed = {"infrastructure.external-download", "infrastructure.cache-busy", "infrastructure.disk-reserve"}
    return sorted(
        {
            row.get("message", "").partition(":")[0]
            for row in rows[:100]
            if isinstance(row, dict)
            and row.get("title") == "NDDev infrastructure input"
            and isinstance(row.get("message"), str)
            and row["message"].partition(":")[0] in allowed
        }
    )


def write(path: str, payload: dict) -> dict:
    req = github.request(path)
    req.method = "POST"
    req.data = json.dumps(payload).encode()
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def pages(path: str, limit: int = 5) -> list[dict]:
    records = []
    for page in range(1, limit + 1):
        batch = github.get(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        if not isinstance(batch, list):
            raise Invalid("Unexpected paginated feedback response")
        records.extend(batch)
        if len(batch) < 100:
            return records
    raise Invalid("Feedback pagination budget exhausted; reconcile explicitly before retrying")


def publish(
    repository: str,
    workflows: list[str],
    creators: list[str],
    *,
    run_id: int | None = None,
    conclusions: list[str] | None = None,
    task_issue: int | None = None,
    events: list[str] | None = None,
    branches: list[str] | None = None,
    since: str | None = None,
    page_budget: int = 50,
    infrastructure_hints: bool = False,
) -> dict:
    if type(infrastructure_hints) is not bool:
        raise Invalid("Infrastructure annotation hints must be explicitly enabled or disabled")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise Invalid("Select an exact caller repository")
    if (
        not workflows
        or len(workflows) > 10
        or any(not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", p) for p in workflows)
    ):
        raise Invalid("Select bounded exact workflow paths")
    if (
        not creators
        or len(creators) > 32
        or any(not re.fullmatch(r"[A-Za-z0-9_-]+(?:\[bot\])?", p) for p in creators)
    ):
        raise Invalid("Feedback requires an explicit creator allowlist")
    conclusions = (
        conclusions
        if conclusions is not None
        else ["failure", "timed_out", "action_required", "startup_failure", "stale"]
    )
    if (
        not isinstance(conclusions, list)
        or not conclusions
        or any(not isinstance(x, str) or x not in CONCLUSIONS for x in conclusions)
    ):
        raise Invalid("Feedback only publishes selected non-success conclusions")
    if run_id is not None and (type(run_id) is not int or run_id < 1):
        raise Invalid("Feedback run ID must be positive")
    if task_issue is not None and (type(task_issue) is not int or task_issue < 1):
        raise Invalid("Feedback task Issue must be positive")
    events = events if events is not None else ["push", "schedule", "workflow_dispatch"]
    if (
        not isinstance(events, list)
        or not events
        or any(not isinstance(x, str) for x in events)
        or set(events) - {"push", "schedule", "workflow_dispatch", "workflow_run", "pull_request"}
    ):
        raise Invalid("Feedback requires a bounded event allowlist")
    if type(page_budget) is not int or not 1 <= page_budget <= 100:
        raise Invalid("Feedback run pagination budget must be in 1..100")
    prefix = f"repos/{repository}"
    if branches is None:
        branches = [github.get(prefix).get("default_branch")]
    if (
        not isinstance(branches, list)
        or not branches
        or len(branches) > 4
        or any(not isinstance(branch, str) or not branch or len(branch) > 255 for branch in branches)
    ):
        raise Invalid("Feedback requires bounded exact branch names")
    if run_id is not None:
        candidates = [github.get(f"{prefix}/actions/runs/{run_id}")]
    else:
        now = datetime.now(UTC)
        since = since or (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            lower = datetime.strptime(since, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        except ValueError as error:
            raise Invalid("Feedback since must be a native UTC timestamp") from error
        if not now - timedelta(days=30) <= lower <= now:
            raise Invalid("Feedback reconciliation must select a window within the past 30 days")
        candidates = []
        remaining = page_budget
        for workflow in dict.fromkeys(workflows):
            key = urllib.parse.quote(workflow.rsplit("/", 1)[1], safe="")
            for branch in dict.fromkeys(branches):
                for event in dict.fromkeys(events):
                    query = urllib.parse.urlencode(
                        {
                            "status": "completed",
                            "event": event,
                            "branch": branch,
                            "created": ">=" + since,
                        }
                    )
                    page = 1
                    while True:
                        if remaining == 0:
                            raise Invalid("Feedback run pagination budget exhausted before publication")
                        remaining -= 1
                        response = github.get(
                            f"{prefix}/actions/workflows/{key}/runs?{query}&per_page=100&page={page}"
                        )
                        batch = response.get("workflow_runs") if isinstance(response, dict) else None
                        if not isinstance(batch, list) or any(not isinstance(item, dict) for item in batch):
                            raise Invalid("Unexpected paginated feedback runs")
                        candidates.extend(batch)
                        if len(batch) < 100:
                            break
                        page += 1
        candidates = list({(item["id"], item["run_attempt"]): item for item in candidates}.values())
    actions = []
    for run in candidates:
        if (
            run.get("repository", {}).get("full_name") != repository
            or run.get("path") not in workflows
            or run.get("actor", {}).get("login") not in creators
            or run.get("event") not in events
            or run.get("head_branch") not in branches
            or run.get("status") != "completed"
            or run.get("conclusion") not in conclusions
        ):
            continue
        number, attempt = run.get("id"), run.get("run_attempt")
        if type(number) is not int or number < 1 or type(attempt) is not int or attempt < 1:
            raise Invalid("Native run/attempt identity is absent")
        marker = f"<!-- nddev-ci-feedback:{number}:{attempt} -->"
        # Since creation bounds recent Issue reads while retaining closed markers for old reruns.
        created = run.get("created_at", "")
        if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", created):
            raise Invalid("Native run creation time is absent")
        jobs = github.records(f"{prefix}/actions/runs/{number}/attempts/{attempt}/jobs", "jobs")
        failed_jobs = [job for job in jobs if job.get("conclusion") in CONCLUSIONS]
        names = (
            "\n".join(
                "- "
                + str(job.get("name", "unnamed job"))[:200].replace("`", "'").replace("\n", " ")
                + " ("
                + str(job["conclusion"])
                + ")"
                for job in failed_jobs
            )
            or "No failing job metadata is exposed by the native API."
        )
        body = (
            f"{marker}\nNative workflow `{run['path']}` concluded `{run['conclusion']}`.\n\n"
            f"[Inspect the exact run attempt](https://github.com/{repository}/actions/runs/{number}/attempts/{attempt}).\n\n"
            f"Failed jobs (metadata only):\n{names}\n\n"
            "The owning agent must inspect the native diagnostics and resolve or record the failure. "
            "This publisher reads metadata only and does not execute candidate code or download artifacts.\n"
        )
        if infrastructure_hints:
            hints = sorted({hint for job in failed_jobs[:32] for hint in input_hints(repository, job)})
            if hints:
                body += (
                    "\nNative input-unavailability hints: " + ", ".join(hints) + ". "
                    "These annotations do not classify other failures, admit delivery or authorize a replay.\n"
                )
        trusted_publishers = {"github-actions[bot]", *creators}
        if task_issue:
            issue = github.get(f"{prefix}/issues/{task_issue}")
            existing = [issue, *pages(f"{prefix}/issues/{task_issue}/comments")]
            if any(
                marker in (i.get("body") or "") and i.get("user", {}).get("login") in trusted_publishers
                for i in existing
            ):
                actions.append({"run": number, "attempt": attempt, "action": "existing", "issue": task_issue})
                continue
            published = write(f"{prefix}/issues/{task_issue}/comments", {"body": body})
        else:
            issues = pages(
                f"{prefix}/issues?state=all&sort=created&direction=desc&since={urllib.parse.quote(created)}"
            )
            found = next(
                (
                    i
                    for i in issues
                    if marker in (i.get("body") or "")
                    and i.get("user", {}).get("login") in trusted_publishers
                ),
                None,
            )
            if found:
                actions.append(
                    {"run": number, "attempt": attempt, "action": "existing", "issue": found["number"]}
                )
                continue
            published = write(
                f"{prefix}/issues",
                {
                    "title": f"Resolve {run['path'].rsplit('/', 1)[1]} run {number} attempt {attempt}",
                    "body": body,
                },
            )
        actions.append(
            {"run": number, "attempt": attempt, "action": "published", "url": published["html_url"]}
        )
    return {"status": "success", "results": actions}
