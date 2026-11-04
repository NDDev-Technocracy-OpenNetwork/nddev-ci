"""Native central preparation preserves caller selection and refuses unqualified source closure."""

import os
import subprocess
from pathlib import Path

import pytest

from nddev_cicd.native_uv import InvalidUV, build_constraints, central_index, invocation, qualified_lock


@pytest.mark.parametrize(
    "index",
    [
        "",
        "https://user:secret@example.test/simple/",
        "http://example.test/simple/",
        "https://example.test/simple/?token=secret",
        "https://example.test/#other",
        "file:///index",
    ],
)
def test_central_index_rejects_unqualified_or_credential_routes(index):
    with pytest.raises(InvalidUV):
        central_index({"NDDEV_UV_CENTRAL_INDEX": index})


def test_central_index_preserves_separate_native_store_selection():
    assert central_index({}) is None
    index = "https://cache.example.test/simple/"
    assert central_index({"NDDEV_UV_CENTRAL_INDEX": index}) == index
    with pytest.raises(InvalidUV, match="overrides"):
        central_index(
            {"NDDEV_UV_CENTRAL_INDEX": index, "UV_EXTRA_INDEX_URL": "https://private.example.test/"}
        )


def test_run_keeps_program_arguments_outside_preparation(tmp_path):
    argv = [
        "run",
        "--project",
        "callee",
        "--locked",
        "--no-dev",
        "--extra",
        "tools",
        "--group=qa",
        "--python",
        "3.13",
        "python",
        "--project",
        "other",
        "--with",
        "not-a-dependency",
    ]
    selected = invocation(argv, tmp_path)
    assert selected.project == tmp_path / "callee"
    assert selected.selection == ["--no-dev", "--extra", "tools", "--group", "qa"]
    assert selected.python == "3.13" and selected.inexact
    assert selected.original == argv


def test_workspace_selection_and_module_execution_are_native(tmp_path):
    selected = invocation(
        [
            "--directory",
            "checkout",
            "run",
            "--package=app",
            "--all-groups",
            "--no-group",
            "docs",
            "--all-extras",
            "--no-extra",
            "unused",
            "--no-install-project",
            "--no-install-package=hidden",
            "--exact",
            "-m",
            "app",
            "--group",
            "program-argument",
        ],
        tmp_path,
    )
    assert selected.directory == selected.project == tmp_path / "checkout"
    assert selected.selection == [
        "--package",
        "app",
        "--all-groups",
        "--no-group",
        "docs",
        "--all-extras",
        "--no-extra",
        "unused",
        "--no-emit-project",
        "--no-emit-package",
        "hidden",
    ]
    assert not selected.inexact


@pytest.mark.parametrize(
    "arguments",
    [
        ["run", "--with", "dependency", "python"],
        ["run", "--script", "program.py"],
        ["sync", "--index", "private"],
        ["sync", "--group"],
        ["sync", "unexpected"],
    ],
)
def test_unsupported_operation_refuses_before_sdk_or_transport(tmp_path, arguments):
    with pytest.raises(InvalidUV):
        invocation(arguments, tmp_path)


def lock_project(root, source, backend='build-backend="uv_build"\nrequires=["uv_build>=0.13.1,<0.14"]'):
    (root / "pyproject.toml").write_text(
        '[project]\nname="probe"\nversion="0.0.0"\n[build-system]\n' + backend + "\n"
    )
    (root / "uv.lock").write_text(
        'version=1\n[[package]]\nname="probe"\nversion="0.0.0"\nsource={editable="."}\n[[package]]\nname="dep"\nversion="1.0.0"\nsource={'
        + source
        + "}\n"
    )


@pytest.mark.parametrize(
    "source",
    [
        'git="https://example.test/source"',
        'url="https://example.test/wheel.whl"',
        'registry="https://private.example.test/simple"',
        'directory="../outside"',
    ],
)
def test_lock_source_closure_refuses_direct_vcs_private_and_outside_workspace(tmp_path, source):
    lock_project(tmp_path, source)
    with pytest.raises(InvalidUV):
        qualified_lock(tmp_path)


def test_native_manifest_and_lock_are_retained_as_inputs(tmp_path):
    lock_project(tmp_path, 'registry="https://pypi.org/simple"')
    originals = qualified_lock(tmp_path)
    assert set(originals) == {tmp_path / "pyproject.toml", tmp_path / "uv.lock"}
    assert all(path.read_bytes() == content for path, content in originals.items())


def test_unqualified_build_backend_refuses_before_preparation(tmp_path):
    lock_project(
        tmp_path,
        'registry="https://pypi.org/simple"',
        'build-backend="custom.backend"\nrequires=["custom @ https://example.test/build.whl"]',
    )
    with pytest.raises(InvalidUV, match="backend"):
        qualified_lock(tmp_path)


