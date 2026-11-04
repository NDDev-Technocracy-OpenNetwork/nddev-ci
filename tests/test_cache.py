"""Cache ownership/admission rejects mistakes before touching another producer's files."""

import os
import subprocess
from pathlib import Path

import pytest

from nddev_cicd import cache
from nddev_cicd.model import Invalid


@pytest.fixture
def nds_settings(tmp_path):
    import hashlib
    import json
    import os
    import shlex

    if os.name == "nt":
        pytest.skip("The native managed-cache protocol is qualified on Linux/macOS")
    binary = tmp_path / "native-cleaner"
    binary.write_text("#!/bin/sh\nprintf '%s\\n' 'nds-cleaner-cache 0.0.1-alpha.5'\n")
    binary.chmod(0o755)
    root = tmp_path / "native-root"
    root.mkdir(mode=0o700)
    (root / ".nds-cache").write_bytes(b"NDS managed rebuildable cache v1\n")
    prefix = tmp_path / "native-frontends"
    prefix.mkdir()
    config = tmp_path / "native-config.json"
    config.write_text(
        json.dumps(
            {
                "schema": 1,
                "root": str(root),
                "frontends": str(prefix),
                "retention_seconds": 86400,
                "environment_root": str(tmp_path / "native-environments"),
            }
        )
    )
    for command in ("cargo", "uv", "bun"):
        path = prefix / command
        path.write_text(
            "#!/bin/sh\n# NDS managed development cache frontend\nexec "
            + shlex.join([str(binary), str(config), command])
            + ' "$@"\n'
        )
        path.chmod(0o755)
    return {
        "NDDEV_CACHE_PROVIDER": "nds",
        "NDS_CLEANER_BIN": str(binary),
        "NDS_CLEANER_BIN_SHA256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "NDS_CLEANER_CONFIG": str(config),
        "NDS_CLEANER_CONFIG_SHA256": hashlib.sha256(config.read_bytes()).hexdigest(),
        "NDS_CACHE_FRONTENDS": str(prefix),
        "PATH": os.environ.get("PATH", ""),
        "UV_PROJECT_ENVIRONMENT": "callee-library-environment",
    }


def test_native_provider_returns_only_caller_safe_environment_delta(nds_settings):
    result = cache.nds_environment(nds_settings)
    assert result is not None
    delta, observed = result
    assert set(delta) == {"PATH"}
    assert delta["PATH"].startswith(nds_settings["NDS_CACHE_FRONTENDS"])
    assert observed["provider"] == "nds" and observed["retention_seconds"] == 86400
    assert observed["collection"] == "external_owner" and observed["hit_observed"] is False


@pytest.mark.parametrize(
    "changed", ["NDS_CLEANER_BIN_SHA256", "NDS_CLEANER_CONFIG_SHA256", "NDS_CACHE_FRONTENDS"]
)
def test_native_provider_rejects_changed_pins_before_execution(nds_settings, changed):
    nds_settings[changed] = "mismatch"
    with pytest.raises(Invalid):
        cache.nds_environment(nds_settings)


def test_native_provider_rejects_unrelated_frontend(nds_settings):
    from pathlib import Path

    (Path(nds_settings["NDS_CACHE_FRONTENDS"]) / "cargo").write_text("#!/bin/sh\nexit 0\n")
    with pytest.raises(Invalid, match="frontends differ"):
        cache.nds_environment(nds_settings)


def test_native_provider_bypasses_legacy_targets_and_retains_caller_settings(
    tmp_path, nds_settings, monkeypatch
):
    import json

    from nddev_cicd import ci

    contract = {
        "profiles": ["rust"],
        "environment": dict(
            nds_settings,
            UV_PROJECT_ENVIRONMENT="caller-project-environment",
            CARGO_TARGET_DIR="caller-target",
        ),
    }
    monkeypatch.setattr(cache, "namespace", lambda *a, **k: pytest.fail("second cache owner was selected"))

    def execute(_root, selected, _output):
        assert selected["environment"]["CARGO_TARGET_DIR"] == "caller-target"
        assert selected["environment"]["UV_PROJECT_ENVIRONMENT"] == "caller-project-environment"
        assert selected["environment"]["PATH"].startswith(nds_settings["NDS_CACHE_FRONTENDS"])
        return {"status": "success"}

    monkeypatch.setattr(ci, "_execute", execute)
    assert ci._execute_cached(tmp_path, contract, tmp_path)["status"] == "success"
    assert json.loads((tmp_path / "cache.json").read_text())["provider"] == "nds"


