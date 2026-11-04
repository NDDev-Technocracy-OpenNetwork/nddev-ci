"""Bounded native central preparation; uv still owns selection, resolution and installation.

This module is also loaded before the package has distribution metadata. Keep it stdlib-only.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


class InvalidUV(ValueError):
    """The selected transport cannot safely prepare this native invocation."""


def central_index(environment: dict) -> str | None:
    value = environment.get("NDDEV_UV_CENTRAL_INDEX")
    if value is None:
        return None
    if not isinstance(value, str) or not value or any(c.isspace() for c in value):
        raise InvalidUV("NDDEV_UV_CENTRAL_INDEX must name one explicit central public index")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise InvalidUV("Central uv index must be HTTPS or loopback HTTP without embedded credentials")
    # A private/index override must not silently become a different credential route.
    if any(
        environment.get(key)
        for key in (
            "UV_INDEX",
            "UV_INDEX_URL",
            "UV_DEFAULT_INDEX",
            "UV_EXTRA_INDEX_URL",
            "UV_FIND_LINKS",
            "UV_NO_INDEX",
            "UV_CONFIG_FILE",
            "UV_PROJECT",
            "UV_WORKING_DIR",
            "UV_NO_SOURCES",
            "UV_BUILD_CONSTRAINT",
            "UV_NO_BUILD_ISOLATION",
            "UV_NO_BUILD_ISOLATION_PACKAGE",
        )
    ):
        raise InvalidUV("Central uv preparation does not admit additional index, source or project overrides")
    return value


@dataclass
class Invocation:
    command: str
    original: list[str]
    directory: Path
    project: Path
    selection: list[str] = field(default_factory=list)
    python: str | None = None
    offline: bool = False
    inexact: bool = False
    no_sync: bool = False
    program_index: int | None = None


_SELECTION_VALUES = {"--group", "--no-group", "--only-group", "--extra", "--no-extra", "--package"}
_SELECTION_FLAGS = {
    "--no-dev",
    "--only-dev",
    "--all-groups",
    "--no-default-groups",
    "--all-extras",
    "--all-packages",
    "--no-editable",
}
_OMIT = {
    "--no-install-project": "--no-emit-project",
    "--no-install-workspace": "--no-emit-workspace",
    "--no-install-local": "--no-emit-local",
    "--no-install-package": "--no-emit-package",
    "--no-editable-package": "--no-editable-package",
}


def invocation(arguments: list[str], cwd: Path) -> Invocation:
    """Recognize the admitted project interface, never consume the executed program's arguments."""
    result = Invocation("", arguments, cwd, cwd)
    selected_project = None
    position = 0
    while position < len(arguments):
        word = arguments[position]
        option, equals, attached = word.partition("=")
        if not option.startswith("-"):
            if not result.command:
                result.command = option
                position += 1
                if option not in {"run", "sync"}:
                    break
                continue
            if result.command == "run":
                result.program_index = position
                break
            raise InvalidUV("Unexpected positional argument in central uv sync")
        if option == "--":
            break
        if result.command == "run" and option in {"-m", "--module"}:
            result.program_index = position + 1
            break
        values = _SELECTION_VALUES | {"--project", "--directory", "-C", "--python", "-p", "--color"}
        values |= {"--no-install-package", "--no-editable-package"}
        if option in values:
            if not equals:
                position += 1
                if position == len(arguments):
                    raise InvalidUV("Missing native uv option value")
                attached = arguments[position]
            if option in _SELECTION_VALUES or option in _OMIT:
                result.selection.extend([_OMIT.get(option, option), attached])
            elif option == "--project":
                selected_project = attached
            elif option in {"--directory", "-C"}:
                result.directory = (cwd / attached).resolve()
            elif option in {"--python", "-p"}:
                result.python = attached
        elif option in _SELECTION_FLAGS or option in _OMIT:
            result.selection.append(_OMIT.get(option, option))
        elif option in {
            "--locked",
            "--frozen",
            "--no-python-downloads",
            "--no-progress",
            "--quiet",
            "-q",
            "--verbose",
            "-v",
        }:
            pass
        elif option == "--offline":
            result.offline = True
        elif option in {"--inexact", "--exact"}:
            result.inexact = option == "--inexact"
        elif option == "--no-sync":
            result.no_sync = True
        elif option in {"--version", "-V", "--help", "-h"}:
            result.command = "help"
            break
        else:
            raise InvalidUV("Unsupported central uv option; no public transport was selected")
        position += 1
    result.project = (result.directory / (selected_project or "")).resolve()
    if result.command == "run" and "--exact" not in arguments[:position]:
        result.inexact = True
    return result


