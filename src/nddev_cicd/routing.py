"""Pre-scheduling, capability-aware no-charge admission. No billing API or quota daemon."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .model import Invalid, Unavailable

PLATFORMS = {"linux", "windows", "macos"}
# Standard GitHub-hosted runners that GitHub lists for public repositories, where they run without
# charge; larger runners are billed per minute even there (STD-0004 R-0004/R-0005). Exact images, never
# a floating -latest label. Keyed by platform and architecture.
PUBLIC_STANDARD = {
    ("linux", "x64"): "ubuntu-26.04",
    ("linux", "arm64"): "ubuntu-26.04-arm",
    ("windows", "x64"): "windows-2025",
    ("windows", "arm64"): "windows-11-arm",
    ("macos", "arm64"): "macos-15",
    ("macos", "x64"): "macos-15-intel",
}
DEFAULT_ARCHITECTURE = {"linux": "x64", "windows": "x64", "macos": "arm64"}
STANDARD = {platform: PUBLIC_STANDARD[(platform, arch)] for platform, arch in DEFAULT_ARCHITECTURE.items()}
# Every label in GitHub's public-repository table on 2026-11-01; the ones being retired are flagged.
PUBLIC_LABELS = frozenset(
    {
        "ubuntu-slim",
        "ubuntu-22.04",
        "ubuntu-24.04",
        "ubuntu-26.04",
        "ubuntu-22.04-arm",
        "ubuntu-24.04-arm",
        "ubuntu-26.04-arm",
        "windows-2022",
        "windows-2025",
        "windows-2025-vs2026",
        "windows-11-arm",
        "windows-11-vs2026-arm",
        "macos-14",
        "macos-15",
        "macos-26",
        "macos-15-intel",
        "macos-26-intel",
    }
)
RETIRING = {
    "macos-14": "unsupported from 2026-11-02 (actions/runner-images#13518)",
    "ubuntu-22.04": "unsupported from 2027-04-17 (actions/runner-images#14254)",
    "ubuntu-22.04-arm": "unsupported from 2027-04-17 (actions/runner-images#14254)",
}


def public_label(label: str) -> tuple[str, str]:
    """Classify a GitHub-hosted runs-on label for a public repository: (verdict, reason)."""
    if label.endswith("-latest"):
        return "floating", "names whatever image GitHub moves the label to; select the exact image"
    if label in RETIRING:
        return "retiring", RETIRING[label]
    if label in PUBLIC_LABELS:
        return "standard", "standard GitHub-hosted runner, free in public repositories"
    if any(part in label for part in ("-large", "-xlarge", "-cores", "gpu")):
        return "larger", "larger runner, billed per minute even in public repositories"
    return "unknown", "not a standard GitHub-hosted label for public repositories"


def caller_policy(policy: dict) -> dict:
    """A reusable publisher never changes the actual caller's billing/trust context."""
    result = dict(policy)
    actors = result.pop("trusted_actors", None)
    if actors is not None and (
        not isinstance(actors, list)
        or not actors
        or not all(isinstance(actor, str) and actor for actor in actors)
    ):
        raise Invalid("Trusted actors must be an explicit nonempty caller-owned list")
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return result
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        repository = event["repository"]
        actual = repository.get("visibility")
        if actual == "internal":
            actual = "private"
        if actual is None and type(repository.get("private")) is bool:
            actual = "private" if repository["private"] else "public"
        if actual not in {"public", "private"} or repository["full_name"] != os.environ["GITHUB_REPOSITORY"]:
            raise Unavailable("The actual caller repository visibility cannot be established")
    except (KeyError, OSError, ValueError) as error:
        raise Unavailable("The actual caller repository context is unavailable") from error
    if policy.get("visibility") != actual:
        raise Invalid("Admission policy visibility differs from the actual caller repository")
    if "pull_request" in event:
        head = event["pull_request"].get("head", {}).get("repo") or {}
        association = event["pull_request"].get("author_association")
        actor_is_trusted = (
            (event["pull_request"].get("user", {}).get("login") in actors)
            if actors is not None
            else association in {"OWNER", "MEMBER", "COLLABORATOR"}
        )
        if head.get("full_name") != repository["full_name"] or not actor_is_trusted:
            result["trusted"] = False
    return result


