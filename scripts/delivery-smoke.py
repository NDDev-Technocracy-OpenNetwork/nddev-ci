"""Prepare a separate owned SSH server; deliver the exact successful main artifact remotely."""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

from nddev_cicd.github import authorized_revision, eligible

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
import oci_fixture
import ssh_fixture

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("operation", choices=["prepare", "finish", "cleanup"])
parser.add_argument("directory", type=Path)
args = parser.parse_args()
root = args.directory.resolve()
if args.operation == "cleanup":
    oci_fixture.stop(root / "registry")
    ssh_fixture.stop(root / "server")
elif args.operation == "prepare":
    root.mkdir(exist_ok=False)
    repository = os.environ["GITHUB_REPOSITORY"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    source_run = event["workflow_run"]["id"]
    revision = authorized_revision(source_run, ".github/workflows/main-ci.yml")
    eligible(repository, source_run, revision, ".github/workflows/main-ci.yml")
    fixture = ssh_fixture.start(root / "server")
    registry = oci_fixture.start(root / "registry")
    config = {
        "module": "static-web",
        "target_directory": fixture["target"],
        "generation": 1,
        "expected_previous": None,
        "entrypoint": "dist/target-fixture/index.html",
        "health_url": "http://127.0.0.1:8080/current/dist/target-fixture/",
    }
    (root / "target.json").write_text(json.dumps(config))
    (root / "transport.json").write_text(json.dumps(fixture["transport"]))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        print("run_id=" + str(source_run), file=output)
        print("target=" + str(root / "target.json"), file=output)
        print("transport=" + str(root / "transport.json"), file=output)
        print("oci_repository=" + registry["endpoint"] + "/fixture", file=output)
        print("oci_certificates=" + registry["certificates"], file=output)
else:
    fixture = json.loads((root / "server/fixture.json").read_text())
    try:
        with urllib.request.urlopen(fixture["http_url"] + "/.nddev-deployment.json", timeout=5) as response:
            state = json.load(response)
        if state.get("status") != "success" or state.get("pending"):
            raise RuntimeError("The separate SSH target did not accept this artifact")
        with urllib.request.urlopen(
            fixture["http_url"] + "/current/dist/target-fixture/", timeout=5
        ) as response:
            if state["revision"] not in response.read().decode():
                raise RuntimeError("The remote server does not serve the tested revision")
        registry = json.loads((root / "registry/fixture.json").read_text())
        published = os.environ["NDDEV_PUBLISHED_IMAGE"]
        digest = os.environ["NDDEV_PUBLISHED_DIGEST"]
        if published != registry["endpoint"] + "/fixture@" + digest:
            raise RuntimeError("Published OCI reference does not identify the selected target")
        context = ssl.create_default_context(cafile=str(root / "registry/client/ca.crt"))
        request = urllib.request.Request(
            "https://" + registry["endpoint"] + "/v2/fixture/manifests/" + digest,
            headers={
                "Accept": "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"
            },
        )
        with urllib.request.urlopen(request, context=context, timeout=10) as response:
            if response.headers.get("Docker-Content-Digest") != digest:
                raise RuntimeError("The actual registry manifest differs from the verified artifact")
        print(
            json.dumps(
                {
                    "status": "success",
                    "artifact": state["artifact"],
                    "tested_revision": state["revision"],
                    "integrated_revision": authorized_revision(
                        json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["workflow_run"]["id"],
                        ".github/workflows/main-ci.yml",
                    ),
                    "target": "separate isolated SSH server/filesystem; no production deployment",
                }
            )
        )
    finally:
        oci_fixture.stop(root / "registry")
        ssh_fixture.stop(root / "server")
