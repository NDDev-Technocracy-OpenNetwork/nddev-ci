"""Native OCI archive builds and digest-preserving publication; no rebuild during promotion."""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import tempfile
import uuid
from contextlib import ExitStack
from pathlib import Path

from .cache import lock, size
from .docker import local_socket
from .model import Invalid, Unavailable, atomic_json, contained, digest, git, identity, source_identity
from .process import run

SKOPEO = "quay.io/skopeo/stable:v1.22.3-immutable@sha256:c0ee1f4edca5c01cb8d5611124f92f3cc47196ecab68aee5d0f90834e00574d5"
BUILDKIT = "moby/buildkit@sha256:98cc6a3fc46220d00f8224ae483f3274fc874e9be8d7dd1e2e2c5481209228b5"


def native(arguments: list[str], root: Path, name: str, *, diagnostics: bool = False) -> str:
    with tempfile.TemporaryDirectory(prefix="nddev-oci-log-") as directory:
        path = Path(directory) / "native.log"
        errors = Path(directory) / "stderr.log"
        result = run(arguments, root, path, timeout=900, stderr_log=errors)
        output = path.read_text()
        if result["status"] != "success":
            raise Invalid(
                f"Native OCI {name} failed (exit {result['exit_code']}): "
                + (output + errors.read_text())[-2000:]
            )
        return output + errors.read_text() if diagnostics else output


def build_options(root: Path, build_args: list[str], cache_from: list[str], cache_to: list[str]) -> list[str]:
    """Allow explicit native options without arbitrary export destinations or secret-bearing URLs."""
    arguments, keys = [], set()
    for value in build_args:
        key, separator, _ = value.partition("=")
        if (
            not separator
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or key in keys
            or any(c in value for c in "\r\n\0")
        ):
            raise Invalid("Build arguments need unique KEY=value entries without control characters")
        if re.search(r"TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY", key, re.IGNORECASE):
            raise Invalid("Sensitive build inputs require a separately selected native BuildKit secret mount")
        keys.add(key)
        arguments.extend(["--build-arg", value])
    for flag, specifications in (("--cache-from", cache_from), ("--cache-to", cache_to)):
        if len(specifications) > 8:
            raise Invalid("Select a bounded native cache backend list")
        for specification in specifications:
            if any(c in specification for c in "\r\n\0"):
                raise Invalid("Cache options cannot contain control characters")
            parts = [part.partition("=") for part in specification.split(",")]
            if any(not separator or not key or not value for key, separator, value in parts) or len(
                {part[0] for part in parts}
            ) != len(parts):
                raise Invalid("Cache options need unique explicit key=value entries")
            options = {key: value for key, _, value in parts}
            backend = options.get("type")
            allowed = {
                "local": {"type", "src", "dest", "mode", "compression", "oci-mediatypes", "image-manifest"},
                "registry": {"type", "ref", "mode", "compression", "oci-mediatypes", "image-manifest"},
                "gha": {"type", "scope", "mode", "version", "timeout"},
            }
            if backend not in allowed or set(options) - allowed[backend]:
                raise Invalid(
                    "Select a supported local/registry/GHA cache backend without credential overrides"
                )
            if options.get("mode", "min") not in {"min", "max"}:
                raise Invalid("Cache export mode must be min or max")
            if backend == "local":
                path_key = "src" if flag == "--cache-from" else "dest"
                if path_key not in options or ({"src", "dest"} - {path_key}) & options.keys():
                    raise Invalid("Local cache import/export needs its own explicit source/destination")
                cache = contained(root, options[path_key])
                if cache == root.resolve() or (root / options[path_key]).is_symlink():
                    raise Invalid("Local caches need a dedicated contained owned directory")
                options[path_key] = str(cache)
            elif backend == "registry":
                if not re.fullmatch(r"[a-z0-9][a-z0-9.:-]*/[a-z0-9_./:-]+", options.get("ref", "")):
                    raise Invalid(
                        "Registry caches need an existing approved repository reference without credentials"
                    )
            else:
                if options.get("version", "2") != "2" or not re.fullmatch(
                    r"[A-Za-z0-9_.-]{1,128}", options.get("scope", "")
                ):
                    raise Invalid("GHA caches require v2 and an explicit project/platform scope")
                timeout = options.get("timeout", "60s")
                if not re.fullmatch(r"[1-9]\d?s|[12]\d\ds|300s", timeout):
                    raise Invalid("GHA cache transfer needs a finite 1..300 second timeout")
                options.update(version="2", timeout=timeout)
                if not os.environ.get("ACTIONS_RUNTIME_TOKEN") or not os.environ.get("ACTIONS_RESULTS_URL"):
                    raise Unavailable("GHA v2 cache requires the caller's native runtime credentials")
            if flag == "--cache-to" and os.environ.get("GITHUB_ACTIONS") == "true":
                if os.environ.get("GITHUB_EVENT_NAME") not in {"push", "workflow_dispatch"}:
                    raise Invalid(
                        "Cache writes require a trusted default-branch push/dispatch; PRs are read-only"
                    )
                try:
                    repository = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["repository"]
                    branch = repository["default_branch"]
                    if (
                        not branch
                        or repository["full_name"] != os.environ["GITHUB_REPOSITORY"]
                        or os.environ.get("GITHUB_REF") != "refs/heads/" + branch
                    ):
                        raise Invalid("Cache writes require the actual caller's trusted default branch")
                except (KeyError, OSError, ValueError) as error:
                    raise Invalid("Native default-branch cache authority is unavailable") from error
            arguments.extend([flag, ",".join(f"{key}={value}" for key, value in options.items())])
    return arguments


