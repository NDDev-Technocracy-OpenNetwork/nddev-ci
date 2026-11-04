"""Prepare release candidates from verified source artifacts, with native SBOM and exact payload closure."""

from __future__ import annotations

import gzip
import json
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path

from . import artifacts
from .model import Invalid, Unavailable, atomic_json, contained, digest, identity
from .process import run


def inspect_payload(payload: Path, root: Path) -> None:
    """Expose actual package metadata to Syft without executing installers or trusting archive paths."""
    shutil.copytree(payload, root / "original")
    expanded = 0
    for file in payload.iterdir():
        target = root / "expanded" / file.name
        if zipfile.is_zipfile(file):
            with zipfile.ZipFile(file) as archive:
                entries = archive.infolist()
                if len(entries) > 20000:
                    raise Invalid("Release package has excessive inventory members")
                for entry in entries:
                    destination = contained(target, entry.filename)
                    if entry.is_dir():
                        continue
                    if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                        raise Invalid("Release archive inventory cannot follow symlinks")
                    expanded += entry.file_size
                    if expanded > 1024**3:
                        raise Invalid("Release package expansion exceeds the 1GiB inventory budget")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)
        elif file.name.endswith((".tar", ".tar.gz", ".tgz", ".crate", ".tar.bz2", ".tar.xz")):
            with tarfile.open(file) as archive:
                entries = archive.getmembers()
                if len(entries) > 20000:
                    raise Invalid("Release package has excessive inventory members")
                for entry in entries:
                    destination = contained(target, entry.name)
                    if entry.isdir():
                        continue
                    if not entry.isfile():
                        raise Invalid("Release archive inventory accepts only regular files/directories")
                    expanded += entry.size
                    if expanded > 1024**3:
                        raise Invalid("Release package expansion exceeds the 1GiB inventory budget")
                    source = archive.extractfile(entry)
                    if source is None:
                        raise Invalid("Release archive inventory member cannot be read")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)


def finalize(directory: Path) -> Path:
    record = json.loads((directory / "release.json").read_text())
    if identity({key: value for key, value in record.items() if key != "release_identity"}) != record.get(
        "release_identity"
    ):
        raise Invalid("Release metadata identity changed")
    if digest(directory / "sbom.spdx.json") != record["sbom_sha256"]:
        raise Invalid("Release SBOM changed after native preparation")
    expected = set(record["files"])
    actual = {p.name for p in (directory / "payload").iterdir()}
    if actual != expected:
        raise Invalid("Release payload closure changed after native preparation")
    for name, item in record["files"].items():
        file = directory / "payload" / name
        if (
            file.is_symlink()
            or not file.is_file()
            or digest(file) != item["sha256"]
            or file.stat().st_mode & 0o777 != item["mode"]
        ):
            raise Invalid("Release payload bytes/modes differ from the verified source artifact")
    files = [*(directory / "payload").iterdir(), directory / "release.json", directory / "sbom.spdx.json"]
    sums = "".join(digest(p) + "  " + p.relative_to(directory).as_posix() + "\n" for p in sorted(files))
    (directory / "SHA256SUMS").write_text(sums)
    files.append(directory / "SHA256SUMS")
    candidate = directory / "candidate.tar.gz"
    with (
        candidate.open("wb") as stream,
        gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode="w") as archive,
    ):
        for path in sorted(files):
            member = tarfile.TarInfo(path.relative_to(directory).as_posix())
            member.size, member.mode, member.mtime, member.uid, member.gid = (
                path.stat().st_size,
                path.stat().st_mode & 0o777,
                0,
                0,
                0,
            )
            with path.open("rb") as content:
                archive.addfile(member, content)
    return candidate


def prepare(archive: Path, manifest: dict, expected: dict, directory: Path, patterns: list[str]) -> dict:
    artifacts.verify(archive, manifest, expected)
    if (
        not isinstance(patterns, list)
        or not patterns
        or not all(
            isinstance(x, str) and x and not Path(x).is_absolute() and ".." not in Path(x).parts
            for x in patterns
        )
    ):
        raise Invalid("Release asset selection requires explicit contained native payload patterns")
    if not shutil.which("syft"):
        raise Unavailable("Release SBOM preparation requires the selected native Syft tool")
    directory.mkdir(parents=True, exist_ok=False)
    payload = directory / "payload"
    payload.mkdir()
    files = {}
    with tempfile.TemporaryDirectory(prefix="nddev-release-") as temporary:
        root = Path(temporary)
        artifacts.unpack(archive, manifest, root, expected)
        for pattern in patterns:
            matches = sorted(p for p in root.glob(pattern) if p.is_file())
            if not matches:
                raise Invalid("Release pattern matched no successful source output: " + pattern)
            for path in matches:
                relative = path.relative_to(root).as_posix()
                if relative not in manifest["files"] or path.is_symlink():
                    raise Invalid("Release assets must be exact regular files from the verified bundle")
                if path.name in files and files[path.name]["source_path"] != relative:
                    raise Invalid("Release native asset basenames must be unambiguous")
                shutil.copy2(path, payload / path.name)
                files[path.name] = {"source_path": relative, **manifest["files"][relative]}
    version_log = directory / "syft-version.log"
    version_result = run(["syft", "version", "--output", "json"], directory, version_log, timeout=30)
    if version_result["status"] != "success":
        raise Invalid("Native Syft version check failed")
    version = json.loads(version_log.read_text())["version"]
    with tempfile.TemporaryDirectory(prefix="nddev-inventory-") as inspection:
        inspect_payload(payload, Path(inspection))
        result = run(
            [
                "syft",
                "scan",
                "dir:" + inspection,
                "--output",
                "spdx-json=" + str(directory / "sbom.spdx.json"),
            ],
            directory,
            directory / "syft.log",
            timeout=300,
            env={
                "SYFT_CHECK_FOR_APP_UPDATE": "false",
                "SYFT_FILE_METADATA_SELECTION": "all",
                "SYFT_PYTHON_SEARCH_REMOTE_LICENSES": "false",
                "SYFT_JAVASCRIPT_SEARCH_REMOTE_LICENSES": "false",
            },
        )
    if result["status"] != "success":
        raise Invalid("Native release SBOM scan failed; no release candidate is established")
    sbom = json.loads((directory / "sbom.spdx.json").read_text())
    if (
        not sbom.get("spdxVersion", "").startswith("SPDX-")
        or not sbom.get("documentNamespace")
        or not sbom.get("SPDXID")
    ):
        raise Invalid("Native Syft output is not an identifiable SPDX document")
    record = {
        "schema": 1,
        "source": expected,
        "artifact_identity": manifest["artifact_identity"],
        "files": files,
        "syft_version": version,
        "sbom_sha256": digest(directory / "sbom.spdx.json"),
        "scope": "The SBOM inventories every selected released payload; generated verification metadata is separate.",
        "authentication": "Content preparation only; GitHub-native attestations are a separate eligible workflow step.",
    }
    record["release_identity"] = identity(record)
    atomic_json(directory / "release.json", record)
    candidate = finalize(directory)
    return {
        "status": "success",
        "directory": str(directory),
        "candidate": str(candidate),
        "sbom": str(directory / "sbom.spdx.json"),
        "release_identity": record["release_identity"],
        "candidate_sha256": digest(candidate),
        "packages": len(sbom.get("packages", [])),
        "syft_version": version,
    }
