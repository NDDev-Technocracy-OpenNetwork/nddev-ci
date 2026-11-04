"""Render a nonproduction target artifact from the tested revision and actual built wheel."""

import hashlib
import html
import os
from pathlib import Path

(wheel,) = Path("dist").glob("*.whl")
output = Path("dist/target-fixture")
output.mkdir(exist_ok=True)
(output / "index.html").write_text(
    "<!doctype html><title>Native delivery fixture</title><p>"
    + html.escape(os.environ["NDDEV_TESTED_REVISION"])
    + "</p><p>"
    + hashlib.sha256(wheel.read_bytes()).hexdigest()
    + "</p>\n"
)
