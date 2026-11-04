from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Prepared local archive store is POSIX-only")

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("prepared_artifact", ROOT / "scripts/prepared-artifact.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def store(tmp_path, data=b"immutable provider archive"):
    root = tmp_path.resolve() / "store"
    blobs = root / "sha256"
    blobs.mkdir(parents=True, mode=0o755)
    root.chmod(0o755)
    expected = hashlib.sha256(data).hexdigest()
    path = blobs / expected
    path.write_bytes(data)
    path.chmod(0o444)
    return root, expected, path


def test_missing_prepared_state_keeps_native_fallback(tmp_path):
    assert not module.copy_prepared(tmp_path.resolve() / "absent", "0" * 64, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_verified_archive_copies_without_network(tmp_path):
    root, expected, source = store(tmp_path)
    output = tmp_path / "owned-job-file"
    assert module.copy_prepared(root, expected, output, owner_uid=os.getuid())
    assert output.read_bytes() == source.read_bytes()


def test_corrupt_prepared_bytes_preserve_existing_job_file(tmp_path):
    root, expected, source = store(tmp_path)
    source.chmod(0o644)
    source.write_bytes(b"wrong provider bytes")
    source.chmod(0o444)
    output = tmp_path / "job-file"
    output.write_bytes(b"retained")
    with pytest.raises(ValueError, match="SHA-256"):
        module.copy_prepared(root, expected, output, owner_uid=os.getuid())
    assert output.read_bytes() == b"retained"
    assert not list(tmp_path.glob(".prepared-*"))


@pytest.mark.parametrize("kind", ["writable-blob", "writable-store", "symlink"])
def test_unsafe_store_is_explicit_failure(tmp_path, kind):
    root, expected, source = store(tmp_path)
    if kind == "writable-blob":
        source.chmod(0o644)
    elif kind == "writable-store":
        root.chmod(0o777)
    else:
        source.unlink()
        source.symlink_to(tmp_path / "elsewhere")
    with pytest.raises((ValueError, OSError)):
        module.copy_prepared(root, expected, tmp_path / "out", owner_uid=os.getuid())


def test_optional_shell_interface_does_not_require_host_python_when_unused(tmp_path):
    script = 'source "$HELPER"; nddev_prepared_artifact "$EXPECTED" "$DESTINATION"'
    result = subprocess.run(
        ["bash", "-c", script],
        check=False,
        env={
            **os.environ,
            "HELPER": str(ROOT / "scripts/prepared-artifact.sh"),
            "EXPECTED": "0" * 64,
            "DESTINATION": str(tmp_path / "out"),
            "NDDEV_ARTIFACT_CACHE": "",
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert result.stderr == ""
