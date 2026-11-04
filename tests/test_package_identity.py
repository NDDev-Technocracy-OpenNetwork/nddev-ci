"""Native build metadata and installed/source entrypoints have one version owner."""

import json
import os
import shutil
import subprocess
import sys
import tomllib
import zipfile
from email.parser import Parser
from pathlib import Path

import pytest

from nddev_cicd import remote
from nddev_cicd.model import Invalid, digest, identity

ROOT = Path(__file__).parents[1]


@pytest.fixture(scope="module")
def installed_package(tmp_path_factory):
    directory = tmp_path_factory.mktemp("package-identity")
    distributions = directory / "dist"
    subprocess.run(
        ["uv", "build", "--out-dir", str(distributions)], cwd=ROOT, check=True, capture_output=True
    )
    (wheel,) = distributions.glob("*.whl")
    environment = directory / "environment"
    subprocess.run(
        ["uv", "venv", "--python", sys.executable, str(environment)], check=True, capture_output=True
    )
    binary = environment / ("Scripts" if os.name == "nt" else "bin")
    python = binary / ("python.exe" if os.name == "nt" else "python")
    console = binary / ("nddev-cicd.exe" if os.name == "nt" else "nddev-cicd")
    subprocess.run(
        ["uv", "pip", "install", "--python", str(python), str(wheel)], check=True, capture_output=True
    )
    return directory, wheel, python, console


def test_wheel_metadata_installed_api_console_and_module_agree(installed_package):
    directory, wheel, python, console = installed_package
    native = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    with zipfile.ZipFile(wheel) as archive:
        (metadata,) = (name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))
        assert Parser().parsestr(archive.read(metadata).decode())["Version"] == native
    clean = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "VIRTUAL_ENV"}}
    for arguments in ([str(console), "--version"], [str(python), "-m", "nddev_cicd", "--version"]):
        result = subprocess.run(
            arguments, cwd=directory, env=clean, capture_output=True, text=True, check=True
        )
        assert result.stdout.strip() == native
    result = subprocess.run(
        [
            str(python),
            "-c",
            (
                "import json,nddev_cicd; from importlib.metadata import version; "
                "print(json.dumps([nddev_cicd.__version__,version('nddev-cicd'),nddev_cicd.__file__]))"
            ),
        ],
        cwd=directory,
        env=clean,
        capture_output=True,
        text=True,
        check=True,
    )
    api, metadata, imported = json.loads(result.stdout)
    assert api == metadata == native
    assert Path(imported).is_relative_to(python.parent.parent)


def test_prepared_source_reports_native_identity():
    from importlib.metadata import version

    from nddev_cicd import __version__

    assert (
        __version__
        == version("nddev-cicd")
        == tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    )


def test_portable_runtime_imports_real_entrypoint_with_only_target_dependencies(tmp_path):
    import yaml

    # Existing SSH targets prepare PyYAML; expose only that dependency, never all site packages.
    dependencies = tmp_path / "target-dependencies"
    shutil.copytree(
        Path(yaml.__file__).parent, dependencies / "yaml", ignore=shutil.ignore_patterns("__pycache__")
    )
    archive = tmp_path / "runtime.zip"
    expected = {
        "implementation_digest": identity(
            {name: digest(path) for name, path in remote.implementation().items()}
        )
    }
    remote.runtime_bundle(archive, expected)
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-S",
            "-c",
            (
                "import sys,json; sys.path[:0]=sys.argv[1:]; "
                "from importlib.util import find_spec; assert find_spec('defusedxml') is None; "
                "from importlib.metadata import version; import nddev_cicd; "
                "from nddev_cicd.remote import execute; assert callable(execute); "
                "print(json.dumps([nddev_cicd.__version__,version('nddev-cicd')]))"
            ),
            str(archive),
            str(dependencies),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    from importlib.metadata import version

    assert json.loads(result.stdout) == [version("nddev-cicd")] * 2
    with zipfile.ZipFile(archive) as bundled:
        assert "LICENSE" in bundled.namelist()
        (metadata,) = (name for name in bundled.namelist() if name.endswith(".dist-info/METADATA"))
        assert Parser().parsestr(bundled.read(metadata).decode())["Version"] == version("nddev-cicd")


def test_portable_runtime_refuses_a_different_implementation_before_writing(tmp_path):
    archive = tmp_path / "runtime.zip"
    with pytest.raises(Invalid, match="exact implementation"):
        remote.runtime_bundle(archive, {"implementation_digest": "not-the-tested-implementation"})
    assert not archive.exists()


@pytest.mark.parametrize("missing", [False, True])
def test_source_does_not_hide_stale_or_missing_metadata(tmp_path, missing):
    # Patch only the metadata seam in a fresh interpreter; execute the real source initializer.
    script = "import importlib.metadata,sys\nsys.path.insert(0,sys.argv[1])\n"
    script += (
        "def metadata(name): raise importlib.metadata.PackageNotFoundError(name)\n"
        if missing
        else "def metadata(name): return '999.999.999'\n"
    )
    script += "importlib.metadata.version=metadata\nimport nddev_cicd\n"
    result = subprocess.run(
        [sys.executable, "-c", script, str(ROOT / "src")],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert ("missing" if missing else "stale") in result.stderr
    assert "uv sync --locked" in result.stderr
