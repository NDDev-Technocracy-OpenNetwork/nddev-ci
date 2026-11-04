"""Only an owned disposable HTTPS registry and its private test CA; no host trust-store changes."""

from __future__ import annotations

import json
import ssl
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

IMAGE = "registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8"


def call(*args: str) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def start(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    name = "nddev-oci-" + uuid.uuid4().hex
    metadata = {"name": name}
    (root / "fixture.json").write_text(json.dumps(metadata))
    try:
        call(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            str(root / "ca.key"),
            "-out",
            str(root / "ca.crt"),
            "-subj",
            "/CN=Owned fixture CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
        )
        call(
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "server.key"),
            "-out",
            str(root / "server.csr"),
            "-subj",
            "/CN=localhost",
        )
        (root / "extension.cnf").write_text(
            "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"
        )
        call(
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "server.csr"),
            "-CA",
            str(root / "ca.crt"),
            "-CAkey",
            str(root / "ca.key"),
            "-CAcreateserial",
            "-out",
            str(root / "server.crt"),
            "-days",
            "1",
            "-extfile",
            str(root / "extension.cnf"),
        )
        certificates = root / "client"
        certificates.mkdir()
        (certificates / "ca.crt").write_bytes((root / "ca.crt").read_bytes())
        call(
            "docker",
            "run",
            "--detach",
            "--name",
            name,
            "--publish",
            "127.0.0.1::5000",
            "--volume",
            str(root) + ":/certificates:ro",
            "--env",
            "REGISTRY_HTTP_TLS_CERTIFICATE=/certificates/server.crt",
            "--env",
            "REGISTRY_HTTP_TLS_KEY=/certificates/server.key",
            IMAGE,
        )
        ports = json.loads(call("docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", name))
        port = ports["5000/tcp"][0]["HostPort"]
        metadata.update(endpoint="127.0.0.1:" + port, certificates=str(certificates))
        context = ssl.create_default_context(cafile=str(root / "ca.crt"))
        last_error = ""
        for _ in range(100):
            try:
                with urllib.request.urlopen(
                    "https://" + metadata["endpoint"] + "/v2/", context=context, timeout=2
                ) as response:
                    if response.status == 200:
                        break
            except OSError as error:
                last_error = str(error)
                time.sleep(0.1)
        else:
            raise RuntimeError(
                "The owned native HTTPS registry did not start: "
                + last_error
                + "\n"
                + call("docker", "logs", name)
            )
        (root / "fixture.json").write_text(json.dumps(metadata))
        return metadata
    except BaseException:
        stop(root)
        raise


def stop(root: Path) -> None:
    path = root / "fixture.json"
    if path.exists():
        name = json.loads(path.read_text())["name"]
        subprocess.run(["docker", "rm", "--force", name], check=False, capture_output=True)
