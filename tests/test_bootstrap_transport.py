"""Exercise the real curl retry boundary over an owned HTTPS fixture."""

import hashlib
import http.server
import io
import os
import platform
import shutil
import ssl
import subprocess
import tarfile
import threading
import time
from pathlib import Path

import pytest


@pytest.mark.skipif(
    platform.system() != "Linux" or not shutil.which("openssl"), reason="Native Linux bootstrap"
)
@pytest.mark.parametrize("installer", ["file", "archive", "uv"])
@pytest.mark.parametrize(
    ("failure_mode", "corrupt"),
    [("status", False), ("status", True), ("timeout", False), ("timeout", True), ("permanent", False)],
)
def test_bootstrap_retries_transport_but_never_integrity(tmp_path, installer, corrupt, failure_mode):
    certificate, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
        ],
        check=True,
        capture_output=True,
    )
    binary = b"#!/usr/bin/env bash\nprintf 'native fixture\\n'\n"
    payload = binary
    if installer in {"archive", "uv"}:
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w:gz") as archive:
            member = tarfile.TarInfo("uv-x86_64-unknown-linux-gnu/uv" if installer == "uv" else "fixture")
            member.size = len(binary)
            archive.addfile(member, io.BytesIO(binary))
        payload = content.getvalue()
    checksum = "0" * 64 if corrupt else hashlib.sha256(payload).hexdigest()
    requests = []
    completed = []
    first_origin = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if failure_mode == "permanent":
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if failure_mode == "timeout" and self.path == "/stalled":
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload[:1])
                self.wfile.flush()
                time.sleep(2)
                return
            unavailable = failure_mode == "status" and len(requests) == 1
            self.send_response(503 if unavailable else 200)
            self.send_header("Content-Length", str(0 if unavailable else len(payload)))
            self.end_headers()
            if not unavailable:
                completed.append(self.path)
                self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("localhost", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"https://localhost:{server.server_port}/fixture"
    origin = None
    origin_thread = None
    if failure_mode == "timeout":

        class Origin(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                if not first_origin:
                    first_origin.append(self.client_address)
                target = "stalled" if self.client_address == first_origin[0] else "complete"
                self.send_response(302)
                self.send_header("Location", f"https://localhost:{server.server_port}/{target}")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        origin = http.server.ThreadingHTTPServer(("localhost", 0), Origin)
        origin.socket = context.wrap_socket(origin.socket, server_side=True)
        origin_thread = threading.Thread(target=origin.serve_forever, daemon=True)
        origin_thread.start()
        url = f"https://localhost:{origin.server_port}/fixture"
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    if installer == "uv":
        source = (scripts / "library-uv.sh").read_text()
        source = source.replace(
            "https://github.com/astral-sh/uv/releases/download/0.13.5/uv-$target.$extension", url
        ).replace("f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f", checksum)
    else:
        source = (scripts / "prepare-linux-tools.sh").read_text().split("capabilities=", 1)[0]
        source += f"install_{installer} '{url}' '{checksum}' fixture\n"
    # Preserve the production retry/per-attempt ratio while exercising a real timeout quickly.
    source = source.replace("--max-time 120", "--max-time 1")
    source = source.replace("--retry-max-time 120", "--retry-max-time 1")
    source = source.replace("--retry-max-time 480", "--retry-max-time 4")
    source = source.replace("limit=120", "limit=1")
    source = source.replace("SECONDS + 480", "SECONDS + 4")
    for helper in ("prepared-artifact.sh", "prepared-artifact.py"):
        shutil.copy2(scripts / helper, tmp_path / helper)
    script = tmp_path / "bootstrap.sh"
    script.write_text(source)
    env = dict(
        os.environ, RUNNER_TEMP=str(tmp_path), CURL_CA_BUNDLE=str(certificate), NDDEV_ARTIFACT_CACHE=""
    )
    try:
        result = subprocess.run(
            ["bash", str(script)], env=env, capture_output=True, text=True, timeout=30, check=False
        )
    finally:
        if origin is not None:
            origin.shutdown()
            origin.server_close()
            assert origin_thread is not None
            origin_thread.join(timeout=5)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert len(requests) == (1 if failure_mode == "permanent" else 2)
    assert len(completed) == (0 if failure_mode == "permanent" else 1)
    assert (result.returncode != 0) is (corrupt or failure_mode == "permanent"), result.stdout + result.stderr
    if installer == "uv" and not corrupt and failure_mode != "permanent":
        # The successful installer deliberately hands its job-owned directory to the caller.
        shutil.rmtree(Path(result.stdout.strip()).parent)
    elif installer != "uv":
        assert (tmp_path / "nddev-native-tools/fixture").exists() is (
            not corrupt and failure_mode != "permanent"
        )
