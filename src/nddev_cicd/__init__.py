"""Modular CI, artifact and native delivery operations.

No private NDDev authoring tools are runtime dependencies.
"""

import tomllib
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def _package_version() -> str:
    try:
        installed = version("nddev-cicd")
    except PackageNotFoundError as error:
        raise RuntimeError(
            "nddev-cicd metadata is missing; prepare the checkout with `uv sync --locked`"
        ) from error
    source = Path(__file__).resolve()
    project = source.parents[2]
    manifest = project / "pyproject.toml"
    if source == project / "src/nddev_cicd/__init__.py" and manifest.is_file():
        native = tomllib.loads(manifest.read_text(encoding="utf-8"))["project"]
        if native["name"] != "nddev-cicd" or installed != native["version"]:
            raise RuntimeError("nddev-cicd metadata is stale; prepare the checkout with `uv sync --locked`")
    return installed


__version__ = _package_version()