def local_exports(options: list[str]) -> list[Path]:
    paths = set()
    for index, flag in enumerate(options[:-1]):
        if flag == "--cache-to":
            specification = dict(part.split("=", 1) for part in options[index + 1].split(","))
            if specification.get("type") == "local":
                paths.add(Path(specification["dest"]))
    return sorted(paths)


def own_export(root: Path, path: Path) -> dict:
    expected = {"schema": 1, "owner": "nddev-cicd-buildcache", "project": str(root.resolve())}
    marker = path / ".nddev-buildcache-owner.json"
    if path.exists():
        if not path.is_dir() or path.is_symlink() or any(p.is_symlink() for p in path.rglob("*")):
            raise Invalid("Local cache exports require a regular dedicated owned directory")
        if any(path.iterdir()) and (not marker.is_file() or json.loads(marker.read_text()) != expected):
            raise Invalid("Do not overwrite an existing unowned local cache or source directory")
    if git(root, "ls-files", "--", path.relative_to(root.resolve()).as_posix()):
        raise Invalid("A cache export cannot overwrite tracked project source")
    return expected


def skopeo(
    arguments: list[str],
    archive: Path | None = None,
    auth: Path | None = None,
    certificates: Path | None = None,
    *,
    daemon=False,
) -> str:
    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise Unavailable("This pinned native OCI SDK surface currently requires Linux x64")
    name = "nddev-oci-sdk-" + uuid.uuid4().hex
    command = ["docker", "run", "--rm", "--name", name, "--network", "host"]
    if archive:
        if not archive.is_file() or archive.is_symlink():
            raise Invalid("OCI input must be an existing regular archive")
        command += ["--volume", str(archive.resolve()) + ":/input/image.oci.tar:ro"]
    if auth:
        if not auth.is_file() or auth.is_symlink() or os.name != "nt" and auth.stat().st_mode & 0o077:
            raise Invalid("Registry auth must be an explicitly private caller-owned regular file")
        command += [
            "--volume",
            str(auth.resolve()) + ":/input/auth.json:ro",
            "--env",
            "REGISTRY_AUTH_FILE=/input/auth.json",
        ]
    if certificates:
        if not certificates.is_dir() or certificates.is_symlink():
            raise Invalid("Declare the existing native registry CA/client-certificate directory")
        command += ["--volume", str(certificates.resolve()) + ":/certificates:ro"]
    if daemon:
        command += ["--volume", str(local_socket()) + ":/var/run/docker.sock"]
    try:
        return native([*command, SKOPEO, *arguments], Path.cwd(), "SDK")
    finally:
        subprocess.run(["docker", "rm", "--force", name], check=False, capture_output=True, timeout=30)


