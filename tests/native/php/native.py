"""Invoke the pinned native PHP/Composer SDK in a Linux container with caller ownership."""

import json
import os
import subprocess
import sys
from pathlib import Path

image = "composer@sha256:af98f42dfff7c68ba8d53c2164fd9fde1087b7d449514baa38c418b1f6bc4bac"
security = json.loads(
    subprocess.check_output(["docker", "info", "--format", "{{json .SecurityOptions}}"], text=True)
)
# Root in a rootless daemon maps to its native CI account. Passing that account's
# host UID again would select a subordinate UID unable to write the bind mount.
user = "0:0" if "name=rootless" in security else f"{os.getuid()}:{os.getgid()}"
subprocess.run(
    [
        "docker",
        "run",
        "--rm",
        "--user",
        user,
        "--env",
        "COMPOSER_HOME=/tmp/composer",
        "--volume",
        f"{Path.cwd()}:/work",
        "--workdir",
        "/work",
        image,
        *sys.argv[1:],
    ],
    check=True,
)
