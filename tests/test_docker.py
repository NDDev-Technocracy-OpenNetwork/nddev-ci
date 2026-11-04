"""Use native Docker selection precedence; never silently mount another daemon."""

import socket

import pytest

from nddev_cicd import docker, oci
from nddev_cicd.model import Unavailable


@pytest.fixture(autouse=True)
def no_ambient_selector(monkeypatch):
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)


def test_current_context_and_explicit_context_use_native_cli(monkeypatch):
    commands = []

    def inspect(command, **_):
        commands.append(command)
        return "unix:///run/user/123/docker.sock\n"

    monkeypatch.setattr(docker.subprocess, "check_output", inspect)
    assert docker.endpoint() == "unix:///run/user/123/docker.sock"
    assert commands[-1][-1] == "{{.Endpoints.docker.Host}}"
    monkeypatch.setenv("DOCKER_HOST", "unix:///another.sock")
    assert docker.endpoint() == "unix:///another.sock"
    monkeypatch.setenv("DOCKER_CONTEXT", "rootless")
    assert docker.endpoint() == "unix:///run/user/123/docker.sock"
    assert commands[-1][-1] == "rootless"


@pytest.mark.parametrize("value", ["tcp://127.0.0.1:2375", "ssh://fixture", "unix:///absent.sock"])
def test_unavailable_or_remote_daemon_cannot_fall_back_to_host_socket(monkeypatch, value):
    monkeypatch.setenv("DOCKER_HOST", value)
    with pytest.raises(Unavailable):
        docker.local_socket()


def test_oci_mounts_the_actual_context_socket(tmp_path, monkeypatch):
    path = tmp_path / "rootless.sock"
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(path))
        monkeypatch.setenv("DOCKER_HOST", "unix://" + str(path))
        monkeypatch.setattr(oci.platform, "system", lambda: "Linux")
        monkeypatch.setattr(oci.platform, "machine", lambda: "x86_64")
        commands = []
        monkeypatch.setattr(oci, "native", lambda command, *_: commands.append(command) or "native result")
        monkeypatch.setattr(oci.subprocess, "run", lambda *_a, **_k: None)
        assert oci.skopeo(["inspect", "docker-daemon:fixture"], daemon=True) == "native result"
        assert str(path) + ":/var/run/docker.sock" in commands[0]
        assert "/var/run/docker.sock:/var/run/docker.sock" not in commands[0]