def select(
    visibility: str,
    platform: str,
    *,
    private_labels: list[str] | None = None,
    trusted: bool = False,
    architecture: str = "x64",
    admission: dict | None = None,
) -> dict:
    if type(trusted) is not bool:
        raise Invalid("Trusted capacity selection requires a boolean owner policy")
    if visibility not in {"public", "private"} or platform not in PLATFORMS:
        raise Invalid("Unknown repository visibility or platform")
    if architecture not in {"x64", "arm64"}:
        raise Invalid("Unknown runner architecture")
    choices = admission or {}
    if not isinstance(choices, dict):
        raise Invalid("Capacity admission must be an object")
    for provider in ("blacksmith", "github"):
        policy = choices.get(provider, {})
        if not isinstance(policy, dict) or type(policy.get("enabled", False)) is not bool:
            raise Invalid("Capacity admission enabled must be a boolean")
    if visibility == "public":
        runner = PUBLIC_STANDARD[(platform, architecture)]
        github = choices.get("github", {})
        if github.get("enabled") and github.get("runners", {}).get(platform) != [runner]:
            raise Invalid("Public capacity must use the compatible standard GitHub runner")
        return {"provider": "github", "runner": [runner], "basis": "standard-public"}
    if platform == "linux":
        if not trusted:
            raise Unavailable("Untrusted/fork code cannot schedule private self-hosted capacity")
        scale = choices.get("self_hosted")
        if scale is not None:
            if not isinstance(scale, dict) or scale.get("kind") != "scale-set":
                raise Invalid("Select an explicit caller-owned self-hosted scale-set policy")
            if (
                scale.get("guarantee") != "self-hosted-only"
                or scale.get("platform") != platform
                or scale.get("architecture") != architecture
            ):
                raise Unavailable(
                    "The scale set needs verified matching native capabilities and self-hosted-only authority"
                )
            for key, maximum in (("name", 100), ("group", 100), ("reference", 2048)):
                value = scale.get(key)
                if (
                    not isinstance(value, str)
                    or not value
                    or value.strip() != value
                    or len(value) > maximum
                    or any(c in value for c in "\r\n\0")
                ):
                    raise Invalid(
                        "Scale-set name, runner group and owner inventory reference must be explicit bounded strings"
                    )
            if private_labels is not None and private_labels != [scale["name"]]:
                raise Invalid("A scale-set route uses exactly its declared label within its declared group")
            return {
                "provider": "self-hosted",
                "runner": {"group": scale["group"], "labels": scale["name"]},
                "basis": scale["reference"],
                "availability": "not-checked",
                "limitations": [
                    "Scale-set capabilities/kind are caller-owned inventory facts; online state, access and queue availability are not queried."
                ],
            }
        labels = private_labels or []
        if (
            not labels
            or "self-hosted" not in labels
            or not all(
                isinstance(label, str) and label and len(label) <= 100 and "\n" not in label
                for label in labels
            )
        ):
            raise Invalid("Private Linux requires bounded caller-owned self-hosted labels")
        actual = {label.casefold() for label in labels}
        if "linux" not in actual or architecture not in actual:
            raise Invalid(
                "Private labels must include the verified Linux and selected architecture capabilities"
            )
        return {
            "provider": "self-hosted",
            "runner": labels,
            "basis": "existing-private-capacity",
            "availability": "not-checked",
            "limitations": [
                (
                    "Label validation does not query online runners, repository access or queue capacity; "
                    "the caller must establish availability through its native runner inventory."
                )
            ],
        }
    for provider in ("blacksmith", "github"):
        policy = choices.get(provider, {})
        if type(policy.get("enabled", False)) is not bool:
            raise Invalid("Capacity admission enabled must be a boolean")
        if not policy.get("enabled", False):
            continue
        # Caller-owned trusted account policy, never a PR balance/label or an email alert.
        if policy.get("guarantee") not in {"hard-no-overage", "standard-public"} or not policy.get(
            "reference"
        ):
            continue
        if policy.get("guarantee") == "standard-public" and (provider != "github" or visibility != "public"):
            continue
        if platform not in policy.get("platforms", []) or architecture not in policy.get("architectures", []):
            continue
        runner = policy.get("runners", {}).get(platform)
        if not isinstance(runner, list) or not runner or not all(isinstance(x, str) for x in runner):
            raise Invalid("Admission must resolve a known runner before scheduling")
        if policy.get("guarantee") == "standard-public" and (
            runner != [PUBLIC_STANDARD[(platform, architecture)]]
        ):
            raise Invalid("Standard public admission cannot allocate larger or incompatible runners")
        return {"provider": provider, "runner": runner, "basis": policy["reference"]}
    raise Unavailable("No confirmed compatible no-overage route; paid-capable dispatch remains disabled")


def workflow_labels(root) -> list[dict]:
    """Classify every literal GitHub-hosted runs-on label (including matrix values) in .github/workflows."""
    import re
    from pathlib import Path

    import yaml

    findings: list[dict] = []
    directory = Path(root) / ".github" / "workflows"
    for path in sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")]):
        document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for job_id, job in (document.get("jobs") or {}).items():
            if not isinstance(job, dict) or "uses" in job:
                continue
            runs_on = job.get("runs-on")
            values = runs_on if isinstance(runs_on, list) else [runs_on]
            labels: list[str] = []
            for value in values:
                if not isinstance(value, str):
                    continue
                if "${{" in value:
                    matrix = ((job.get("strategy") or {}).get("matrix")) or {}
                    candidates = (
                        [*matrix.values(), *(matrix.get("include") or [])] if isinstance(matrix, dict) else []
                    )
                    for item in candidates:
                        items = (
                            item.values()
                            if isinstance(item, dict)
                            else item
                            if isinstance(item, list)
                            else []
                        )
                        labels += [
                            x for x in items if isinstance(x, str) and re.match(r"(ubuntu|windows|macos)-", x)
                        ]
                else:
                    labels.append(value)
            if any(label in {"self-hosted"} for label in labels):
                continue
            for label in dict.fromkeys(labels):
                verdict, reason = public_label(label)
                findings.append(
                    {
                        "workflow": path.name,
                        "job": job_id,
                        "label": label,
                        "verdict": verdict,
                        "reason": reason,
                    }
                )
    return findings


