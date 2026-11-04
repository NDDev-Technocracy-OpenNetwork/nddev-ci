"""Validate a complete native operation and its selected payload before target mutation."""

from __future__ import annotations

import ipaddress
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from . import artifacts
from .mobile import mobile_format
from .model import Invalid, contained

FIELDS = {
    "static-web": {"entrypoint", "health_url", "health_contains", "version_url"},
    "systemd-binary": {"service", "user_service", "health_url", "health_contains", "version_url"},
    "compose": {"compose_file", "services", "project", "health_url", "health_contains", "version_url"},
    "packages": {"publisher", "package_file", "registry"},
    "mobile-artifacts": {"mobile_files"},
}
COMMON = {
    "module",
    "target_directory",
    "generation",
    "expected_previous",
    "backup_command",
    "data_migration",
    "backup_waiver",
    "rollback_compatible",
    "recover_partial",
    "reconcile_command",
}


def url(value, *, https=False) -> None:
    if not isinstance(value, str):
        raise Invalid("An explicit native target URL is required")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ({"https"} if https else {"http", "https"})
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise Invalid("Use an explicit supported target URL with credentials supplied separately")
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError("port out of range")
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", parsed.hostname):
            raise Invalid("Native target URL has an invalid hostname") from None
        # Accessing .port also rejects malformed/out-of-range ports for DNS hosts.
        try:
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                raise ValueError("port out of range")
        except ValueError as error:
            raise Invalid("Native target URL has an invalid port") from error


def validate(archive: Path, manifest: dict, expected: dict, config: dict) -> None:
    module = config.get("module")
    if not isinstance(module, str) or module not in FIELDS or set(config) - COMMON - FIELDS[module]:
        raise Invalid("Unsupported module or unknown/inapplicable native target setting")
    for field in ("user_service", "rollback_compatible", "recover_partial"):
        if field in config and type(config[field]) is not bool:
            raise Invalid("Native target boolean settings must be actual booleans")
    for field in ("backup_command", "data_migration", "reconcile_command"):
        if field in config and (
            not isinstance(config[field], list)
            or not config[field]
            or not all(isinstance(x, str) and x and "\0" not in x for x in config[field])
        ):
            raise Invalid("Native recovery/migration commands must be nonempty argument arrays")
    if module in {"static-web", "systemd-binary", "compose"}:
        url(config.get("health_url"))
        url(config.get("version_url", config.get("health_url")))
        if "health_contains" in config and (
            not isinstance(config["health_contains"], str) or not config["health_contains"]
        ):
            raise Invalid("The declared health scenario must be a nonempty string")
    if module == "systemd-binary":
        service = config.get("service")
        if not isinstance(service, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", service):
            raise Invalid("Select one actual systemd service")
        command = ["systemctl"] + (["--user"] if config.get("user_service", True) else [])
        result = subprocess.run(
            [*command, "show", "--property=LoadState", "--value", service],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode or result.stdout.strip() != "loaded":
            raise Invalid("The selected systemd unit must already be installed and loaded")
    if module == "compose":
        project, services = config.get("project"), config.get("services")
        if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
            raise Invalid("Compose needs an explicit stable project owner")
        if (
            not isinstance(services, list)
            or not services
            or len(set(services)) != len(services)
            or not all(isinstance(x, str) and x and not x.startswith("-") for x in services)
        ):
            raise Invalid("Select actual nonempty unique Compose services")
        if not shutil.which("docker"):
            raise Invalid("Native Compose delivery requires the existing Docker client")
    if module == "packages":
        publisher = config.get("publisher")
        if publisher not in {"python", "npm", "nuget"}:
            raise Invalid("Supported native publishers: python, npm, nuget")
        url(config.get("registry"), https=True)
        if not shutil.which({"python": "uv", "npm": "npm", "nuget": "dotnet"}[publisher]):
            raise Invalid("The selected native publisher must be installed before delivery")
    files = config.get("mobile_files")
    if module == "mobile-artifacts" and (
        not isinstance(files, list) or not files or not all(isinstance(x, str) and x for x in files)
    ):
        raise Invalid("Select actual configured mobile deliverable files")
    with tempfile.TemporaryDirectory(prefix="nddev-preflight-") as directory:
        root = Path(directory)
        artifacts.unpack(archive, manifest, root, expected)
        if module == "static-web":
            entrypoint = contained(root, config.get("entrypoint", "index.html"), exists=True)
            if not entrypoint.is_file():
                raise Invalid("Static delivery entrypoint must be a selected regular file")
        elif module == "compose":
            document = yaml.safe_load(
                contained(root, config.get("compose_file", "compose.yaml"), exists=True).read_text()
            )
            services = document.get("services") if isinstance(document, dict) else None
            if not isinstance(services, dict) or set(config["services"]) - services.keys():
                raise Invalid("Select actual services from the packaged Compose configuration")
            if any(
                not isinstance(value, dict)
                or "build" in value
                or not re.search(r"@sha256:[0-9a-f]{64}$", value.get("image", ""))
                for value in services.values()
            ):
                raise Invalid("Compose delivery requires immutable prebuilt image digests")
            native = subprocess.run(
                [
                    "docker",
                    "compose",
                    "--project-name",
                    config["project"],
                    "--file",
                    str(contained(root, config.get("compose_file", "compose.yaml"), exists=True)),
                    "config",
                    "--quiet",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if native.returncode:
                raise Invalid("Native Compose configuration is invalid: " + native.stderr[-500:])
        elif module == "packages":
            if not contained(root, config.get("package_file", ""), exists=True).is_file():
                raise Invalid("Select an actual packaged publication file")
        elif module == "mobile-artifacts":
            for name in config["mobile_files"]:
                mobile_format(contained(root, name, exists=True))
