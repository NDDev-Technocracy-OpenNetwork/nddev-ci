"""Controlled producer contracts; real native owner acceptance is recorded separately."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
HELPER = SCRIPTS / "prepare-python-tool-runtime.sh"


@pytest.fixture
def runtime_fixture(tmp_path):
    uv = tmp_path / "uv"
    uv.write_text(
        "#!" + sys.executable + "\n"
        "import json, os, pathlib, sys\n"
        "args = sys.argv[1:]\n"
        "with open(os.environ['PROBE_LOG'], 'a') as f:\n"
        " json.dump({'args':args,'callee':os.environ.get('UV_PROJECT_ENVIRONMENT')},f); f.write('\\n')\n"
        "if os.environ.get('FAIL_AT') == args[0]: sys.exit(37 if args[0]=='sync' else 41)\n"
        "target = pathlib.Path(os.environ['CONTROLLED_NATIVE_RUNTIME'] if os.environ.get('NDDEV_CACHE_PROVIDER') "
        "else os.environ['UV_PROJECT_ENVIRONMENT'])\n"
        "if args[0] == 'sync':\n"
        " (target/'bin').mkdir(parents=True)\n"
        " (target/'bin/python').symlink_to(sys.executable)\n"
        "else:\n"
        " print(os.environ.get('BAD_RESULT',str(target)))\n"
    )
    uv.chmod(0o700)
    project = tmp_path / "project with spaces"
    project.mkdir()
    log = tmp_path / "calls.jsonl"
    env = dict(
        os.environ,
        PROBE_LOG=str(log),
        CONTROLLED_NATIVE_RUNTIME=str(tmp_path / "protected callee"),
        UV_PROJECT_ENVIRONMENT=str(tmp_path / "legacy temporary runtime"),
    )
    env.pop("NDDEV_CACHE_PROVIDER", None)
    return uv, project, log, env


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("selection", [["--group", "quality"], ["--no-dev"]])
def test_reports_actual_prepared_callee_with_the_same_native_selection(runtime_fixture, native, selection):
    uv, project, log, env = runtime_fixture
    if native:
        env["NDDEV_CACHE_PROVIDER"] = "nds"
    before = dict(env)
    result = subprocess.run(
        ["bash", str(HELPER), str(uv), str(project), *selection],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    expected = env["CONTROLLED_NATIVE_RUNTIME"] if native else env["UV_PROJECT_ENVIRONMENT"]
    assert result.stdout == expected + "\n"
    assert (Path(expected) / "bin/python").is_file()
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert [call["args"][0] for call in calls] == ["sync", "run"]
    for call in calls:
        args = call["args"]
        assert args[args.index("--project") + 1] == str(project)
        assert args[args.index("--python") + 1] == "3.13"
        assert all(option in args for option in selection)
        assert "--locked" in args
        assert call["callee"] == env["UV_PROJECT_ENVIRONMENT"]
    assert "--no-sync" in calls[1]["args"]
    assert env == before


@pytest.mark.parametrize(("operation", "code", "count"), [("sync", 37, 1), ("run", 41, 2)])
def test_preserves_original_failure_without_runtime_output(runtime_fixture, operation, code, count):
    uv, project, log, env = runtime_fixture
    result = subprocess.run(
        ["bash", str(HELPER), str(uv), str(project), "--no-dev"],
        env={**env, "FAIL_AT": operation},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == code
    assert not result.stdout
    assert len(log.read_text().splitlines()) == count


@pytest.mark.parametrize("bad", ["relative/runtime", "/absolute\nforeign", "/missing/runtime"])
def test_invalid_probe_result_is_not_exported(runtime_fixture, bad):
    uv, project, _, env = runtime_fixture
    result = subprocess.run(
        ["bash", str(HELPER), str(uv), str(project), "--no-dev"],
        env={**env, "BAD_RESULT": bad},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 2
    assert not result.stdout
