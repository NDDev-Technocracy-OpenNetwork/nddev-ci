"""Keep native Cargo final packages outside reclaimable intermediate build state."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from .model import Invalid


def retain_package(root: Path, environment: dict[str, str]) -> list[str]:
    root = root.resolve()
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--no-deps", "--format-version=1"],
            cwd=root,
            env={**os.environ, **environment},
            text=True,
        )
    )
    packages = [p for p in metadata["packages"] if Path(p["manifest_path"]).resolve() == root / "Cargo.toml"]
    if len(packages) != 1:
        raise Invalid("A virtual workspace supplies its native package/staging command explicitly")
    package = packages[0]
    archive = Path(metadata["target_directory"]) / "package" / f"{package['name']}-{package['version']}.crate"
    if not archive.is_file():
        raise Invalid("The selected native Cargo package was not produced")
    destination = root / "dist"
    destination.mkdir(exist_ok=True)
    if destination.is_symlink():
        raise Invalid("Final package staging cannot escape through a symlink")
    target = destination / archive.name
    shutil.copy2(archive, target)
    return [str(target.relative_to(root))]
