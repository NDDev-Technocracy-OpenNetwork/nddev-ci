"""Explicit native scanners: known findings, deletion history and inherited Git colour."""

import json
import os
import secrets
import string
import subprocess

from nddev_cicd.model import git, git_environment


def test_osv_default_rejects_a_known_vulnerable_native_lock(tmp_path):
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "native-negative-fixture",
                "version": "1.0.0",
                "lockfileVersion": 3,
                "packages": {
                    "": {"dependencies": {"lodash": "4.17.20"}},
                    "node_modules/lodash": {"version": "4.17.20"},
                },
            }
        )
    )
    result = subprocess.run(
        ["osv-scanner", "scan", "source", "--recursive", "."],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1 and "lodash" in result.stdout + result.stderr


def test_native_gitleaks_sees_deleted_history_with_forced_parent_colour(repository, tmp_path):
    token = "ghp_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
    root = repository({"leak.txt": "token: " + token + "\n"})
    git(root, "rm", "leak.txt")
    git(root, "commit", "-qm", "delete fixture token")
    parent = dict(os.environ, GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="color.ui", GIT_CONFIG_VALUE_0="always")
    result = subprocess.run(
        ["gitleaks", "git", "--redact", "--no-banner"],
        cwd=root,
        env=git_environment(parent),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1 and "commits scanned" in result.stderr
    assert token not in result.stdout + result.stderr
    clone = tmp_path / "shallow"
    subprocess.run(
        ["git", "clone", "--depth", "1", root.as_uri(), str(clone)], check=True, capture_output=True
    )
    assert git(clone, "rev-parse", "--is-shallow-repository") == "true"


def test_native_default_workflow_scanner_rejects_expression_injection(repository):
    root = repository(
        {
            ".github/workflows/unsafe.yml": """name: native-negative
on: issues
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-26.04
    steps:
      - run: echo '${{ github.event.issue.title }}'
"""
        }
    )
    result = subprocess.run(
        ["zizmor", "--offline", "--no-progress", ".github"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0 and "template-injection" in result.stdout + result.stderr
