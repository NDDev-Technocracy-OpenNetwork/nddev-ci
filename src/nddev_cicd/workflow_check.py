"""Validate selected workflow pin/permission boundaries without proprietary tools."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from .documentation import StrictLoader
from .model import Invalid


def check(root: Path) -> dict:
    files = sorted((root / ".github/workflows").glob("*.y*ml"))
    if not files:
        raise Invalid("Workflow profile matched no workflows")
    uses_count = 0
    for path in files:
        workflow = yaml.load(path.read_text(), Loader=StrictLoader)
        events = workflow.get("on", workflow.get(True, {}))
        if not events:
            raise Invalid(f"Workflow has no event: {path.name}")
        if "permissions" not in workflow:
            raise Invalid(f"Explicit least-privilege permissions required: {path.name}")
        for job in workflow.get("jobs", {}).values():
            if "uses" not in job and not job.get("timeout-minutes"):
                raise Invalid(f"Native job lacks a finite timeout: {path.name}")
            for step in job.get("steps", []):
                if "${{" in step.get("run", ""):
                    raise Invalid(
                        f"Pass expression inputs as environment data, not shell interpolation: {path.name}"
                    )
            references = [job.get("uses", "")] + [step.get("uses", "") for step in job.get("steps", [])]
            for reference in references:
                if not reference or reference.startswith(("./", "$/")):
                    continue
                uses_count += 1
                if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}", reference):
                    raise Invalid(f"External action/workflow requires an exact full SHA: {reference}")
    return {"workflows": len(files), "pinned_uses": uses_count}


if __name__ == "__main__":
    print(check(Path.cwd()))