def inspect(archive: Path) -> dict:
    result = json.loads(skopeo(["inspect", "oci-archive:/input/image.oci.tar"], archive))
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", result.get("Digest", "")):
        raise Invalid("Native OCI archive has no immutable image digest")
    return result


def build(
    root: Path,
    output: str,
    *,
    context=".",
    dockerfile="Dockerfile",
    platforms="linux/amd64",
    builder: str | None = None,
    build_args: list[str] | None = None,
    cache_from: list[str] | None = None,
    cache_to: list[str] | None = None,
    cache_budget_bytes: int = 0,
) -> dict:
    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise Unavailable("This pinned OCI build surface currently requires Linux x64")
    root = root.resolve()
    build_args, cache_from, cache_to = build_args or [], cache_from or [], cache_to or []
    options = build_options(root, build_args, cache_from, cache_to)
    exports = local_exports(options)
    if exports and (type(cache_budget_bytes) is not int or cache_budget_bytes < 1024**2):
        raise Invalid("Local cache exports require an explicit byte budget of at least 1MiB")
    for path in exports:
        own_export(root, path)
    context_path, file = contained(root, context, exists=True), contained(root, dockerfile, exists=True)
    if not context_path.is_dir() or not file.is_file():
        raise Invalid("Select an existing native build context and Dockerfile")
    selected = platforms.split(",")
    if not selected or set(selected) - {"linux/amd64", "linux/arm64"}:
        raise Invalid("Select supported Linux OCI platforms with the corresponding native/cross SDK")
    if builder and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", builder):
        raise Invalid("Select a known caller-owned Buildx builder name")
    if any(character in output for character in ("\n", "\r", "\0", ",")):
        raise Invalid("OCI output path cannot contain control characters or Buildx option separators")
    target = contained(root, output)
    if target.exists() or target.with_suffix(".json").exists() or target.with_suffix(".build.log").exists():
        raise Invalid("Do not overwrite a previous build artifact; use an owned fresh output")
    target.parent.mkdir(parents=True, exist_ok=True)
    owner = builder is None
    builder = builder or "nddev-oci-" + uuid.uuid4().hex
    pending = target.with_name("." + target.name + ".pending")
    metadata = target.with_name("." + target.name + ".buildx.json")
    source = source_identity(root)
    failed = False
    locks = ExitStack()
    try:
        for path in sorted(set(exports)):
            locks.enter_context(lock(path.parent / ("." + path.name + ".nddev-cache.lock")))
            expected = own_export(root, path)
            path.mkdir(parents=True, exist_ok=True)
            atomic_json(path / ".nddev-buildcache-owner.json", expected)
        if owner:
            native(
                [
                    "docker",
                    "buildx",
                    "create",
                    "--name",
                    builder,
                    "--driver",
                    "docker-container",
                    "--driver-opt",
                    "image=" + BUILDKIT,
                    "--driver-opt",
                    "memory=2g",
                ],
                root,
                "owned builder setup",
            )
        build_log = native(
            [
                "docker",
                "buildx",
                "build",
                "--builder",
                builder,
                "--file",
                str(file),
                "--platform",
                platforms,
                "--provenance=false",
                "--progress=plain",
                "--label",
                "org.opencontainers.image.revision=" + source["tested_revision"],
                "--metadata-file",
                str(metadata),
                "--output",
                "type=oci,dest=" + str(pending),
                *options,
                str(context_path),
            ],
            root,
            "build",
            diagnostics=True,
        )
        if pending.stat().st_size > 512 * 1024**2:
            raise Invalid("OCI archive exceeds the source artifact's 512MiB transfer budget")
        actual = inspect(pending)
        if actual.get("Labels", {}).get("org.opencontainers.image.revision") != source["tested_revision"]:
            raise Invalid("Built OCI image does not identify the tested source revision")
        cache_bytes = sum(size(path) for path in exports)
        if cache_bytes > cache_budget_bytes:
            raise Invalid(
                "Owned cache exceeds its explicit byte budget; reconcile its retained state before reuse"
            )
        os.replace(pending, target)
        target.with_suffix(".build.log").write_text(build_log[-2 * 1024**2 :])
        record = {
            "schema": 1,
            "archive_sha256": digest(target),
            "digest": actual["Digest"],
            "source": source,
            "platforms": selected,
            "build_argument_names": sorted(value.partition("=")[0] for value in build_args),
            "build_arguments_sha256": identity({"arguments": build_args}),
            "build_log_sha256": digest(target.with_suffix(".build.log")),
            "local_cache_bytes": cache_bytes,
            "observed_platform": {"os": actual.get("Os"), "architecture": actual.get("Architecture")},
            "buildx_version": native(["docker", "buildx", "version"], root, "version").strip(),
            "sdk": {"skopeo": SKOPEO, "buildkit": BUILDKIT if owner else "caller-owned"},
        }
        atomic_json(target.with_suffix(".json"), record)
        return {
            "status": "success",
            "archive": str(target),
            "metadata": str(target.with_suffix(".json")),
            **record,
        }
    except BaseException:
        failed = True
        raise
    finally:
        try:
            pending.unlink(missing_ok=True)
            metadata.unlink(missing_ok=True)
            if owner:
                # Never select/prune the shared/default builder or another job's state.
                cleanup = subprocess.run(
                    ["docker", "buildx", "rm", "--force", builder],
                    check=False,
                    capture_output=True,
                    timeout=30,
                )
                if cleanup.returncode and not failed:
                    raise Invalid("Owned Buildx cleanup failed; reconcile builder " + builder)
        finally:
            locks.close()


