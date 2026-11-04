"""Exercise discovery, argument boundaries and required-child failure through actual just."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Bash command interface acceptance is POSIX-only")

ROOT = Path(__file__).resolve().parents[1]
JUST = shutil.which("just")


def environment(tmp_path: Path) -> dict[str, str]:
    tools = tmp_path / "bin"
    tools.mkdir()
    source = """#!/usr/bin/python3
import json, os, sys
with open(os.environ['COMMAND_PROBE'], 'a') as stream:
    stream.write(json.dumps({'tool':os.path.basename(sys.argv[0]), 'args':sys.argv[1:], 'cwd':os.getcwd()})+'\\n')
sys.exit(int(os.environ.get('COMMAND_EXIT', '0')))
"""
    for name in ("uv", "go", "nddev"):
        path = tools / name
        path.write_text(source)
        path.chmod(0o755)
    return {
        **os.environ,
        "PATH": str(tools) + os.pathsep + os.environ["PATH"],
        "COMMAND_PROBE": str(tmp_path / "calls.jsonl"),
    }


def invoke(args: list[str], env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess:
    assert JUST is not None, "Command interface acceptance requires compatible just"
    return subprocess.run(
        [JUST, "--justfile", str(ROOT / "justfile"), *args],
        check=False,
        env=env,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=30,
    )


def test_discovery_never_invokes_application_tools(tmp_path: Path):
    env = environment(tmp_path)
    env["COMMAND_EXIT"] = "41"
    for args in ([], ["--list"], ["--summary"], ["--dump"], ["--show", "library"]):
        result = invoke(args, env, tmp_path)
        assert result.returncode == 0, result.stderr
    assert not (tmp_path / "calls.jsonl").exists()


def test_forwarding_preserves_data_and_repository_context(tmp_path: Path):
    env = environment(tmp_path)
    args = ["a b", "'\"", "Юникод", "", "; touch forbidden", "--option"]
    result = invoke(["library", "--", *args], env, tmp_path)
    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert calls == [
        {"tool": "uv", "args": ["run", "--locked", "python", "-m", "nddev_cicd", *args], "cwd": str(ROOT)}
    ]
    assert not (ROOT / "forbidden").exists()


def test_failed_required_child_prevents_success_and_later_checks(tmp_path: Path):
    env = environment(tmp_path)
    env["COMMAND_EXIT"] = "41"
    result = invoke(["verify"], env, tmp_path)
    assert result.returncode != 0
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert [call["tool"] for call in calls] == ["nddev"]
