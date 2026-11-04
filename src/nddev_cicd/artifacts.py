"""Exact tarred artifact bytes/modes and source provenance, without authentication overclaims."""

from __future__ import annotations

import re
import tarfile
from pathlib import Path

from .model import Invalid, atomic_json, contained, digest, identity

FORBIDDEN = {".git", ".env", ".ssh", "node_modules", ".venv", "target", "__pycache__"}
SECRET = re.compile(rb"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}")


def pack(root: Path, files: list[str], archive: Path, provenance: dict) -> dict:
    if not files or not provenance.get("repository") or not provenance.get("tested_revision"):
        raise Invalid("Artifact needs explicit files and actual repository/source identity")
    selected: dict[str, Path] = {}
    for pattern in files:
        if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise Invalid("Artifact selection leaves its source root")
        matched = [p for p in root.glob(pattern) if p.is_file()]
        if not matched:
            raise Invalid(f"Artifact input matched no files: {pattern}")
        for path in matched:
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                raise Invalid("Artifact symlinks/escaping paths are not supported")
            if FORBIDDEN.intersection(Path(relative).parts) or path.name.startswith(".env."):
                raise Invalid(f"Do not publish cache, source-control or credential state: {relative}")
            with path.open("rb") as stream:
                if SECRET.search(stream.read(1024 * 1024)):
                    raise Invalid("Credential-shaped artifact content rejected (content redacted)")
            selected[relative] = path
    entries = {
        relative: {"sha256": digest(path), "mode": path.stat().st_mode & 0o777}
        for relative, path in sorted(selected.items())
    }
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:gz") as tar:
        for relative, path in sorted(selected.items()):
            tar.add(path, arcname=relative, recursive=False)
    manifest = {
        "schema": 1,
        "source": provenance,
        "files": entries,
        "archive_sha256": digest(archive),
        "notice": "Content identity; not an authenticated provenance or SLSA-level assertion",
    }
    manifest["artifact_identity"] = identity(manifest)
    atomic_json(archive.with_suffix(archive.suffix + ".json"), manifest)
    return manifest


def verify(archive: Path, manifest: dict, expected: dict) -> None:
    if manifest.get("schema") != 1 or digest(archive) != manifest.get("archive_sha256"):
        raise Invalid("Artifact archive digest/schema mismatch")
    unsigned = {key: value for key, value in manifest.items() if key != "artifact_identity"}
    if identity(unsigned) != manifest.get("artifact_identity"):
        raise Invalid("Artifact identity does not match its manifest")
    if not expected or not expected.get("repository") or not expected.get("tested_revision"):
        raise Invalid("An expected trusted source binding is required")
    for field, value in expected.items():
        if manifest.get("source", {}).get(field) != value:
            raise Invalid(f"Artifact does not belong to expected source {field}")
    with tarfile.open(archive) as tar:
        records = manifest.get("files", {})
        members = tar.getmembers()
        if not records or len(members) != len(records) or {m.name for m in members} != set(records):
            raise Invalid("Artifact members are absent, duplicated or unexpected")
        import hashlib

        for member in members:
            if not member.isfile() or Path(member.name).is_absolute() or ".." in Path(member.name).parts:
                raise Invalid("Artifact contains a non-file or unsafe member")
            stream = tar.extractfile(member)
            if stream is None:
                raise Invalid("Unreadable artifact member")
            h = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                h.update(chunk)
            if (
                h.hexdigest() != records[member.name]["sha256"]
                or member.mode & 0o777 != records[member.name]["mode"]
            ):
                raise Invalid(f"Artifact member digest/mode mismatch: {member.name}")


def unpack(archive: Path, manifest: dict, destination: Path, expected: dict) -> None:
    verify(archive, manifest, expected)
    if destination.exists() and any(destination.iterdir()):
        raise Invalid("Unpack into a new empty owned directory")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = contained(destination, member.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = tar.extractfile(member)
            assert stream is not None
            with target.open("xb") as output:
                import shutil

                shutil.copyfileobj(stream, output)
            target.chmod(member.mode & 0o777)
