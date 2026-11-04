"""Plan lockfile-keyed GitHub Actions caches for callers on GitHub-hosted runners.

The composite action restores on every event and saves only from a trusted push or manual run
on the default branch. Self-hosted callers keep their owned caches; this plan then selects nothing.
Standard library only: it runs before any project or library environment exists.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path

ECOSYSTEMS = ("cargo", "bun", "npm", "pub", "go")
# uv stores every downloaded wheel; without `uv cache prune --ci` before saving (which a composite
# cannot run after the caller's steps) the entry grows to gigabytes and restores slower than a fresh
# download. astral-sh/setup-uv prunes and saves conditionally, so uv caching belongs there.
RETIRED = {
    "uv": "use astral-sh/setup-uv with enable-cache, cache-dependency-glob, prune-cache: 'true' and "
    "save-cache limited to default-branch pushes",
    "library": "the library runtime shares uv's download cache; cache uv through astral-sh/setup-uv",
}
LOCKS = {
    "bun": ("bun.lock", "bun.lockb"),
    "npm": ("package-lock.json", "npm-shrinkwrap.json"),
    "pub": ("pubspec.lock",),
    "go": ("go.sum", "go.mod"),
}
SKIPPED = {".git", "node_modules", "target", ".venv", ".dart_tool", ".pub-cache"}
TRUSTED_EVENTS = {"push", "workflow_dispatch"}
VERSION = "v1"
# Jobs that build differently (clippy against tests, `-race` against plain Go builds) need separate
# entries: cache keys are immutable, so the first job to save a shared key wins and the others
# restore an unrelated build. rust-cache drops its job key once a shared key is set. The profile
# follows the scope after a dot and holds no dot or dash, so no restore prefix reaches another one.
PROFILE = re.compile(r"[A-Za-z0-9_]{1,40}")


class Invalid(Exception):
    pass


def selected(raw: str) -> list[str]:
    names = [name for name in raw.replace(",", " ").split() if name]
    if not names:
        raise Invalid("Select at least one ecosystem")
    for name in names:
        if name in RETIRED:
            raise Invalid(f"{name} is not cached here: {RETIRED[name]}")
    unknown = sorted(set(names) - set(ECOSYSTEMS))
    if unknown:
        raise Invalid(f"Unknown ecosystem: {', '.join(unknown)}")
    return [name for name in ECOSYSTEMS if name in names]


def contained(workspace: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute():
        raise Invalid("working-directory must be relative to the workspace")
    root = workspace.resolve()
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise Invalid("working-directory must stay inside the workspace")
    if not resolved.is_dir():
        raise Invalid("working-directory does not exist")
    return resolved


def lockfiles(directory: Path, names: tuple[str, ...]) -> list[Path]:
    found: list[Path] = []
    for current, children, files in os.walk(directory):
        children[:] = sorted(child for child in children if child not in SKIPPED)
        found.extend(Path(current) / name for name in sorted(files) if name in names)
    return sorted(found)


def fingerprint(inputs: list[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for label, content in sorted(inputs, key=lambda item: item[0]):
        digest.update(label.encode() + b"\0" + hashlib.sha256(content).hexdigest().encode() + b"\n")
    return digest.hexdigest()[:32]


def plan(environment: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """Return (step outputs, job environment) for the selected ecosystems."""
    ecosystems = selected(environment.get("NDDEV_ECOSYSTEMS", ""))
    save_policy = environment.get("NDDEV_SAVE", "auto")
    if save_policy not in {"auto", "never"}:
        raise Invalid("save must be auto or never")
    profile = environment.get("NDDEV_KEY", "").strip()
    if profile and not PROFILE.fullmatch(profile):
        raise Invalid("key must be 1-40 letters, digits or underscores")
    workspace = Path(environment["GITHUB_WORKSPACE"])
    working = contained(workspace, environment.get("NDDEV_WORKING_DIRECTORY", ".") or ".")
    relative = working.relative_to(workspace.resolve()).as_posix() or "."
    disabled = {"enabled": "false", "save": "false", "cargo": "false", "files": "false"}
    if environment.get("NDDEV_RUNNER_ENVIRONMENT") != "github-hosted":
        return {**disabled, "reason": "self-hosted runners keep their owned caches"}, {}

    default_branch = environment.get("NDDEV_DEFAULT_BRANCH", "")
    save = (
        save_policy == "auto"
        and bool(default_branch)
        and environment.get("NDDEV_EVENT") in TRUSTED_EVENTS
        and environment.get("NDDEV_REF") == f"refs/heads/{default_branch}"
    )
    platform = f"{environment['RUNNER_OS']}-{environment['RUNNER_ARCH']}".lower()
    scope = hashlib.sha256(relative.encode()).hexdigest()[:8] + (f".{profile}" if profile else "")
    root = Path(environment["RUNNER_TEMP"]) / "nddev-hosted-cache"
    outputs = {**disabled, "enabled": "true", "save": str(save).lower(), "reason": ""}
    exports: dict[str, str] = {}

    if "cargo" in ecosystems:
        if not (working / "Cargo.lock").is_file():
            raise Invalid("cargo needs a committed Cargo.lock in working-directory")
        outputs.update(
            cargo="true",
            **{"cargo-workspaces": f"{relative} -> target", "cargo-key": f"nddev-{VERSION}-{scope}"},
        )
        exports["CARGO_INCREMENTAL"] = "0"

    inputs: list[tuple[str, bytes]] = []
    paths: list[Path] = []
    for name in (n for n in ecosystems if n in LOCKS):
        found = lockfiles(working, LOCKS[name])
        if not found:
            raise Invalid(f"{name} needs a committed lockfile ({' or '.join(LOCKS[name])})")
        inputs += [(f"{name}:{p.relative_to(working).as_posix()}", p.read_bytes()) for p in found]
    if "bun" in ecosystems:
        paths.append(root / "bun")
        exports["BUN_INSTALL_CACHE_DIR"] = str(root / "bun")
    if "npm" in ecosystems:
        paths.append(root / "npm")
        exports["npm_config_cache"] = str(root / "npm")
    if "pub" in ecosystems:
        paths.append(root / "pub")
        exports["PUB_CACHE"] = str(root / "pub")
    if "go" in ecosystems:
        paths += [root / "go-mod", root / "go-build"]
        exports.update(GOMODCACHE=str(root / "go-mod"), GOCACHE=str(root / "go-build"))

    if paths:
        names = "-".join(n for n in ecosystems if n != "cargo")
        prefix = f"nddev-hosted-{VERSION}-{platform}-{names}-{scope}-"
        outputs.update(
            files="true",
            paths="\n".join(str(p) for p in paths),
            key=prefix + fingerprint(inputs),
            **{"restore-keys": prefix},
        )
        for path in paths:
            path.mkdir(parents=True, exist_ok=True)
    return outputs, exports


def _write(target: str, values: dict[str, str]) -> None:
    with open(target, "a", encoding="utf-8") as stream:
        for name, value in values.items():
            if "\n" in value:
                stream.write(f"{name}<<NDDEV_EOF\n{value}\nNDDEV_EOF\n")
            else:
                stream.write(f"{name}={value}\n")


def main() -> int:
    try:
        outputs, exports = plan(dict(os.environ))
    except Invalid as error:
        print(f"::error::Hosted cache: {error}", file=sys.stderr)
        return 2
    if outputs.get("reason"):
        print(f"::notice::Hosted cache disabled: {outputs['reason']}")
    else:
        print(f"Hosted cache: save={outputs['save']} cargo={outputs['cargo']} key={outputs.get('key', '-')}")
    _write(os.environ["GITHUB_OUTPUT"], outputs)
    _write(os.environ["GITHUB_ENV"], exports)
    return 0


if __name__ == "__main__":
    sys.exit(main())
