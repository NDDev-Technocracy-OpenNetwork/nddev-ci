import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "hosted-cache.py"
spec = importlib.util.spec_from_file_location("hosted_cache", SCRIPT)
assert spec and spec.loader
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    (root / "app").mkdir(parents=True)
    (root / "app" / "Cargo.lock").write_text("version = 4\n")
    (root / "app" / "go.sum").write_text("example.com/m v1.0.0 h1:x\n")
    (root / "app" / "web").mkdir()
    (root / "app" / "web" / "bun.lock").write_text("{}\n")
    (root / "app" / "node_modules" / "dep").mkdir(parents=True)
    (root / "app" / "node_modules" / "dep" / "bun.lock").write_text("ignored\n")
    return root


def environment(workspace: Path, tmp_path: Path, **values: str) -> dict[str, str]:
    base = {
        "GITHUB_WORKSPACE": str(workspace),
        "RUNNER_TEMP": str(tmp_path / "temp"),
        "RUNNER_OS": "Linux",
        "RUNNER_ARCH": "X64",
        "NDDEV_RUNNER_ENVIRONMENT": "github-hosted",
        "NDDEV_EVENT": "pull_request",
        "NDDEV_REF": "refs/pull/7/merge",
        "NDDEV_DEFAULT_BRANCH": "main",
        "NDDEV_WORKING_DIRECTORY": "app",
        "NDDEV_ECOSYSTEMS": "cargo bun go",
    }
    return {**base, **values}


def test_pull_requests_restore_without_saving(workspace: Path, tmp_path: Path) -> None:
    outputs, exports = hosted.plan(environment(workspace, tmp_path))
    assert outputs["enabled"] == "true" and outputs["save"] == "false"
    assert outputs["cargo"] == "true" and outputs["cargo-workspaces"] == "app -> target"
    assert outputs["files"] == "true"
    assert outputs["key"].startswith(outputs["restore-keys"])
    assert outputs["restore-keys"].startswith("nddev-hosted-v1-linux-x64-bun-go-")
    assert exports["CARGO_INCREMENTAL"] == "0"
    assert Path(exports["BUN_INSTALL_CACHE_DIR"]).is_dir()
    assert outputs["paths"].splitlines() == [
        exports["BUN_INSTALL_CACHE_DIR"],
        exports["GOMODCACHE"],
        exports["GOCACHE"],
    ]


@pytest.mark.parametrize(
    ("event", "ref", "policy", "expected"),
    [
        ("push", "refs/heads/main", "auto", "true"),
        ("workflow_dispatch", "refs/heads/main", "auto", "true"),
        ("push", "refs/heads/dev", "auto", "false"),
        ("pull_request_target", "refs/heads/main", "auto", "false"),
        ("schedule", "refs/heads/main", "auto", "false"),
        ("push", "refs/heads/main", "never", "false"),
    ],
)
def test_only_trusted_default_branch_runs_save(
    workspace: Path, tmp_path: Path, event: str, ref: str, policy: str, expected: str
) -> None:
    values = environment(workspace, tmp_path, NDDEV_EVENT=event, NDDEV_REF=ref, NDDEV_SAVE=policy)
    assert hosted.plan(values)[0]["save"] == expected


def test_self_hosted_runners_keep_owned_caches(workspace: Path, tmp_path: Path) -> None:
    values = environment(workspace, tmp_path, NDDEV_RUNNER_ENVIRONMENT="self-hosted", NDDEV_EVENT="push")
    outputs, exports = hosted.plan(values)
    assert outputs["enabled"] == "false" and outputs["save"] == "false" and outputs["files"] == "false"
    assert exports == {}


def test_key_follows_lock_content_and_ignores_vendored_locks(workspace: Path, tmp_path: Path) -> None:
    values = environment(workspace, tmp_path)
    first = hosted.plan(values)[0]["key"]
    (workspace / "app" / "node_modules" / "dep" / "bun.lock").write_text("changed\n")
    assert hosted.plan(values)[0]["key"] == first
    (workspace / "app" / "web" / "bun.lock").write_text('{"changed": true}\n')
    second = hosted.plan(values)[0]
    assert second["key"] != first and second["restore-keys"] == hosted.plan(values)[0]["restore-keys"]


def test_profile_key_separates_jobs_that_build_differently(workspace: Path, tmp_path: Path) -> None:
    shared = hosted.plan(environment(workspace, tmp_path))[0]
    clippy = hosted.plan(environment(workspace, tmp_path, NDDEV_KEY="clippy"))[0]
    tests = hosted.plan(environment(workspace, tmp_path, NDDEV_KEY="test"))[0]
    assert len({shared["cargo-key"], clippy["cargo-key"], tests["cargo-key"]}) == 3
    assert clippy["cargo-key"] == shared["cargo-key"] + ".clippy"
    assert clippy["key"].startswith(clippy["restore-keys"])
    # actions/cache restore-keys match by prefix: no profile may restore another one's entry.
    nested = hosted.plan(environment(workspace, tmp_path, NDDEV_KEY="test_race"))[0]
    plans = [shared, clippy, tests, nested]
    for restoring in plans:
        for saved in plans:
            if restoring is not saved:
                assert not saved["key"].startswith(restoring["restore-keys"])
    blank = hosted.plan(environment(workspace, tmp_path, NDDEV_KEY="  "))[0]
    assert blank["cargo-key"] == shared["cargo-key"] and blank["key"] == shared["key"]


@pytest.mark.parametrize("name", ["uv", "library"])
def test_uv_caching_is_routed_to_setup_uv(workspace: Path, tmp_path: Path, name: str) -> None:
    with pytest.raises(hosted.Invalid, match="astral-sh/setup-uv"):
        hosted.plan(environment(workspace, tmp_path, NDDEV_ECOSYSTEMS=f"cargo {name}"))


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"NDDEV_ECOSYSTEMS": ""}, "at least one"),
        ({"NDDEV_ECOSYSTEMS": "cargo maven"}, "Unknown ecosystem: maven"),
        ({"NDDEV_SAVE": "always"}, "auto or never"),
        ({"NDDEV_WORKING_DIRECTORY": "../outside"}, "inside the workspace"),
        ({"NDDEV_WORKING_DIRECTORY": "/tmp"}, "relative"),
        ({"NDDEV_WORKING_DIRECTORY": "missing"}, "does not exist"),
        ({"NDDEV_ECOSYSTEMS": "npm"}, "npm needs a committed lockfile"),
        ({"NDDEV_ECOSYSTEMS": "cargo", "NDDEV_WORKING_DIRECTORY": "app/web"}, "Cargo.lock"),
        ({"NDDEV_KEY": "a,b"}, "key must be"),
        ({"NDDEV_KEY": "a.b"}, "key must be"),
        ({"NDDEV_KEY": "a-b"}, "key must be"),
        ({"NDDEV_KEY": "x" * 41}, "key must be"),
    ],
)
def test_invalid_selection_fails_explicitly(
    workspace: Path, tmp_path: Path, values: dict[str, str], message: str
) -> None:
    with pytest.raises(hosted.Invalid, match=message):
        hosted.plan(environment(workspace, tmp_path, **values))


def test_outputs_use_native_multiline_file_commands(tmp_path: Path) -> None:
    target = tmp_path / "output"
    hosted._write(str(target), {"single": "value", "paths": "/a\n/b"})
    assert target.read_text() == "single=value\npaths<<NDDEV_EOF\n/a\n/b\nNDDEV_EOF\n"