def test_custom_hatch_hook_is_outside_the_exact_static_backend_proof(tmp_path):
    lock_project(
        tmp_path,
        'registry="https://pypi.org/simple"',
        'build-backend="hatchling.build"\nrequires=["hatchling>=1.27"]\n[tool.hatch.build.hooks.custom]',
    )
    with pytest.raises(InvalidUV, match="backend"):
        qualified_lock(tmp_path)


def test_selected_central_bootstrap_needs_native_provider_before_public_download(tmp_path):
    if os.name == "nt":
        pytest.skip("Selected native bridge is qualified for POSIX hosts")
    result = subprocess.run(
        ["bash", str(Path(__file__).parents[1] / "scripts/library-uv.sh")],
        check=False,
        env={
            **os.environ,
            "RUNNER_TEMP": str(tmp_path),
            "NDDEV_CACHE_PROVIDER": "",
            "NDDEV_UV_CENTRAL_INDEX": "https://cache.example.test/simple/",
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 2 and not result.stdout
    assert "explicit native cache provider" in result.stderr
    assert not list(tmp_path.iterdir())


def test_bridge_delimits_program_options_without_leaking_offline_environment(tmp_path, monkeypatch):
    from nddev_cicd import native_uv

    environment = {
        "NDDEV_UV_CENTRAL_INDEX": "https://cache.example.test/simple/",
        "NDS_CACHE_FRONTENDS": str(tmp_path),
    }
    observed = []
    monkeypatch.setattr(
        native_uv.subprocess, "call", lambda command, env: observed.append((command, env)) or 0
    )
    assert native_uv.execute(["run", "--no-sync", "python", "--project", "opaque"], environment) == 0
    assert observed == [
        (
            [
                str(tmp_path / "uv"),
                "--offline",
                "--no-python-downloads",
                "run",
                "--no-sync",
                "--",
                "python",
                "--project",
                "opaque",
            ],
            environment,
        )
    ]
    assert "UV_OFFLINE" not in environment


def test_static_hatch_packages_mapping_is_qualified(tmp_path):
    package = tmp_path / "src/probe"
    package.mkdir(parents=True)
    lock_project(
        tmp_path,
        'registry="https://pypi.org/simple"',
        'build-backend="hatchling.build"\nrequires=["hatchling==1.29.0"]\n'
        '[tool.hatch.build.targets.wheel]\npackages=["src/probe"]',
    )
    assert tmp_path / "pyproject.toml" in qualified_lock(tmp_path)


@pytest.mark.parametrize(
    "setting",
    [
        "[tool.hatch.build.hooks.custom]",
        '[tool.hatch.build.targets.wheel]\npackages=["../outside"]',
        "[tool.hatch.build.targets.wheel]\npackages=[]",
        '[tool.hatch.build.targets.wheel]\npackages=["src/probe"]\nonly-include=["other"]',
    ],
)
def test_hatch_configuration_does_not_admit_hooks_or_outside_inputs(tmp_path, setting):
    (tmp_path / "src/probe").mkdir(parents=True)
    lock_project(
        tmp_path,
        'registry="https://pypi.org/simple"',
        'build-backend="hatchling.build"\nrequires=["hatchling==1.29.0"]\n' + setting,
    )
    with pytest.raises(InvalidUV):
        qualified_lock(tmp_path)


def test_registry_source_builds_are_explicit_native_hash_constrained(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        "[tool.uv]\nrequire-build-hashes=true\n"
        'build-constraint-dependencies=[{requirement="wheel==0.48.0",hashes=["sha256:' + "a" * 64 + '"]}]\n'
    )
    assert build_constraints(tmp_path) == "wheel==0.48.0 --hash=sha256:" + "a" * 64 + "\n"


@pytest.mark.parametrize(
    "constraints",
    [
        "[]",
        '["wheel==0.48.0"]',
        '[{requirement="wheel>=0.48",hashes=["sha256:' + "a" * 64 + '"]}]',
        '[{requirement="wheel==0.48.0",hashes=[]}]',
        '[{requirement="wheel @ https://example.test/wheel.whl",hashes=["sha256:' + "a" * 64 + '"]}]',
        '[{requirement="wheel==0.48.0",hashes=["not-a-digest"]}]',
    ],
)
def test_incomplete_or_foreign_build_constraints_refuse(tmp_path, constraints):
    (tmp_path / "pyproject.toml").write_text(
        "[tool.uv]\nrequire-build-hashes=true\nbuild-constraint-dependencies=" + constraints + "\n"
    )
    with pytest.raises(InvalidUV):
        build_constraints(tmp_path)


def test_default_transport_stays_wheels_only(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname="probe"\nversion="0.0.0"\n')
    assert build_constraints(tmp_path) is None


@pytest.mark.parametrize(
    "key", ["UV_BUILD_CONSTRAINT", "UV_NO_BUILD_ISOLATION", "UV_NO_BUILD_ISOLATION_PACKAGE"]
)
def test_build_environment_overrides_cannot_weaken_native_hash_preparation(key):
    with pytest.raises(InvalidUV, match="overrides"):
        central_index({"NDDEV_UV_CENTRAL_INDEX": "https://cache.example.test/simple/", key: "foreign"})
