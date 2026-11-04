"""Real isolated delivery fixtures. Run explicitly; no production target or account is used."""

from __future__ import annotations

import contextlib
import email.parser
import functools
import hashlib
import http.server
import json
import multiprocessing
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import urllib.request
import uuid
from pathlib import Path

import pytest

from nddev_cicd import artifacts, cache, delivery
from nddev_cicd.model import Invalid, git, source_identity


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextlib.contextmanager
def web(directory):
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def execute_candidate(archive, manifest, source, settings, output):
    try:
        delivery.apply(Path(archive), manifest, source, settings, authorized=True)
        output.put("success")
    except Invalid:
        output.put("stale")


def test_real_target_serialization(repository, tmp_path):
    root = repository({"input.txt": "first", ".gitignore": "public/\n"})
    public = root / "public"
    public.mkdir()
    candidates = []
    for version in (1, 2):
        if version == 2:
            (root / "input.txt").write_text("second")
            git(root, "add", ".")
            git(root, "commit", "-qm", "second candidate")
        source = source_identity(root)
        (public / "index.html").write_text("fixture " + source["tested_revision"])
        archive = tmp_path / f"candidate-{version}.tar.gz"
        manifest = artifacts.pack(root, ["public/index.html"], archive, source)
        candidates.append((archive, manifest, source))
    target = tmp_path / "target"
    target.mkdir()
    with web(target / "current/public") as url:
        settings = {
            "module": "static-web",
            "target_directory": str(target),
            "generation": 1,
            "expected_previous": None,
            "entrypoint": "public/index.html",
            "health_url": url,
        }
        context = multiprocessing.get_context("spawn")
        output = context.Queue()
        processes = [
            context.Process(target=execute_candidate, args=(*candidate, settings, output))
            for candidate in candidates
        ]
        for process in processes:
            process.start()
        outcomes = [output.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(timeout=30)
            assert process.exitcode == 0
        assert sorted(outcomes) == ["stale", "success"]
        state = json.loads((target / ".nddev-deployment.json").read_text())
        assert state["generation"] == 1 and state["pending"] is False
        assert state["artifact"] in [candidate[1]["artifact_identity"] for candidate in candidates]
        assert state["revision"] in (target / "current/public/index.html").read_text()


def test_separate_targets_do_not_share_a_deployment_lock(repository, tmp_path):
    root = repository({"input.txt": "independent targets"})
    source = source_identity(root)
    (root / "index.html").write_text(source["tested_revision"])
    archive = tmp_path / "site.tar.gz"
    manifest = artifacts.pack(root, ["index.html"], archive, source)
    targets = [tmp_path / "first", tmp_path / "second"]
    for target in targets:
        target.mkdir()
    context = multiprocessing.get_context("spawn")
    queues = [context.Queue(), context.Queue()]
    processes = []
    with contextlib.ExitStack() as resources:
        settings = [
            {
                "module": "static-web",
                "target_directory": str(target),
                "generation": 1,
                "expected_previous": None,
                "health_url": resources.enter_context(web(target / "current")),
            }
            for target in targets
        ]
        with cache.lock(targets[0] / ".nddev-deploy.lock"):
            for index in range(2):
                process = context.Process(
                    target=execute_candidate, args=(archive, manifest, source, settings[index], queues[index])
                )
                processes.append(process)
                process.start()
            assert queues[1].get(timeout=20) == "success"
            assert not (targets[0] / ".nddev-deployment.json").exists()
        assert queues[0].get(timeout=20) == "success"
        for process in processes:
            process.join(timeout=20)
            assert process.exitcode == 0


def test_real_python_registry_publish_and_consumer(repository, tmp_path, monkeypatch):
    fixture = Path(__file__).with_name("native") / "python"
    files = {
        relative: (fixture / relative).read_text()
        for relative in git(fixture, "ls-files", "-z", "--", ".").split("\0")
        if relative
    }
    root = repository(files)
    subprocess.run(["uv", "build", "--project", str(root)], check=True, capture_output=True)
    wheel = next((root / "dist").glob("*.whl"))
    expected = hashlib.sha256(wheel.read_bytes()).hexdigest()
    received = {}

    class Registry(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"]))
            message = email.parser.BytesParser().parsebytes(
                ("Content-Type: " + self.headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode()
                + data
            )
            for part in message.walk():
                if part.get_param("name", header="content-disposition") == "content":
                    value = part.get_payload(decode=True)
                    assert hashlib.sha256(value).hexdigest() == expected
                    received[wheel.name] = value
            self.send_response(200 if received else 400)
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/simple/"):
                value = f'<a href="/files/{wheel.name}#sha256={expected}">{wheel.name}</a>'.encode()
            elif self.path == "/files/" + wheel.name:
                value = received[wheel.name]
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "text/html" if self.path.startswith("/simple/") else "application/octet-stream",
            )
            self.send_header("Content-Length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)

    certificate, key = tmp_path / "certificate.pem", tmp_path / "key.pem"
    authority, authority_key = tmp_path / "ca.pem", tmp_path / "ca-key.pem"
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
            "-keyout",
            str(authority_key),
            "-out",
            str(authority),
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
        ],
        check=True,
        capture_output=True,
    )
    request = tmp_path / "server.csr"
    extensions = tmp_path / "leaf.ext"
    extensions.write_text(
        "basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(request),
            "-subj",
            "/CN=localhost",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(request),
            "-CA",
            str(authority),
            "-CAkey",
            str(authority_key),
            "-CAcreateserial",
            "-days",
            "1",
            "-out",
            str(certificate),
            "-extfile",
            str(extensions),
        ],
        check=True,
        capture_output=True,
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Registry)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(certificate, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    registry = f"https://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("SSL_CERT_FILE", str(authority))
    monkeypatch.setenv("UV_PUBLISH_USERNAME", "fixture")
    monkeypatch.setenv("UV_PUBLISH_PASSWORD", secrets.token_urlsafe(24))
    source = source_identity(root)
    archive = tmp_path / "package.tar.gz"
    manifest = artifacts.pack(root, [str(wheel.relative_to(root))], archive, source)
    target = tmp_path / "registry-target"
    target.mkdir()
    try:
        result = delivery.apply(
            archive,
            manifest,
            source,
            {
                "module": "packages",
                "publisher": "python",
                "package_file": str(wheel.relative_to(root)),
                "registry": registry,
                "target_directory": str(target),
                "generation": 1,
                "expected_previous": None,
            },
            authorized=True,
        )
        assert result["status"] == "success" and received[wheel.name] == wheel.read_bytes()
        environment = tmp_path / "consumer"
        subprocess.run(["uv", "venv", str(environment)], check=True)
        python = environment / "bin/python"
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "--index-url",
                registry + "/simple/",
                "--no-deps",
                "ciwf-fixture",
            ],
            check=True,
        )
        subprocess.run(
            [str(python), "-I", "-c", "import ciwf_fixture; assert ciwf_fixture.checksum('ci') == 204"],
            cwd=tmp_path,
            check=True,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_real_systemd_service_activation(repository, tmp_path):
    if os.environ.get("NDDEV_SYSTEMD_FIXTURE") != "user":
        pytest.fail("Select an authorized existing user systemd manager explicitly")
    root = repository({"input.txt": "native service"})
    source = source_identity(root)
    (root / "serve").write_text(
        "#!/usr/bin/env python3\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nimport sys\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write("
        + repr(source["tested_revision"].encode())
        + ")\nHTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()\n"
    )
    (root / "serve").chmod(0o755)
    archive = tmp_path / "service.tar.gz"
    manifest = artifacts.pack(root, ["serve"], archive, source)
    target = tmp_path / "target"
    target.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    name = "nddev-std0004-fixture-" + uuid.uuid4().hex + ".service"
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    unit = units / name
    assert not unit.exists()
    unit.write_text(
        f"[Unit]\nDescription=Temporary STD-0004 native fixture\n[Service]\nExecStart={target}/current/serve {port}\nType=simple\n"
    )
    try:
        settings = {
            "module": "systemd-binary",
            "service": name,
            "user_service": True,
            "target_directory": str(target),
            "generation": 1,
            "expected_previous": None,
            "health_url": f"http://127.0.0.1:{port}/",
        }
        assert delivery.apply(archive, manifest, source, settings, authorized=True)["status"] == "success"
        assert (target / "current/serve").stat().st_mode & 0o111
    finally:
        subprocess.run(["systemctl", "--user", "stop", name], check=False)
        unit.unlink()
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "reset-failed", name], check=False, capture_output=True)


