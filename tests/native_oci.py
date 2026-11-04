"""Native Buildx/OCI publication, TLS and immutable digest acceptance with an actual running image."""

import json
import re
import shutil
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

import oci_fixture
import pytest

from nddev_cicd import oci
from nddev_cicd.model import Invalid, git


def test_actual_owned_layer_cache_reuse_and_native_build_argument(repository):
    root = repository(
        {
            "README.md": "# Owned BuildKit cache fixture\n",
            ".gitignore": "dist/\n.cache/\n..cache.nddev-cache.lock\n",
            ".dockerignore": "dist\n.cache\n",
            "index.html": "native cache fixture",
        }
    )
    dockerfile = Path(__file__).parent / "native/container/Dockerfile"
    (root / "Dockerfile").write_text(
        dockerfile.read_text()
        + '\nARG FIXTURE_MODE=default\nLABEL org.nddev.fixture-mode="${FIXTURE_MODE}"\n'
    )
    git(root, "add", "Dockerfile")
    git(root, "commit", "-qm", "native cache/build-argument fixture")
    cold = oci.build(
        root,
        "dist/cold.oci.tar",
        build_args=["FIXTURE_MODE=verified"],
        cache_to=["type=local,dest=.cache,mode=max"],
        cache_budget_bytes=256 * 1024**2,
    )
    assert oci.inspect(Path(cold["archive"]))["Labels"]["org.nddev.fixture-mode"] == "verified"
    warm = oci.build(
        root,
        "dist/warm.oci.tar",
        build_args=["FIXTURE_MODE=verified"],
        cache_from=["type=local,src=.cache"],
        cache_to=["type=local,dest=.cache,mode=max"],
        cache_budget_bytes=256 * 1024**2,
    )
    log = Path(warm["archive"]).with_suffix(".build.log").read_text()
    copied = re.search(r"(?m)^(#\d+) \[[^\n]+\] COPY(?: --\S+)* index\.html(?:\s|$)", log)
    assert copied and re.search(r"(?m)^" + re.escape(copied[1]) + r" CACHED$", log), log
    assert warm["local_cache_bytes"] > 0
    assert warm["build_arguments_sha256"] == cold["build_arguments_sha256"]


def test_native_oci_archive_publish_digest_and_invalid_build(repository, tmp_path):
    root = repository({"README.md": "# OCI fixture\n", ".gitignore": "dist/\n"})
    shutil.copyfile(Path(__file__).parent / "native/container/Dockerfile", root / "Dockerfile")
    git(root, "add", "Dockerfile")
    git(root, "commit", "-qm", "pinned native container input")
    revision = git(root, "rev-parse", "HEAD")
    (root / "index.html").write_text(revision)
    built = oci.build(root, "dist/image.oci.tar")
    archive = Path(built["archive"])
    record = json.loads(Path(built["metadata"]).read_text())
    fixture = oci_fixture.start(tmp_path / "registry")
    image = "nddev-oci-test:" + uuid.uuid4().hex
    container = None
    try:
        repo = fixture["endpoint"] + "/fixture"
        with pytest.raises(Invalid):
            oci.publish(archive, record, record["source"], repo)
        result = oci.publish(
            archive, record, record["source"], repo, certificates=Path(fixture["certificates"])
        )
        assert result["image"] == repo + "@" + record["digest"]
        repeated = oci.publish(
            archive, record, record["source"], repo, certificates=Path(fixture["certificates"])
        )
        assert repeated["digest"] == result["digest"]
        # The same checked OCI config/layers run; no source rebuild or host TLS exception is used.
        oci.skopeo(
            ["copy", "oci-archive:/input/image.oci.tar", "docker-daemon:" + image], archive, daemon=True
        )
        container = subprocess.check_output(
            ["docker", "run", "--detach", "--publish", "127.0.0.1::8080", image], text=True
        ).strip()
        ports = json.loads(
            subprocess.check_output(
                ["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container], text=True
            )
        )
        endpoint = "http://127.0.0.1:" + ports["8080/tcp"][0]["HostPort"]
        for _ in range(50):
            try:
                with urllib.request.urlopen(endpoint, timeout=2) as response:
                    assert response.read().decode() == revision
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("The actual OCI application did not serve its tested revision")
        corrupt = root / "dist/corrupt.oci.tar"
        corrupt.write_bytes(archive.read_bytes() + b"corrupt")
        with pytest.raises(Invalid, match="checked source metadata"):
            oci.publish(corrupt, record, record["source"], repo, certificates=Path(fixture["certificates"]))
        (root / "Dockerfile").write_text("FROM scratch\nRUN this-native-build-must-fail\n")
        with pytest.raises(Invalid, match="build failed"):
            oci.build(root, "dist/invalid.oci.tar")
    finally:
        if container:
            subprocess.run(["docker", "rm", "--force", container], check=False, capture_output=True)
        subprocess.run(["docker", "image", "rm", image], check=False, capture_output=True)
        oci_fixture.stop(tmp_path / "registry")
