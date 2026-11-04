"""Read actual public runner routes without allocating jobs or changing accounts."""

import json

from nddev_cicd.routing import select

cells = {"linux": "x64", "windows": "x64", "macos": "arm64"}
print(json.dumps({os: select("public", os, architecture=arch) for os, arch in cells.items()}, indent=2))