def _toml(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise InvalidUV("Central uv preparation needs bounded existing native manifests and lock")
    try:
        return tomllib.loads(path.read_text())
    except (ValueError, UnicodeError) as error:
        raise InvalidUV("Native uv input is not valid TOML") from error


def _local(root: Path, value: str, base: Path | None = None) -> Path:
    path = ((base or root) / value).resolve()
    if not path.is_relative_to(root) or not path.is_dir():
        raise InvalidUV("Unqualified local source outside the native workspace")
    return path


def _static_hatch(root: Path, settings: dict) -> bool:
    """Admit the existing package-directory mapping, without hooks or dynamic inputs."""
    if not settings:
        return True
    if set(settings) != {"build"}:
        return False
    build = settings["build"]
    if not isinstance(build, dict) or set(build) != {"targets"}:
        return False
    targets = build["targets"]
    if not isinstance(targets, dict) or set(targets) != {"wheel"}:
        return False
    wheel = targets["wheel"]
    if not isinstance(wheel, dict) or set(wheel) != {"packages"}:
        return False
    packages = wheel["packages"]
    if not isinstance(packages, list) or not packages:
        return False
    return all(isinstance(value, str) and _local(root, value).is_dir() for value in packages)


def build_constraints(root: Path) -> str | None:
    """Forward explicit native build hashes; uv owns isolated backend resolution."""
    settings = _toml(root / "pyproject.toml").get("tool", {}).get("uv", {})
    if settings.get("require-build-hashes") is not True:
        return None
    constraints = settings.get("build-constraint-dependencies")
    if not isinstance(constraints, list) or not constraints:
        raise InvalidUV("Central source builds require exact native build constraints with hashes")
    lines = []
    for item in constraints:
        if not isinstance(item, dict) or set(item) != {"requirement", "hashes"}:
            raise InvalidUV("Central build constraints require explicit pinned requirements and hashes")
        requirement, hashes = item["requirement"], item["hashes"]
        if (
            not isinstance(requirement, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.!+_-]*", requirement)
            or not isinstance(hashes, list)
            or not hashes
            or any(
                not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value)
                for value in hashes
            )
        ):
            raise InvalidUV("Central build constraints require exact versions and SHA-256 hashes")
        lines.append(requirement + " " + " ".join("--hash=" + value for value in hashes))
    return "\n".join(lines) + "\n"


def qualified_lock(root: Path) -> dict[Path, bytes]:
    """Admit public PyPI plus qualified in-workspace backends before any online operation.

    uv, not this check, owns graph/group/marker selection. Refuse an unqualified closure even if
    a currently unselected optional dependency happens to contain the unsupported source.
    """
    lock = root / "uv.lock"
    data = _toml(lock)
    _toml(root / "pyproject.toml")
    originals = {lock: lock.read_bytes(), root / "pyproject.toml": (root / "pyproject.toml").read_bytes()}
    for package in data.get("package", []):
        source = package.get("source", {})
        if source == {"registry": "https://pypi.org/simple"}:
            continue
        if len(source) != 1 or not set(source) <= {"virtual", "editable", "directory"}:
            raise InvalidUV("Central uv preparation has no qualified direct, VCS or private source closure")
        path = _local(root, next(iter(source.values())))
        manifest = path / "pyproject.toml"
        project = _toml(manifest)
        originals[manifest] = manifest.read_bytes()
        uv = project.get("tool", {}).get("uv", {})
        if any(key in uv for key in ("index", "find-links", "extra-index-url", "index-url", "default-index")):
            raise InvalidUV("Additional project indexes require separate central transport qualification")
        build = project.get("build-system")
        if build is not None:
            backend = {"uv_build": r"uv[_-]build", "hatchling.build": "hatchling"}.get(
                build.get("build-backend")
            )
            if (
                backend is None
                or "backend-path" in build
                or len(build.get("requires", [])) != 1
                or not re.fullmatch(
                    backend + r"(?:\s*(?:[<>=!~]=?)[\d.*]+(?:\s*,\s*(?:[<>=!~]=?)[\d.*]+)*)?",
                    build["requires"][0],
                )
                or (
                    backend == "hatchling"
                    and (
                        not _static_hatch(path, project.get("tool", {}).get("hatch", {}))
                        or project.get("project", {}).get("dynamic")
                    )
                )
            ):
                raise InvalidUV(
                    "Local build backend is outside the qualified static uv_build/hatchling closure"
                )
    if not data.get("package"):
        raise InvalidUV("Central uv preparation needs a nonempty native lock")
    return originals