# Private self-hosted runner classes (R-0004). A private job names its class once through the route
# expression. The fleet controller owns the fallback chain and writes two repository variables, in a
# repository right before it moves one of its runs, that the expression only reads (organization
# variables are not visible to private repositories on GitHub Free; repositories never set these):
#   NDDEV_ROUTE_LABELS  static and flat, "<tier>/<class>" -> label, e.g. "blacksmith/nddev-linux-small"
#   NDDEV_RUN_ROUTES    "<run_id>" -> "blacksmith" | "hosted" for a run it moved after waiting
# A run without an entry keeps its class, so a manual re-run of an unmoved run stays self-hosted. A moved
# run is cancelled and re-run; runs-on is evaluated again for that attempt and resolves to the tier label.
RUNNER_CLASSES = (
    "nddev-linux-small",
    "nddev-linux",
    "nddev-linux-standart",
    "nddev-linux-arm-small",
    "nddev-macos-small",
)
_ROUTE = (
    "${{{{ fromJSON(vars.NDDEV_ROUTE_LABELS || '{{}}')[format('{{0}}/{{1}}', "
    "fromJSON(vars.NDDEV_RUN_ROUTES || '{{}}')[github.run_id] || 'self', {cls})] || {cls} }}}}"
)


def route_expression(runner_class: str, *, reusable: bool = False) -> str:
    """The canonical runs-on value for a private job of `runner_class`.

    With `reusable`, the class comes from the caller as `inputs.runner-class`; the caller still names it
    literally in `with:`, which is how the controller recognizes an adopted workflow.
    """
    if reusable:
        return _ROUTE.format(cls="inputs.runner-class")
    if runner_class not in RUNNER_CLASSES:
        raise Invalid(f"Unknown runner class {runner_class!r}; known: {', '.join(RUNNER_CLASSES)}")
    return _ROUTE.format(cls=f"'{runner_class}'")


def _route_class(value: str) -> str | None:
    """The class of a canonical route expression, or None when `value` is not one."""
    for runner_class in RUNNER_CLASSES:
        if value.strip() == route_expression(runner_class):
            return runner_class
    if value.strip() == route_expression("", reusable=True):
        return "inputs.runner-class"
    return None


def private_jobs(root) -> list[dict]:
    """Classify the runner of every job in a private repository's .github/workflows (R-0004).

    routed   the canonical route expression with a known class: the controller may move it after waiting
    fixed    explicit self-hosted labels, or a matrix/inputs/variable expression: never moved
    hosted   a GitHub-hosted label: Linux is refused (private Linux is self-hosted); Windows/macOS reported
    invalid  hosted Linux, or an altered route expression (reads the route variables non-canonically)
    """
    from pathlib import Path

    import yaml

    findings: list[dict] = []
    directory = Path(root) / ".github" / "workflows"
    for path in sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")]):
        document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for job_id, job in (document.get("jobs") or {}).items():
            if not isinstance(job, dict) or "uses" in job or "runs-on" not in job:
                continue
            runs_on = job["runs-on"]
            values = runs_on if isinstance(runs_on, list) else [runs_on]
            item = {"workflow": path.name, "job": job_id}
            if len(values) == 1 and isinstance(values[0], str) and "${{" in values[0]:
                runner_class = _route_class(values[0])
                if runner_class:
                    findings.append({**item, "verdict": "routed", "class": runner_class})
                elif "NDDEV_ROUTE_LABELS" in values[0] or "NDDEV_RUN_ROUTES" in values[0]:
                    # A route that differs from the canonical one would read the controller's
                    # variables differently from what the controller writes.
                    findings.append({**item, "verdict": "invalid", "reason": "altered route expression"})
                else:
                    # matrix, inputs or a repository variable select the runner; the controller
                    # never moves such a job, so it stays on whatever capacity it selects.
                    findings.append({**item, "verdict": "fixed", "reason": "expression-selected runner"})
                continue
            labels = [value for value in values if isinstance(value, str)]
            hosted = [label for label in labels if label.startswith(("ubuntu-", "windows-", "macos-"))]
            if "self-hosted" in labels or not hosted:
                # Explicit self-hosted capacity, including custom pools such as `curestry-new-deploy`.
                findings.append({**item, "verdict": "fixed", "labels": labels})
            elif any(label.startswith("ubuntu-") for label in labels):
                findings.append(
                    {
                        **item,
                        "verdict": "invalid",
                        "labels": labels,
                        "reason": "private Linux work runs on self-hosted capacity; route it by class",
                    }
                )
            else:
                findings.append({**item, "verdict": "hosted", "labels": labels})
    return findings
