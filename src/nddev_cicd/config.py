"""Small project contract; native manifests/locks and explicit trusted commands own facts."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

from .model import Invalid, contained


def load(root: Path, relative: str = ".github/nddev-ci.toml") -> dict:
    path = contained(root, relative, exists=True)
    with path.open("rb") as stream:
        config = tomllib.load(stream)
    allowed = {
        "schema",
        "profiles",
        "commands",
        "reports",
        "tools",
        "extras",
        "documentation",
        "architecture",
        "artifacts",
        "timeouts",
        "environment",
        "package",
        "rust",
        "impact",
        "inputs",
        "not_applicable",
        "diagnostics",
        "security",
        "coverage",
        "compiler_cache",
    }
    if type(config.get("schema")) is not int or config.get("schema") != 1 or set(config) - allowed:
        raise Invalid("Unsupported project contract version or unknown fields")
    profiles = config.get("profiles", [])
    if (
        not isinstance(profiles, list)
        or not profiles
        or not all(isinstance(x, str) for x in profiles)
        or len(set(profiles)) != len(profiles)
    ):
        raise Invalid("Select a nonempty unique profile list")
    if set(config.get("package", {})) - {"directory", "imports", "commands"}:
        raise Invalid("Unsupported package consumer setting")
    if set(config.get("rust", {})) - {
        "sccache",
        "cache_budget_bytes",
        "cache_min_free_bytes",
        "cache_ttl_seconds",
    }:
        raise Invalid("Unsupported Rust cache setting; native feature/MSRV commands belong in stages/extras")
    if set(config.get("compiler_cache", {})) - {
        "cache_budget_bytes",
        "cache_min_free_bytes",
        "cache_ttl_seconds",
    }:
        raise Invalid("Unsupported native C/C++ compiler cache setting")
    definitions = catalog()
    from .quality import coverage_settings

    coverage_settings(config.get("coverage", {}), definitions)
    for profile, commands in config.get("commands", {}).items():
        if (
            profile not in definitions
            or not isinstance(commands, dict)
            or set(commands) - definitions[profile]["stages"].keys()
        ):
            raise Invalid(f"Unknown profile/native stage override: {profile}")
    for profile, stages in config.get("not_applicable", {}).items():
        if profile not in definitions or not isinstance(stages, dict):
            raise Invalid("Unknown not-applicable profile")
        for stage, reason in stages.items():
            if stage not in definitions[profile].get("waivable_stages", []):
                raise Invalid(f"Mandatory stage cannot be waived: {profile}.{stage}")
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
                raise Invalid("Non-applicability needs a bounded nonempty reason")
            if stage in config.get("commands", {}).get(profile, {}):
                raise Invalid("A stage cannot have both a command and non-applicability")
    if set(config.get("inputs", {})) - {"locks", "manifests"}:
        raise Invalid("Unsupported input selection")
    diagnostics = config.get("diagnostics", {})
    if (
        set(diagnostics) - {"tail_lines"}
        or type(diagnostics.get("tail_lines", 200)) is not int
        or not 0 <= diagnostics.get("tail_lines", 200) <= 1000
    ):
        raise Invalid("Diagnostic tail_lines must be an integer in 0..1000")
    if set(config.get("security", {})) - {"python", "licenses", "engine", "rules", "paths"}:
        raise Invalid("Unsupported native security setting")
    if config.get("security", {}).get("engine", "bandit") not in {"bandit", "semgrep"}:
        raise Invalid("Select an implemented native SAST engine")
    config["_path"] = relative
    return config


def catalog() -> dict:
    return json.loads(Path(__file__).with_name("profiles.json").read_text(encoding="utf-8"))


LOCK_NAMES = {
    "uv.lock",
    "Cargo.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "go.sum",
    "composer.lock",
    "Gemfile.lock",
    "packages.lock.json",
    "pubspec.lock",
    "renv.lock",
    "Package.resolved",
    "gradle.lockfile",
}


def locks(root: Path, contract: dict) -> dict[str, str]:
    from fnmatch import fnmatchcase

    from .impact import matches
    from .model import digest, git

    tracked = [p for p in git(root, "ls-files", "-z").split("\0") if p]
    selected = {p for p in tracked if Path(p).name in LOCK_NAMES or fnmatchcase(Path(p).name, "*.lockfile")}
    for pattern in contract.get("inputs", {}).get("locks", []):
        if not isinstance(pattern, str) or Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise Invalid("Lock selectors must be contained POSIX patterns")
        found = [p for p in tracked if matches(p, pattern)]
        if not found:
            raise Invalid(f"Lock selector has no tracked files: {pattern}")
        selected.update(found)
    result = {}
    for relative in sorted(selected):
        path = root / relative
        if path.is_symlink() or not contained(root, relative, exists=True).is_file():
            raise Invalid(f"Lock must be a tracked regular file: {relative}")
        result[relative] = digest(path)
    return result


def resolve(root: Path, contract: dict, selected: list[str]) -> dict:
    """Resolve native shapes before executing; never invent a manifest to appease defaults."""
    definitions = catalog()
    if set(selected) - definitions.keys():
        raise Invalid(f"Unsupported selected profiles: {sorted(set(selected) - definitions.keys())}")
    for name in selected:
        definition = definitions[name]
        manifests = contract.get("inputs", {}).get("manifests", {}).get(name, definition.get("manifests", []))
        if not isinstance(manifests, list) or any(
            not isinstance(p, str) or not p or Path(p).is_absolute() or ".." in Path(p).parts
            for p in manifests
        ):
            raise Invalid("Native manifests require contained patterns")
        if manifests and not any(
            p.is_file() and not p.is_symlink() for pattern in manifests for p in root.glob(pattern)
        ):
            raise Invalid(f"{name} has no matching native manifest: {manifests}")
        if name == "python" and not (root / "pyproject.toml").is_file():
            for stage in definition["stages"]:
                if stage not in contract.get("commands", {}).get(name, {}) and stage not in contract.get(
                    "not_applicable", {}
                ).get(name, {}):
                    raise Invalid(
                        f"Requirements-only applications need an explicit python.{stage} command or allowed non-applicability"
                    )
        if name in {"typescript-javascript", "web"}:
            package = contained(root, "package.json", exists=True)
            data = json.loads(package.read_text())
            choices = {
                "npm": ["npm-shrinkwrap.json", "package-lock.json"],
                "bun": ["bun.lock", "bun.lockb"],
                "pnpm": ["pnpm-lock.yaml"],
                "yarn": ["yarn.lock"],
            }
            found = {
                manager: [lock for lock in patterns if (root / lock).is_file()]
                for manager, patterns in choices.items()
            }
            found = {k: v for k, v in found.items() if v}
            declared = data.get("packageManager", "")
            manager = declared.partition("@")[0] if declared else next(iter(found), "")
            if manager not in choices or set(found) != {manager}:
                raise Invalid("JavaScript needs one unambiguous native package manager and tracked lock")
            if declared and ("@" not in declared or not declared.partition("@")[2]):
                raise Invalid("packageManager needs its native resolved version")
            definition["locked_inputs"] = found[manager]
            setup = {
                "npm": ["npm", "ci"],
                "bun": ["bun", "install", "--frozen-lockfile"],
                "pnpm": ["pnpm", "install", "--frozen-lockfile"],
                "yarn": ["yarn", "install", "--immutable"]
                if declared.startswith("yarn@") and not declared.startswith("yarn@1.")
                else ["yarn", "install", "--frozen-lockfile"],
            }
            definition["stages"]["setup"] = setup[manager]
            definition["stages"]["toolchain"] = f"node --version && {manager} --version"
            for stage, command in definition["stages"].items():
                if isinstance(command, list) and command[:2] == ["npm", "run"]:
                    definition["stages"][stage] = [manager, "run", *command[2:]]
            if manager != "npm" and "package" in definition["stages"]:
                definition["stages"]["package"] = None
        for lock in definition.get("locked_inputs", []):
            from .model import git

            path = contained(root, lock, exists=True)
            if not path.is_file() or (root / lock).is_symlink() or not git(root, "ls-files", "--", lock):
                raise Invalid(f"{name} needs a tracked native lockfile: {lock}")
    return definitions