def publish(
    archive: Path,
    record: dict,
    expected: dict,
    repository: str,
    *,
    auth: Path | None = None,
    certificates: Path | None = None,
) -> dict:
    if not re.fullmatch(r"[a-z0-9][a-z0-9.:-]*/[a-z0-9_./-]+", repository) or ".." in repository.split("/"):
        raise Invalid(
            "Declare the approved existing registry/repository, without mutable tags or credentials"
        )
    if record.get("schema") != 1 or digest(archive) != record.get("archive_sha256"):
        raise Invalid("OCI archive differs from its checked source metadata")
    for key in ("repository", "tested_revision", "tested_tree", "library_ref", "implementation_digest"):
        if not expected.get(key) or record.get("source", {}).get(key) != expected[key]:
            raise Invalid("OCI build and publication have different source/implementation bindings")
    actual = inspect(archive)
    if (
        actual["Digest"] != record["digest"]
        or actual.get("Labels", {}).get("org.opencontainers.image.revision") != expected["tested_revision"]
    ):
        raise Invalid("Native OCI image identity differs from the tested artifact")
    # Same digest means the same target object; different candidates never race to replace 'latest'.
    destination = repository + ":sha256-" + actual["Digest"].split(":")[1]
    options = ["--dest-cert-dir=/certificates"] if certificates else []
    skopeo(
        [
            "copy",
            "--all",
            "--preserve-digests",
            *options,
            "oci-archive:/input/image.oci.tar",
            "docker://" + destination,
        ],
        archive,
        auth,
        certificates,
    )
    options = ["--cert-dir=/certificates"] if certificates else []
    installed = json.loads(
        skopeo(["inspect", *options, "docker://" + destination], auth=auth, certificates=certificates)
    )
    if installed.get("Digest") != actual["Digest"]:
        raise Invalid("Registry did not preserve the tested OCI digest")
    return {
        "status": "success",
        "image": repository + "@" + actual["Digest"],
        "digest": actual["Digest"],
        "source": expected,
        "publication": "existing registry; no source rebuild",
    }
