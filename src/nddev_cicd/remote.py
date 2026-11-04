"""SSH transport for the same verified native adapters, executed under the target's own lock."""

from __future__ import annotations

import importlib.metadata
import ipaddress
import json
import os
import re
import shlex
import sys
import tempfile
import zipfile
from pathlib import Path

from . import artifacts, delivery
from .model import Invalid, atomic_json, digest, identity
from .process import run


def implementation() -> dict[str, Path]:
    code = Path(__file__).parent
    return {
        str(p.relative_to(code)): p
        for p in sorted(code.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


def runtime_bundle(path: Path, expected: dict) -> None:
    files = implementation()
    if identity({name: digest(file) for name, file in files.items()}) != expected.get(
        "implementation_digest"
    ):
        raise Invalid("Remote delivery must execute the exact implementation used by the source run")
    distribution = importlib.metadata.distribution("nddev-cicd")
    metadata = distribution.read_text("METADATA")
    if not metadata:
        raise Invalid("The portable runtime requires its native distribution metadata")
    metadata_directory = "nddev_cicd-" + distribution.version + ".dist-info"
    license_file = Path(__file__).parent.parent.parent / "LICENSE"
    if not license_file.is_file():
        licenses = [
            distribution.locate_file(p)
            for p in distribution.files or []
            if str(p).endswith("licenses/LICENSE")
        ]
        if len(licenses) != 1:
            raise Invalid("The remote runtime distribution must include its license")
        license_file = Path(str(licenses[0]))
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, file in files.items():
            archive.write(file, "nddev_cicd/" + name)
        archive.write(license_file, "LICENSE")
        archive.writestr(metadata_directory + "/METADATA", metadata)
        archive.write(license_file, metadata_directory + "/licenses/LICENSE")


def transport(settings: dict) -> tuple[list[str], str, int, str]:
    allowed = {"kind", "hostname", "user", "port", "identity_file", "known_hosts", "python"}
    if not isinstance(settings, dict) or set(settings) - allowed or settings.get("kind") != "ssh":
        raise Invalid("Select an explicit native SSH transport without extra command/settings fields")
    host, user, port = settings.get("hostname"), settings.get("user"), settings.get("port", 22)
    if not isinstance(host, str) or not host or len(host) > 253:
        raise Invalid("Declare the existing SSH host")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host):
            raise Invalid("SSH hostname is not an address or a safe DNS name") from None
    if not isinstance(user, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise Invalid("Declare a POSIX SSH target user")
    if type(port) is not int or not 1 <= port <= 65535:
        raise Invalid("SSH port must be an actual integer from 1 to 65535")
    for key in ("identity_file", "known_hosts"):
        value = settings.get(key)
        if not isinstance(value, str):
            raise Invalid("SSH key and known-hosts material must come from caller-owned files")
        file = Path(value)
        if not file.is_absolute() or not file.is_file() or file.is_symlink() or not file.stat().st_size:
            raise Invalid("SSH credential/host-key paths must be existing absolute regular files")
        if os.name != "nt" and file.stat().st_mode & (0o077 if key == "identity_file" else 0o022):
            raise Invalid("SSH private key must be private; known-hosts must not be group/world writable")
    python = settings.get("python", "python3")
    if (
        not isinstance(python, str)
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", python)
        or ".." in Path(python).parts
    ):
        raise Invalid("Select the existing target Python executable, without shell arguments")
    options = [
        "-F",
        os.devnull,
        "-i",
        settings["identity_file"],
        "-oBatchMode=yes",
        "-oIdentitiesOnly=yes",
        "-oStrictHostKeyChecking=yes",
        '-oUserKnownHostsFile="' + settings["known_hosts"].replace("\\", "\\\\").replace('"', '\\"') + '"',
        "-oGlobalKnownHostsFile=" + os.devnull,
        "-oForwardAgent=no",
        "-oClearAllForwardings=yes",
        "-oPermitLocalCommand=no",
        "-oConnectTimeout=15",
    ]
    return options, user + "@" + host, port, python


def command(arguments: list[str], directory: Path, name: str) -> str:
    log = directory / (name + ".log")
    result = run(arguments, directory, log, timeout=900, env={"SSH_AUTH_SOCK": ""})
    output = log.read_text()
    if result["status"] != "success":
        raise Invalid(
            f"SSH operation {name} failed ({result['detail']}, exit {result['exit_code']}): " + output[-1500:]
        )
    return output


def environment_values(values: dict | None) -> dict:
    values = {} if values is None else values
    forbidden = {
        "PATH",
        "HOME",
        "PYTHONPATH",
        "PYTHONHOME",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "BASH_ENV",
        "ENV",
        "GH_TOKEN",
    }
    if not isinstance(values, dict) or any(
        not isinstance(key, str)
        or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key)
        or key in forbidden
        or key.startswith(("GITHUB_", "SSH_", "DYLD_"))
        or not isinstance(value, str)
        or "\0" in value
        for key, value in values.items()
    ):
        raise Invalid(
            "Pass selected native credentials/settings, never GitHub/SSH authority or runtime controls"
        )
    return values


def apply(
    archive: Path,
    manifest: dict,
    expected: dict,
    config: dict,
    settings: dict,
    *,
    authorized: bool,
    environment: dict | None = None,
) -> dict:
    if not authorized:
        raise Invalid("SSH mutation requires the same authorized integrated source context as local delivery")
    options, destination, port, python = transport(settings)
    selected_environment = environment_values(environment)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", archive.name) or archive.name in {
        "runtime.zip",
        "request.json",
        "receipt.json",
    }:
        raise Invalid("Use a bounded artifact basename distinct from transport metadata")
    artifacts.verify(archive, manifest, expected)
    with tempfile.TemporaryDirectory(prefix="nddev-ssh-") as directory:
        root = Path(directory)
        runtime = root / "runtime.zip"
        runtime_bundle(runtime, expected)
        request = {
            "schema": 1,
            "manifest": manifest,
            "expected": expected,
            "target": config,
            "environment": selected_environment,
        }
        atomic_json(root / "request.json", request)
        ssh = ["ssh", *options, "-p", str(port), "-T", destination]
        output = command([*ssh, "mktemp -d /tmp/nddev-cd.XXXXXXXXXX"], root, "stage").strip().splitlines()
        stage = output[-1] if output else ""
        if not re.fullmatch(r"/tmp/nddev-cd\.[A-Za-z0-9]+", stage):
            raise Invalid("The SSH target did not return an owned temporary staging directory")
        copy_destination = (
            destination.replace("@" + settings["hostname"], "@[" + settings["hostname"] + "]")
            if ":" in settings["hostname"]
            else destination
        )
        operation_failed = False
        try:
            command(
                [
                    "scp",
                    *options,
                    "-P",
                    str(port),
                    str(runtime),
                    str(root / "request.json"),
                    str(archive),
                    copy_destination + ":" + stage + "/",
                ],
                root,
                "transfer",
            )
            # Neither candidate artifact scripts nor caller commands are executed before verification.
            bootstrap = (
                "import sys,hashlib,pathlib\np=pathlib.Path(sys.argv[1])\n"
                "if hashlib.sha256((p/'runtime.zip').read_bytes()).hexdigest()!=sys.argv[2]:\n"
                " raise SystemExit('Remote runtime digest mismatch')\n"
                "sys.path.insert(0,str(p/'runtime.zip'))\nfrom nddev_cicd.remote import execute\n"
                "execute(p,sys.argv[3])"
            )
            command(
                [*ssh, shlex.join([python, "-I", "-c", bootstrap, stage, digest(runtime), archive.name])],
                root,
                "apply",
            )
            receipt = root / "receipt.json"
            command(
                [
                    "scp",
                    *options,
                    "-P",
                    str(port),
                    copy_destination + ":" + stage + "/receipt.json",
                    str(receipt),
                ],
                root,
                "receipt",
            )
            result = json.loads(receipt.read_text())
            if (
                result.get("status") != "success"
                or result.get("pending") is not False
                or result.get("artifact") != manifest["artifact_identity"]
                or result.get("revision") != expected["tested_revision"]
                or result.get("generation") != config.get("generation")
            ):
                raise Invalid("The remote receipt does not identify the accepted tested artifact/generation")
            result["transport"] = "ssh"
            return result
        except BaseException:
            operation_failed = True
            raise
        finally:
            try:
                command([*ssh, shlex.join(["rm", "-rf", "--", stage])], root, "cleanup")
            except Invalid:
                if not operation_failed:
                    raise
                # Preserve the operation failure; the durable target record remains authoritative.
                print(
                    "Owned SSH staging cleanup failed; reconcile that staging directory on the target.",
                    file=sys.stderr,
                )


def execute(stage: Path, archive_name: str) -> None:
    """Called by the authenticated SSH user; no GitHub credentials or deployment daemon is installed."""
    if Path(archive_name).name != archive_name:
        raise Invalid("Remote archive must be a staged basename")
    request = json.loads((stage / "request.json").read_text())
    if request.get("schema") != 1:
        raise Invalid("Unknown remote request contract")
    previous = dict(os.environ)
    try:
        os.environ.update(environment_values(request.get("environment")))
        result = delivery.apply(
            stage / archive_name, request["manifest"], request["expected"], request["target"], authorized=True
        )
        atomic_json(stage / "receipt.json", result)
    finally:
        os.environ.clear()
        os.environ.update(previous)