@pytest.mark.parametrize("age", [0, 3 * 86400])
def test_pressure_or_directory_age_cannot_authorize_opaque_payload_deletion(tmp_path, age):
    import os
    import time

    root = tmp_path / "owned"
    with cache.namespace(root, {"repository": "native-input"}) as payload:
        data = payload / "retained-output"
        data.write_bytes(b"x" * (2 * 1024**2))
    os.utime(payload, (time.time() - age, time.time() - age))
    assert cache.reclaim(root, 1024**2, 0, 86400) == []
    assert data.read_bytes() == b"x" * (2 * 1024**2)


def test_completed_wrapper_does_not_authorize_deletion_under_a_surviving_native_child(tmp_path):
    import subprocess
    import sys

    root = tmp_path / "owned"
    with cache.namespace(root, {"repository": "native-child"}) as payload:
        data = payload / "native-output"
        data.write_text("still in use")
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import pathlib,sys;print('ready',flush=True);sys.stdin.readline();print(pathlib.Path(sys.argv[1]).read_text())",
                str(data),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert child.stdout is not None
        assert child.stdout.readline().strip() == "ready"
    try:
        assert cache.reclaim(root, 1, 0, 86400) == []
        output, error = child.communicate("continue\n", timeout=10)
        assert child.returncode == 0, error
        assert output.strip() == "still in use"
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=10)


@pytest.mark.parametrize("existing_lock", [False, True])
def test_foreign_cache_is_rejected_without_even_a_new_lock_file(tmp_path, existing_lock):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    (foreign / "user-data").write_text("preserved")
    if existing_lock:
        with cache.lock(foreign / ".owner.lock"):
            pass
    before = {p.name: p.read_bytes() for p in foreign.iterdir()}
    with pytest.raises(Invalid, match="unowned"), cache.namespace(foreign, {"fixture": True}):
        raise AssertionError("An unowned cache was entered")
    assert {p.name: p.read_bytes() for p in foreign.iterdir()} == before