@pytest.mark.parametrize("format", ["apk", "aab"])
def test_real_mobile_artifact_delivery(tmp_path, format):
    apk = Path(os.environ["NDDEV_ANDROID_APK"]).with_suffix("." + format)
    result_path = apk.parent.parent / "result.json"
    result = json.loads(result_path.read_text())
    assert result["status"] == "success"
    assert any(
        row["name"] == "android-kotlin.build" and row["status"] == "success" for row in result["results"]
    )
    source = result["identity"]
    root = tmp_path / "source"
    root.mkdir()
    shutil.copyfile(apk, root / ("fixture." + format))
    assert delivery.mobile_format(root / ("fixture." + format))["validator"] == (
        "apkanalyzer" if format == "apk" else "bundletool"
    )
    archive = tmp_path / "mobile.tar.gz"
    manifest = artifacts.pack(root, ["fixture." + format], archive, source)
    target = tmp_path / "target"
    target.mkdir()
    receipt = delivery.apply(
        archive,
        manifest,
        source,
        {
            "module": "mobile-artifacts",
            "target_directory": str(target),
            "generation": 1,
            "expected_previous": None,
            "mobile_files": ["fixture." + format],
        },
        authorized=True,
    )
    assert receipt["status"] == "success" and receipt["boundary"].startswith("artifact-delivery")
    assert (
        target / ".nddev-releases" / receipt["artifact"] / ("fixture." + format)
    ).read_bytes() == apk.read_bytes()
    import zipfile

    invalid = root / ("invalid." + format)
    with zipfile.ZipFile(invalid, "w") as fake:
        fake.writestr(
            "AndroidManifest.xml" if format == "apk" else "base/manifest/AndroidManifest.xml",
            b"arbitrary text",
        )
    with pytest.raises(Invalid):
        delivery.mobile_format(invalid)


