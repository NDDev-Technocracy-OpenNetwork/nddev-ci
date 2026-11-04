"""Resolve the selected native Docker endpoint without changing caller configuration."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .model import Invalid, Unavailable


def endpoint() -> str:
    context = os.environ.get("DOCKER_CONTEXT")
    if not context and os.environ.get("DOCKER_HOST"):
        return os.environ["DOCKER_HOST"]
    if context and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", context):
        raise Invalid("Select an explicit native Docker context name")
    command = ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]
    try:
        value = subprocess.check_output(
            [*command, *([context] if context else [])], text=True, stderr=subprocess.DEVNULL, timeout=30
        ).strip()
    except (subprocess.SubprocessError, OSError) as error:
        raise Unavailable("The selected native Docker endpoint is unavailable") from error
    if not value or any(c in value for c in "\r\n\0"):
        raise Invalid("The native Docker context has no single endpoint")
    return value


def local_socket() -> Path:
    value = endpoint()
    if not value.startswith("unix:///") or any(c in value for c in "\r\n\0"):
        raise Unavailable("This daemon-mounted operation requires the selected local Unix Docker socket")
    path = Path(value.removeprefix("unix://"))
    if ":" in str(path) or not path.is_socket():
        raise Unavailable("The selected local Docker socket is absent or cannot be bind-mounted")
    return path


def rootless() -> bool:
    try:
        output = subprocess.check_output(
            ["docker", "info", "--format", "{{json .SecurityOptions}}"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (subprocess.SubprocessError, OSError) as error:
        raise Unavailable("The selected native Docker daemon is unavailable") from error
    import json

    options = json.loads(output)
    if not isinstance(options, list) or any(not isinstance(value, str) for value in options):
        raise Invalid("The native Docker daemon returned invalid security options")
    return "name=rootless" in options