def test_parallel_initialization_waits_for_the_owner_marker_publication(tmp_path, monkeypatch):
    import contextlib
    import os
    import threading
    from concurrent.futures import ThreadPoolExecutor

    root = tmp_path / "owned"
    root.mkdir()
    owner = root / ".nddev-cache-owner.json"
    waiting = threading.Event()
    native_lock = cache.lock

    @contextlib.contextmanager
    def observe_lock(path, *, blocking=True):
        if path == root / ".owner.lock":
            waiting.set()
        with native_lock(path, blocking=blocking):
            yield

    def concurrent_namespace():
        with cache.namespace(root, {"fixture": True}, blocking=False) as selected:
            return selected

    monkeypatch.setattr(cache, "lock", observe_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with native_lock(root / ".owner.lock"):
            # Pause the native atomic writer between temporary creation and rename.
            owner.with_name(owner.name + f".tmp-{os.getpid()}").write_text("{")
            contender = pool.submit(concurrent_namespace)
            try:
                assert waiting.wait(2), "Parallel initialization rejected the in-flight owner marker"
                assert not contender.done()
            finally:
                cache.atomic_json(owner, {"schema": 1, "owner": "nddev-cicd"})
        assert contender.result(timeout=2).is_dir()


@pytest.mark.parametrize("bad", [None, True, -1, "1024"])
def test_compiler_cache_budget_is_explicit_and_valid_before_admission(tmp_path, bad):
    with (
        pytest.raises(Invalid),
        cache.compiler(
            tmp_path,
            {"cache_budget_bytes": bad, "cache_min_free_bytes": 0, "cache_ttl_seconds": 60},
            {},
            "contract.toml",
        ),
    ):
        raise AssertionError("Invalid compiler cache was admitted")
    assert not list(tmp_path.iterdir())


def test_cargo_and_compiler_roots_cannot_compete_for_one_retention_budget(tmp_path, monkeypatch):
    root = tmp_path / "shared"
    monkeypatch.setenv("NDDEV_CACHE_ROOT", str(root))
    monkeypatch.setenv("NDDEV_CCACHE_ROOT", str(root))
    policy = {"cache_budget_bytes": 1024**2, "cache_min_free_bytes": 0, "cache_ttl_seconds": 60}
    with pytest.raises(Invalid, match="separate"), cache.compiler(tmp_path, policy, {}, "contract.toml"):
        raise AssertionError("Conflicting cache owners were admitted")
    assert not root.exists()


def test_busy_namespace_does_not_wait_or_modify_active_files(tmp_path):
    with cache.namespace(tmp_path / "owned", {"repository": "fixture"}) as owned:
        (owned / "active").write_text("keep")
        with (
            pytest.raises(BlockingIOError),
            cache.namespace(tmp_path / "owned", {"repository": "fixture"}, blocking=False),
        ):
            raise AssertionError("An active namespace was entered")
        assert (owned / "active").read_text() == "keep"


def test_rust_cache_uses_contract_environment_and_records_reuse(tmp_path, monkeypatch):
    from nddev_cicd import ci

    (tmp_path / "contract.toml").write_text("schema = 1")
    contract = {
        "profiles": ["rust"],
        "_path": "contract.toml",
        "environment": {"NDDEV_CACHE_ROOT": str(tmp_path / "owned")},
        "rust": {
            "cache_budget_bytes": 1024**2,
            "cache_min_free_bytes": 0,
            "cache_ttl_seconds": 60,
        },
    }
    monkeypatch.delenv("NDDEV_CACHE_ROOT", raising=False)
    monkeypatch.setattr(ci.subprocess, "check_output", lambda *a, **k: "rustc fixture")
    directories = []

    def execute(root, selected, output):
        from pathlib import Path

        target = Path(selected["environment"]["CARGO_TARGET_DIR"])
        directories.append(target)
        target.mkdir(exist_ok=True)
        return {"status": "success"}

    monkeypatch.setattr(ci, "_execute", execute)
    ci._execute_with_rust_cache(tmp_path, contract, tmp_path / "first")
    ci._execute_with_rust_cache(tmp_path, contract, tmp_path / "second")
    import json

    assert directories[0] == directories[1]
    assert not json.loads((tmp_path / "first/cache.json").read_text())["target_present"]
    assert json.loads((tmp_path / "second/cache.json").read_text())["target_present"]


def test_opted_in_native_downloads_survive_independent_compiler_namespaces(tmp_path, monkeypatch):
    import json
    from pathlib import Path

    from nddev_cicd import ci

    shared = tmp_path / "native-downloads"
    shared.mkdir()
    archive = shared / "cached.crate"
    archive.write_bytes(b"owner-provided native registry input")
    monkeypatch.setenv("NDDEV_CARGO_DOWNLOAD_CACHE", str(shared))
    monkeypatch.setenv("CARGO_HOME", str(shared))
    monkeypatch.setattr(ci.subprocess, "check_output", lambda *a, **k: "rustc fixture")
    (tmp_path / "contract.toml").write_text("schema = 1")
    environments = []

    def execute(_root, selected, _output):
        environment = selected["environment"]
        environments.append(environment.copy())
        Path(environment["CARGO_TARGET_DIR"]).mkdir(exist_ok=True)
        return {"status": "success"}

    monkeypatch.setattr(ci, "_execute", execute)
    for producer in ("first", "second"):
        contract = {
            "profiles": ["rust"],
            "_path": "contract.toml",
            "environment": {"NDDEV_CACHE_ROOT": str(tmp_path / producer)},
            "rust": {"cache_budget_bytes": 1024**2, "cache_min_free_bytes": 0, "cache_ttl_seconds": 60},
        }
        output = tmp_path / (producer + "-result")
        assert ci._execute_with_rust_cache(tmp_path, contract, output)["status"] == "success"
        assert json.loads((output / "cache.json").read_text())["downloads_shared"] is True
    assert environments[0]["CARGO_HOME"] == environments[1]["CARGO_HOME"] == str(shared)
    assert environments[0]["CARGO_TARGET_DIR"] != environments[1]["CARGO_TARGET_DIR"]
    # An older queued caller can still use the same producer's private home.
    # It must not alternate the shared caller's mutable compiler target.
    monkeypatch.setenv("CARGO_HOME", str(tmp_path / "lane"))
    contract["environment"] = {"NDDEV_CACHE_ROOT": str(tmp_path / "first")}
    output = tmp_path / "legacy-result"
    ci._execute_with_rust_cache(tmp_path, contract, output)
    assert environments[-1]["CARGO_HOME"] != str(shared)
    assert environments[-1]["CARGO_TARGET_DIR"] != environments[0]["CARGO_TARGET_DIR"]
    assert json.loads((output / "cache.json").read_text())["downloads_shared"] is False
    assert archive.read_bytes() == b"owner-provided native registry input"


@pytest.mark.parametrize("changed", [None, "pin", "frontend", "provider"])
def test_selected_bootstrap_uses_native_admission_without_public_fallback(tmp_path, nds_settings, changed):
    # The bootstrap runs before package metadata exists; only native host Python is available.
    marker = tmp_path / "public-request"
    blocked = tmp_path / "blocked-network"
    blocked.mkdir()
    curl = blocked / "curl"
    curl.write_text('#!/bin/sh\nprintf blocked > "$MARKER"\nexit 97\n')
    curl.chmod(0o755)
    environment = {
        **nds_settings,
        "PATH": str(blocked) + os.pathsep + os.environ["PATH"],
        "RUNNER_TEMP": str(tmp_path),
        "NDDEV_ARTIFACT_CACHE": str(tmp_path / "missing-prepared-store"),
        "MARKER": str(marker),
    }
    if changed == "pin":
        environment["NDS_CLEANER_CONFIG_SHA256"] = "0" * 64
    elif changed == "frontend":
        (Path(environment["NDS_CACHE_FRONTENDS"]) / "uv").write_text("#!/bin/sh\nexit 0\n")
    elif changed == "provider":
        environment["NDDEV_CACHE_PROVIDER"] = "unavailable"
    result = subprocess.run(
        ["bash", str(Path(__file__).parents[1] / "scripts/library-uv.sh")],
        check=False,
        env=environment,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == (0 if changed is None else 2), result.stderr
    assert result.stdout.strip() == (
        str(Path(__file__).parents[1] / "src/nddev_cicd/native_frontends/library-uv")
        if changed is None
        else ""
    )
    assert not marker.exists()
    assert not list(tmp_path.glob("nddev-library-uv.*"))


def test_library_bootstrap_strips_only_callee_overrides_and_keeps_caller_input(nds_settings):
    from nddev_cicd.native_cache import bootstrap_environment

    original = dict(
        nds_settings,
        UV_PROJECT="caller-project",
        UV_WORKING_DIR="caller-directory",
        VIRTUAL_ENV="caller-active",
        PYTHONPATH="caller-imports",
        UV_PYTHON="3.13",
    )
    child = bootstrap_environment(original)
    assert original["UV_PROJECT_ENVIRONMENT"] == "callee-library-environment"
    assert original["UV_PROJECT"] == "caller-project"
    assert (
        not {"UV_PROJECT_ENVIRONMENT", "UV_PROJECT", "UV_WORKING_DIR", "VIRTUAL_ENV", "PYTHONPATH"}
        & child.keys()
    )
    assert child["UV_PYTHON"] == "3.13"
    admitted = cache.nds_environment(nds_settings)
    assert admitted is not None and set(admitted[0]) == {"PATH"}


def test_selected_library_bootstrap_refuses_missing_protected_environment_root(nds_settings):
    import hashlib
    import json

    from nddev_cicd.native_cache import InvalidNativeCache, bootstrap_environment

    path = Path(nds_settings["NDS_CLEANER_CONFIG"])
    settings = json.loads(path.read_text())
    settings.pop("environment_root")
    path.write_text(json.dumps(settings))
    nds_settings["NDS_CLEANER_CONFIG_SHA256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(InvalidNativeCache, match="protected environment root"):
        bootstrap_environment(nds_settings)
    # An explicit caller environment still has its independent native admission.
    assert cache.nds_environment(nds_settings) is not None
