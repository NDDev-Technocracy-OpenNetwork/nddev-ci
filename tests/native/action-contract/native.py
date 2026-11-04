"""A small caller exercises its real configuration and caller-owned uv."""

import json
import subprocess
import sys
import unittest
from pathlib import Path


def read_port():
    value = json.loads(Path("data.json").read_text())["port"]
    if type(value) is not int or not 0 < value < 65536:
        raise ValueError("Invalid service port")
    return value


class Configuration(unittest.TestCase):
    def test_port(self):
        self.assertEqual(read_port(), 8080)


if __name__ == "__main__":
    if sys.argv[1] == "external-links":
        # This fixture's only structured document has no external URL inputs.
        assert "http" not in Path("data.json").read_text()
    elif sys.argv[1] == "fail":
        print("native fixture output\n" * 10000, end="")
        raise AssertionError("native action diagnostic fixture")
    else:
        subprocess.run(["uv", "--version"], check=True)
        unittest.main(argv=[sys.argv[0]])