def test_real_compose_immutable_image_and_health(repository, tmp_path):
    import time

    import yaml

    root = repository({"input.txt": "native compose fixture"})
    source = source_identity(root)
    project = "nddev-fixture-" + uuid.uuid4().hex[:16]
    registry_image = "registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8"
    registry = subprocess.check_output(
        ["docker", "run", "--detach", "--publish", "127.0.0.1::5000", registry_image], text=True
    ).strip()
    target = tmp_path / "target"
    target.mkdir()
    compose_path, image = None, None
    try:
        info = json.loads(subprocess.check_output(["docker", "inspect", registry], text=True))[0]
        port = info["NetworkSettings"]["Ports"]["5000/tcp"][0]["HostPort"]
        endpoint = f"127.0.0.1:{port}"
        for attempt in range(50):
            try:
                with urllib.request.urlopen(f"http://{endpoint}/v2/", timeout=2) as response:
                    assert response.status == 200
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("The owned local OCI registry did not become ready")
        image = endpoint + "/fixture:" + project
        build = tmp_path / "build"
        build.mkdir()
        shutil.copyfile(Path(__file__).with_name("native") / "container/Dockerfile", build / "Dockerfile")
        (build / "index.html").write_text("native fixture " + source["tested_revision"])
        subprocess.run(["docker", "build", "--tag", image, str(build)], check=True)
        subprocess.run(["docker", "push", image], check=True)
        identity = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0][
            "RepoDigests"
        ]
        image_digest = next(value for value in identity if value.startswith(endpoint + "/fixture@sha256:"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            web_port = probe.getsockname()[1]
        compose = {
            "services": {
                "web": {
                    "image": image_digest,
                    "ports": [f"127.0.0.1:{web_port}:8080"],
                    "healthcheck": {
                        "test": ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1:8080/"],
                        "interval": "1s",
                        "timeout": "2s",
                        "retries": 10,
                    },
                }
            }
        }
        (root / "compose.yaml").write_text(yaml.safe_dump(compose))
        archive = tmp_path / "compose.tar.gz"
        manifest = artifacts.pack(root, ["compose.yaml"], archive, source)
        settings = {
            "module": "compose",
            "target_directory": str(target),
            "generation": 1,
            "expected_previous": None,
            "services": ["web"],
            "project": project,
            "health_url": f"http://127.0.0.1:{web_port}/",
        }
        compose_path = target / ".nddev-releases" / manifest["artifact_identity"] / "compose.yaml"
        receipt = delivery.apply(archive, manifest, source, settings, authorized=True)
        assert receipt["status"] == "success"
        assert receipt["health"]["matched_revision"] == source["tested_revision"]
    finally:
        if compose_path is not None and compose_path.exists():
            subprocess.run(
                ["docker", "compose", "--project-name", project, "--file", str(compose_path), "down"],
                check=True,
            )
        subprocess.run(["docker", "rm", "--force", "--volumes", registry], check=True)
        if image:
            subprocess.run(["docker", "image", "rm", image], check=False)


def test_partial_data_migration_preserves_backup_and_never_repeats(repository, tmp_path):
    import sqlite3

    root = repository({"input.txt": "first", ".gitignore": "public/\n"})
    public = root / "public"
    public.mkdir()
    target = tmp_path / "target"
    target.mkdir()
    database = target / "state.sqlite"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            "CREATE TABLE schema_version(value INTEGER); INSERT INTO schema_version VALUES(1); CREATE TABLE migration_log(version INTEGER UNIQUE);"
        )
    with web(target / "current/public") as url:
        source = source_identity(root)
        (public / "index.html").write_text("fixture " + source["tested_revision"])
        archive = tmp_path / "first.tar.gz"
        manifest = artifacts.pack(root, ["public/index.html"], archive, source)
        settings = {
            "module": "static-web",
            "entrypoint": "public/index.html",
            "target_directory": str(target),
            "generation": 1,
            "expected_previous": None,
            "health_url": url,
        }
        first = delivery.apply(archive, manifest, source, settings, authorized=True)
        (root / "input.txt").write_text("second")
        git(root, "add", ".")
        git(root, "commit", "-qm", "second version")
        source = source_identity(root)
        (public / "index.html").write_text("fixture " + source["tested_revision"])
        archive = tmp_path / "second.tar.gz"
        (public / "other.html").write_text("alternative route " + source["tested_revision"])
        manifest = artifacts.pack(root, ["public/index.html", "public/other.html"], archive, source)
        backup = target / "backup.sqlite"
        settings.update(
            generation=2,
            expected_previous=first["artifact"],
            rollback_compatible=True,
            backup_command=[
                sys.executable,
                "-c",
                f"import sqlite3; a=sqlite3.connect({str(database)!r}); b=sqlite3.connect({str(backup)!r}); a.backup(b); a.close(); b.close()",
            ],
            data_migration=[
                sys.executable,
                "-c",
                f"import sqlite3; c=sqlite3.connect({str(database)!r}); c.executescript('UPDATE schema_version SET value=2; INSERT INTO migration_log VALUES(2);'); c.close()",
            ],
            health_contains="deliberately absent scenario",
        )
        with pytest.raises(Invalid, match="scenario/version"):
            delivery.apply(archive, manifest, source, settings, authorized=True)
        state = json.loads((target / ".nddev-deployment.json").read_text())
        assert state["pending"] and (target / "current").resolve().name == manifest["artifact_identity"]
        with sqlite3.connect(backup) as connection:
            assert connection.execute("SELECT value FROM schema_version").fetchone()[0] == 1
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT value FROM schema_version").fetchone()[0] == 2
        with pytest.raises(Invalid, match="retarget"):
            delivery.apply(
                archive,
                manifest,
                source,
                {**settings, "recover_partial": True, "entrypoint": "public/other.html"},
                authorized=True,
            )
        settings.update(recover_partial=True, health_contains="fixture")
        assert delivery.apply(archive, manifest, source, settings, authorized=True)["status"] == "success"
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM migration_log").fetchone()[0] == 1
