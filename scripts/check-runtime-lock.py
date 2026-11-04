"""Bind authored workflow pins to exact immutable implementation/facade Git sources."""

import json
import re
import subprocess
import tomllib
from pathlib import Path

import yaml

lock = json.loads(Path(".github/runtime-lock.json").read_text())
repository, implementation, facade = (lock[key] for key in ("repository", "implementation", "facade"))
for ref in (implementation, facade):
    assert re.fullmatch("[0-9a-f]{40}", ref)
    subprocess.run(["git", "merge-base", "--is-ancestor", ref, "HEAD"], check=True)
package = tomllib.loads(
    subprocess.check_output(["git", "show", implementation + ":pyproject.toml"], text=True)
)
assert package["project"]["version"] == lock["package"]
pattern = re.compile(re.escape(repository) + r"/(\.github/(?:actions|workflows)/[^\s@]+)@([0-9a-f]{40})")
for path in Path(".github/workflows").glob("*.yml"):
    for relative, ref in pattern.findall(path.read_text()):
        assert ref == (facade if relative.startswith(".github/workflows/") else implementation), path
for name in ("source.yml", "release.yml", "public-security.yml"):
    source = subprocess.check_output(["git", "show", f"{facade}:.github/workflows/{name}"], text=True)
    assert implementation in source
    assert all(ref == implementation for _, ref in pattern.findall(source))
print("Native package identity and source/delivery/facade bindings agree")

# Reusable jobs cannot request authority omitted by their caller.
levels = {"none": 0, "read": 1, "write": 2}
for path in Path(".github/workflows").glob("*.yml"):
    workflow = yaml.safe_load(path.read_text())
    for job in workflow.get("jobs", {}).values():
        uses = job.get("uses", "")
        found = pattern.fullmatch(uses)
        if not found or not found[1].startswith(".github/workflows/"):
            continue
        target = yaml.safe_load(subprocess.check_output(["git", "show", f"{found[2]}:{found[1]}"], text=True))
        allowed = job.get("permissions", workflow.get("permissions", {}))
        for child in target.get("jobs", {}).values():
            required = child.get("permissions", target.get("permissions", {}))
            assert isinstance(allowed, dict) and isinstance(required, dict)
            for permission, mode in required.items():
                assert levels[mode] <= levels[allowed.get(permission, "none")], (path, permission)
print("Pinned reusable workflow authority fits its explicit caller permissions")
