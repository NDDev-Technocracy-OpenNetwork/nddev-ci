"""Exercise a built Python distribution outside its source tree with locked runtime dependencies."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import tomllib
import zipfile
from pathlib import Path

from .model import Invalid, contained


def check(root: Path, settings: dict | None = None) -> None:
    settings = settings or {}
    directory = contained(root, settings.get("directory", "dist"), exists=True)
    caller_environment = {
        k: v
        for k, v in os.environ.items()
        if k not in {"UV_PROJECT_ENVIRONMENT", "UV_PROJECT", "VIRTUAL_ENV", "PYTHONPATH"}
    }
    config = tomllib.loads((root / "pyproject.toml").read_text())
    wheels = list(directory.glob("*.whl"))
    sdists = list(directory.glob("*.tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        raise Invalid("Build exactly one wheel and sdist into a clean owned package output")
    with zipfile.ZipFile(wheels[0]) as wheel:
        if not any(name.endswith("/METADATA") for name in wheel.namelist()):
            raise Invalid("Wheel metadata is absent")
    modules = settings.get("imports")
    if modules is None:
        modules = sorted(
            path.name
            for path in (root / "src").iterdir()
            if path.is_dir() and (path / "__init__.py").exists()
        )
    if not isinstance(modules, list) or not all(isinstance(name, str) and name for name in modules):
        raise Invalid("Consumer imports must name actual Python distribution modules")
    if not modules:
        raise Invalid("Declare a Python src package before consumer import")
    commands = settings.get("commands", [])
    if not isinstance(commands, list) or any(
        not isinstance(command, list)
        or not command
        or not all(isinstance(argument, str) and argument and "\0" not in argument for argument in command)
        for command in commands
    ):
        raise Invalid("Consumer commands must be native argument arrays for the built distribution")
    with tempfile.TemporaryDirectory(prefix="nddev-wheel-consumer-") as directory:
        workspace = Path(directory)
        environment = workspace / "venv"
        caller_python = subprocess.check_output(
            ["uv", "run", "--locked", "--no-sync", "python", "-c", "import sys; print(sys.executable)"],
            cwd=root,
            env=caller_environment,
            text=True,
        ).strip()
        subprocess.run(
            ["uv", "venv", "--python", caller_python, str(environment)], env=caller_environment, check=True
        )
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        requirements = workspace / "requirements.txt"
        with requirements.open("w") as stream:
            subprocess.run(
                ["uv", "export", "--locked", "--no-dev", "--no-emit-project"],
                cwd=root,
                env=caller_environment,
                stdout=stream,
                check=True,
            )
        subprocess.run(
            ["uv", "pip", "sync", "--python", str(python), str(requirements)],
            env=caller_environment,
            check=True,
        )
        subprocess.run(
            ["uv", "pip", "install", "--no-deps", "--python", str(python), str(wheels[0])],
            env=caller_environment,
            check=True,
        )
        program = """
import importlib, importlib.metadata, json, os, subprocess, sys
from pathlib import Path
request = json.loads(sys.argv[1])
distribution = importlib.metadata.distribution(request["project"])
owned = {Path(distribution.locate_file(p)).resolve() for p in distribution.files or []}
prefix = Path(sys.prefix).resolve()
for name in request["modules"]:
    module = importlib.import_module(name)
    filename = getattr(module, "__file__", None)
    if filename:
        actual = Path(filename).resolve()
        assert actual in owned and actual.is_relative_to(prefix), "Import is not owned by the built distribution"
    else:
        paths = [Path(p).resolve() for p in getattr(module, "__path__", [])]
        assert paths and any(p.is_relative_to(prefix) and any(f.is_relative_to(p) for f in owned)
                             for p in paths), "Namespace has no installed contribution from this distribution"
scripts = {entry.name for entry in distribution.entry_points if entry.group == "console_scripts"}
for command in request["commands"]:
    assert command[0] in scripts, "Consumer command is not owned by the built distribution"
    executable = prefix / ("Scripts" if os.name == "nt" else "bin") / (command[0] + (".exe" if os.name == "nt" else ""))
    subprocess.run([str(executable), *command[1:]], stdin=subprocess.DEVNULL, check=True, timeout=120)
print(json.dumps({"python": sys.version.split()[0], "distribution": distribution.metadata["Name"],
                  "version": distribution.version, "imports": request["modules"],
                  "consumer_commands": [command[0] for command in request["commands"]]}))
"""
        subprocess.run(
            [
                str(python),
                "-I",
                "-c",
                program,
                json.dumps(
                    {
                        "project": config.get("project", {}).get("name"),
                        "modules": modules,
                        "commands": commands,
                    }
                ),
            ],
            cwd=workspace,
            env=caller_environment,
            check=True,
        )
    if not config.get("project", {}).get("name"):
        raise Invalid("Package identity is absent")


if __name__ == "__main__":
    check(Path.cwd())
