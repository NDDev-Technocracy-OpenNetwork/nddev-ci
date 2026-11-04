"""Native built-package/Syft acceptance; signed provenance is additionally exercised on GitHub."""

import json
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

from nddev_cicd import artifacts, release
from nddev_cicd.model import Invalid, digest, git, source_identity


def test_release_candidate_native_sbom_modes_and_tamper_rejection(repository, tmp_path):
    root = repository({"README.md": "# Native release fixture\n", ".gitignore": "dist/\n.venv/\n"})
    fixture = Path(__file__).parent / "native/python"
    shutil.copytree(
        fixture,
        root,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", "dist", ".git"),
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "native package source")
    subprocess.run(
        ["uv", "build", "--project", str(root), "--out-dir", str(root / "dist")],
        check=True,
        capture_output=True,
    )
    executable = root / "dist/fixture-cli"
    executable.write_text("#!/bin/sh\nprintf 'native release fixture\\n'\n")
    executable.chmod(0o755)
    expected = source_identity(root)
    archive = tmp_path / "checked.tar.gz"
    manifest = artifacts.pack(root, ["dist/*"], archive, expected)
    out = tmp_path / "release"
    result = release.prepare(archive, manifest, expected, out, ["dist/*"])
    sbom = json.loads((out / "sbom.spdx.json").read_text())
    assert any(p.get("name") == "ciwf-fixture" for p in sbom["packages"])
    assert result["status"] == "success" and result["packages"] > 0
    candidate = Path(result["candidate"])
    before = digest(candidate)
    assert digest(release.finalize(out)) == before
    with tarfile.open(candidate) as contents:
        assert contents.getmember("payload/fixture-cli").mode == 0o755
        assert "sbom.spdx.json" in contents.getnames() and "SHA256SUMS" in contents.getnames()
    wheel = next((out / "payload").glob("*.whl"))
    wheel.write_bytes(wheel.read_bytes() + b"tampering")
    with pytest.raises(Invalid, match="bytes/modes"):
        release.finalize(out)
