"""An owned separate SSH server/container; never changes the workstation's SSH service or accounts."""

from __future__ import annotations

import json
import subprocess
import time
import uuid
from pathlib import Path


def output(*arguments: str) -> str:
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT).strip()


def start(directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=False)
    name = "nddev-ssh-" + uuid.uuid4().hex
    metadata = {"container": name, "image": name + ":fixture", "target": "/srv/" + name}
    (directory / "fixture.json").write_text(json.dumps(metadata))
    try:
        for key in ("hostkey", "client"):
            output("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(directory / key))
        (directory / "sshd_config").write_text(
            "Port 22\nHostKey /fixture/hostkey\nAuthorizedKeysFile /root/.ssh/authorized_keys\n"
            "PasswordAuthentication no\nPermitRootLogin prohibit-password\nUsePAM no\n"
            "AllowAgentForwarding no\nAllowTcpForwarding no\nPermitUserEnvironment no\n"
            "Subsystem sftp internal-sftp\nLogLevel ERROR\n"
        )
        context = Path(__file__).parent / "native/ssh-server"
        output("docker", "build", "--tag", metadata["image"], str(context))
        output(
            "docker",
            "run",
            "--detach",
            "--name",
            name,
            "--label",
            "org.nddev.fixture=ssh-target",
            "--publish",
            "127.0.0.1::22",
            "--publish",
            "127.0.0.1::8080",
            "--volume",
            str(directory) + ":/fixture:ro",
            "--env",
            "FIXTURE_TARGET=" + metadata["target"],
            metadata["image"],
        )
        ports = json.loads(output("docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", name))
        ssh_port, http_port = int(ports["22/tcp"][0]["HostPort"]), int(ports["8080/tcp"][0]["HostPort"])
        known = directory / "known_hosts"
        known.write_text(f"[127.0.0.1]:{ssh_port} " + (directory / "hostkey.pub").read_text())
        known.chmod(0o600)
        metadata.update(
            transport={
                "kind": "ssh",
                "hostname": "127.0.0.1",
                "port": ssh_port,
                "user": "root",
                "identity_file": str(directory / "client"),
                "known_hosts": str(known),
                "python": "python3",
            },
            http_url=f"http://127.0.0.1:{http_port}",
        )
        for _ in range(100):
            running = output("docker", "inspect", "--format", "{{.State.Running}}", name)
            if running != "true":
                raise RuntimeError(output("docker", "logs", name))
            try:
                import socket

                with socket.create_connection(("127.0.0.1", ssh_port), timeout=1) as connection:
                    if connection.recv(128).startswith(b"SSH-"):
                        break
            except OSError:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("The owned SSH server did not start")
        (directory / "fixture.json").write_text(json.dumps(metadata))
        return metadata
    except BaseException:
        stop(directory)
        raise


def stop(directory: Path) -> None:
    path = directory / "fixture.json"
    if not path.exists():
        return
    metadata = json.loads(path.read_text())
    for arguments in (
        ("docker", "rm", "--force", metadata["container"]),
        ("docker", "image", "rm", metadata["image"]),
    ):
        subprocess.run(arguments, check=False, capture_output=True)