def prepare(frontend: Path, request: Invocation, environment: dict, index: str) -> None:
    """Prepare exact selected dependencies through central, then validate canonical locked offline."""
    native_environment = {**environment, "UV_PYTHON_DOWNLOADS": "never"}

    def native(*args: str, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(
            [str(frontend), *args],
            cwd=request.directory,
            env=native_environment,
            stdout=subprocess.PIPE if capture else sys.stderr,
            stderr=subprocess.PIPE if capture and not check else sys.stderr,
            text=True,
            check=False,
        )
        if check and result.returncode:
            raise subprocess.CalledProcessError(result.returncode, [str(frontend), *args])
        return result

    workspace = native("workspace", "dir", "--offline", "--project", str(request.project), capture=True)
    root = Path(workspace.stdout.strip()).resolve()
    originals = qualified_lock(root)
    constraints = build_constraints(root)
    context = ["--project", str(request.project)]
    try:
        # Native export owns extras/groups/workspace membership and retains all lock hashes.
        exported = native(
            "export",
            "--frozen",
            "--offline",
            *context,
            *request.selection,
            "--no-emit-local",
            "--no-emit-index-url",
            "--no-header",
            capture=True,
        ).stdout
        local_plan = tomllib.loads(
            native(
                "export",
                "--frozen",
                "--offline",
                *context,
                *request.selection,
                "--format",
                "pylock.toml",
                "--no-header",
                capture=True,
            ).stdout
        )
        selected_python = native(
            "python",
            "find",
            "--offline",
            "--no-python-downloads",
            *context,
            *([request.python] if request.python else []),
            capture=True,
        ).stdout.strip()
        if not Path(selected_python).is_absolute():
            raise InvalidUV("Central uv preparation needs a prepared native interpreter")
        # Ask the existing frontend for its environment placement; never recreate its namespace hash.
        probe = native(
            "run",
            "--no-sync",
            "--offline",
            *context,
            "--python",
            selected_python,
            "--",
            sys.executable,
            "-I",
            "-c",
            "import os; print(os.environ['UV_PROJECT_ENVIRONMENT'])",
            capture=True,
        )
        target = Path(probe.stdout.strip())
        if not target.is_absolute():
            raise InvalidUV("Native uv frontend supplied no absolute project environment")
        sync_selection = [
            next((k for k, v in _OMIT.items() if v == word), word) for word in request.selection
        ]
        canonical = ["sync", "--locked", "--offline", *context, *sync_selection, "--python", selected_python]
        if request.inexact:
            canonical.append("--inexact")
        exists = (target / "pyvenv.cfg").exists()
        compatible = False
        if exists:
            base = subprocess.run(
                [str(target / "bin/python"), "-I", "-c", "import sys; print(sys._base_executable)"],
                env=native_environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if base.returncode or not base.stdout.strip():
                raise InvalidUV("Existing project interpreter could not be identified")
            compatible = Path(base.stdout.strip()).resolve() == Path(selected_python).resolve()
        # Keep warm outage reuse only for the requested interpreter. Native uv owns recreation.
        if compatible and native(*canonical, "--check", capture=True, check=False).returncode == 0:
            return
        if not compatible:
            native(
                "venv",
                *(["--clear"] if exists else []),
                "--offline",
                "--python",
                selected_python,
                str(target),
            )
        python = str(target / "bin/python")
        # Anonymous native pip preparation ignores config discovery; lock qualification above
        # refuses private sources instead of stealing their credential/index precedence.
        transport = ["--default-index", index, "--no-config", "--no-python-downloads"]
        if request.offline or environment.get("UV_OFFLINE", "").lower() in {"1", "true"}:
            transport.append("--offline")
        with tempfile.TemporaryDirectory(prefix="nddev-central-uv-") as directory:
            requirements = Path(directory) / "requirements.txt"
            requirements.write_text(exported)
            if constraints is not None:
                build_file = Path(directory) / "build-constraints.txt"
                build_file.write_text(constraints)
                transport.extend(["--build-constraint", str(build_file), "--require-build-hashes"])
            operation = ["pip", "install", "--requirements"] if request.inexact else ["pip", "sync"]
            native(
                *operation,
                str(requirements),
                "--python",
                python,
                "--require-hashes",
                *(["--only-binary", ":all:"] if constraints is None else []),
                *transport,
            )
            for package in local_plan.get("packages", []):
                if "directory" not in package:
                    continue
                item = package["directory"]
                source = _local(root, item["path"], request.directory)
                args = ["pip", "install", "--python", python, "--no-deps", *transport]
                if item.get("editable"):
                    args.append("--editable")
                native(*args, str(source))
        native(*canonical)
    finally:
        if any(path.read_bytes() != original for path, original in originals.items()):
            raise InvalidUV("Native uv preparation changed an original source manifest or lock")


def execute(arguments: list[str], environment: dict) -> int:
    """The canonical bootstrap bridge, not an alternative cache or package manager."""
    index = central_index(environment)
    if index is None:
        raise InvalidUV("The central uv bridge requires an explicit central index selection")
    frontend = Path(environment["NDS_CACHE_FRONTENDS"]) / "uv"
    request = invocation(arguments, Path.cwd())
    if request.command in {"run", "sync"}:
        if not request.no_sync:
            prepare(frontend, request, environment, index)
    elif request.command not in {"help", "export", "workspace", "python", "venv", "pip", "build"}:
        raise InvalidUV("This uv operation has no qualified central preparation")
    # Non-project pip/build operations consume only already prepared native inputs. They cannot
    # silently resolve new packages through a public or private origin. Do not leak UV_OFFLINE into
    # a program executed by uv run: its own caller-owned subprocesses retain their environment.
    forwarded = arguments[:]
    if request.program_index is not None:
        forwarded.insert(request.program_index, "--")
    command = [str(frontend), "--offline", "--no-python-downloads", *forwarded]
    if request.command == "export":
        command.append("--frozen")
    return subprocess.call(command, env=environment)
