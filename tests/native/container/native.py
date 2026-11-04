"""Build, run and inspect an actual isolated image; cleanup owns one temporary tag."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path.cwd()
tag = "nddev-native-container:" + hashlib.sha256(str(root).encode()).hexdigest()[:16]
reports = root / ".nddev-reports"
reports.mkdir(exist_ok=True)


def command(*args):
    return subprocess.check_output(list(args), text=True).strip()


stage = sys.argv[1]
if stage == "build":
    (root / "index.html").write_text("native fixture " + os.environ["NDDEV_TESTED_REVISION"])
    subprocess.run(["docker", "build", "--tag", tag, "."], check=True)
elif stage == "test":
    container = command("docker", "run", "--detach", "--publish", "127.0.0.1::8080", tag)
    try:
        info = json.loads(command("docker", "inspect", container))[0]
        port = info["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostPort"]
        last = None
        for attempt in range(30):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
                    assert response.status == 200
                    assert os.environ["NDDEV_TESTED_REVISION"] in response.read().decode()
                last = None
                break
            except (OSError, AssertionError) as error:
                last = error
                time.sleep(0.1)
        if last:
            raise last
        suite = ET.Element("testsuite")
        ET.SubElement(suite, "testcase", name="actual image serves tested revision")
        ET.ElementTree(suite).write(reports / "container.xml")
    finally:
        subprocess.run(["docker", "rm", "--force", container], check=True)
elif stage in {"scan", "sbom"}:
    args = ["trivy", "image", "--image-src", "docker", "--format"]
    if stage == "scan":
        args += [
            "json",
            "--scanners",
            "vuln",
            "--severity",
            "HIGH,CRITICAL",
            "--exit-code",
            "1",
            "--output",
            str(reports / "vulnerabilities.json"),
        ]
    else:
        args += ["cyclonedx", "--output", str(reports / "sbom.json")]
    result = subprocess.run([*args, tag], check=False)
    retained = Path(os.environ["NDDEV_RESULT_DIR"]) / "image-inspection"
    retained.mkdir(exist_ok=True)
    report_file = reports / ("vulnerabilities.json" if stage == "scan" else "sbom.json")
    if report_file.exists():
        shutil.copyfile(report_file, retained / report_file.name)
    result.check_returncode()
    payload = json.loads((reports / ("vulnerabilities.json" if stage == "scan" else "sbom.json")).read_text())
    assert payload.get("Results") if stage == "scan" else payload.get("components")
elif stage == "cleanup":
    subprocess.run(["docker", "image", "rm", tag], check=False)
else:
    raise ValueError("Unknown native operation")
