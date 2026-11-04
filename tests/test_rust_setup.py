import os
import subprocess
from pathlib import Path
from shutil import which as native_which

import pytest

from nddev_cicd import rust_setup
from nddev_cicd.model import Invalid, Unavailable


@pytest.fixture
def installed(tmp_path, monkeypatch):
    proxy = tmp_path / "bin"
    proxy.mkdir()
    for name in ("rustup", "rustc", "cargo"):
        (proxy / name).touch()
    monkeypatch.setattr(rust_setup.shutil, "which", lambda _: str(proxy / "rustup"))
    commands = []

    def native(arguments, **_):
        commands.append(arguments)
        if arguments[0] == "run":
            return "rustc 1.99.1\nrelease: 1.99.1\nhost: x86_64-unknown-linux-gnu"
        if arguments[0] == "component":
            return "rustfmt-x86_64-unknown-linux-gnu\nclippy-x86_64-unknown-linux-gnu"
        if arguments[0] == "target":
            return "x86_64-unknown-linux-gnu\nwasm32-unknown-unknown"
        raise AssertionError("Installed SDK must never perform installation")

    monkeypatch.setattr(rust_setup, "native", native)
    return commands


def test_prepared_exact_toolchain_components_and_targets_do_not_install(installed):
    result = rust_setup.prepare("1.99.1", ["clippy", "rustfmt"], ["wasm32-unknown-unknown"])
    assert result["reused"] is True
    assert {command[0] for command in installed} == {"run", "component", "target"}


def test_missing_exact_toolchain_does_not_select_the_installed_default(installed, monkeypatch):
    original = rust_setup.native

    def absent(arguments, **kwargs):
        if arguments[0] == "run":
            raise subprocess.CalledProcessError(1, "rustup", stderr="toolchain '1.99.0' is not installed")
        return original(arguments, **kwargs)

    monkeypatch.setattr(rust_setup, "native", absent)
    with pytest.raises(Unavailable, match="exact requested.*not installed"):
        rust_setup.prepare("1.99.0", [], [], allow_install=False)
    assert not installed


def test_install_only_missing_components_and_targets_and_verify_native_result(installed, monkeypatch):
    additions = {"component": set(), "target": set()}
    original = rust_setup.native

    def native(arguments, **kwargs):
        kind = arguments[0]
        if len(arguments) > 1 and arguments[1] == "add":
            assert arguments[2:4] == ["--toolchain", "1.99.1"]
            additions[kind].update(arguments[4:])
            return ""
        value = original(arguments, **kwargs)
        return value + "\n" + "\n".join(additions.get(kind, set()))

    monkeypatch.setattr(rust_setup, "native", native)
    result = rust_setup.prepare(
        "1.99.1", ["clippy", "rust-src"], ["wasm32-unknown-unknown", "aarch64-linux-android"]
    )
    assert result["reused"] is False
    assert additions == {"component": {"rust-src"}, "target": {"aarch64-linux-android"}}


def test_missing_component_is_not_silently_skipped(installed):
    with pytest.raises(Unavailable, match="components or targets are absent"):
        rust_setup.prepare("1.99.1", ["rust-src"], [], allow_install=False)


def test_broken_installed_toolchain_is_not_replaced_or_retried(installed, monkeypatch):
    def fail(*_, **__):
        raise subprocess.CalledProcessError(1, "rustup", stderr="permission denied")

    monkeypatch.setattr(rust_setup, "native", fail)
    with pytest.raises(Invalid, match="compiler did not run"):
        rust_setup.prepare("1.99.1", [], [])


def test_native_compiler_must_match_requested_release(installed):
    with pytest.raises(Invalid, match="identity differs"):
        rust_setup.prepare("1.99.0", [], [])


@pytest.mark.parametrize("pin", ["stable", "nightly", "beta", "1.99", "../sdk", "1.99.1\nINJECT=1"])
def test_refuse_floating_or_malformed_toolchain_selection(pin):
    with pytest.raises(Invalid, match="exact release"):
        rust_setup.prepare(pin, [], [])


@pytest.mark.parametrize("failure,expected", [("connection reset", 2), ("component unavailable", 1)])
def test_retry_only_transient_native_install_failure(monkeypatch, failure, expected):
    calls = []

    def fail(*args, **_):
        calls.append(args)
        raise subprocess.CalledProcessError(1, "rustup", stderr=failure)

    monkeypatch.setattr(rust_setup, "native", fail)
    with pytest.raises(Unavailable if expected == 2 else Invalid):
        rust_setup.install(["component", "add", "clippy"])
    assert len(calls) == expected


def test_cancelled_install_is_not_retried(monkeypatch):
    calls = []

    def cancel(*args, **_):
        calls.append(args)
        raise KeyboardInterrupt

    monkeypatch.setattr(rust_setup, "native", cancel)
    with pytest.raises(KeyboardInterrupt):
        rust_setup.install(["toolchain", "install", "1.99.1"])
    assert len(calls) == 1


def test_native_file_commands_select_exact_proxies_without_changing_shared_defaults(
    installed, tmp_path, monkeypatch
):
    environment, path = tmp_path / "env", tmp_path / "path"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.setenv("GITHUB_PATH", str(path))
    result = rust_setup.prepare("1.99.1", [], [])
    rust_setup.export(result)
    assert environment.read_text() == "RUSTUP_TOOLCHAIN=1.99.1\nRUSTUP_AUTO_INSTALL=0\n"
    assert path.read_text() == result["proxy_directory"] + "\n"


def test_native_cache_stays_before_sdk_in_actual_following_step_lookup(installed, tmp_path, monkeypatch):
    from nddev_cicd import cache

    environment, path = tmp_path / "env", tmp_path / "path"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.setenv("GITHUB_PATH", str(path))
    monkeypatch.setenv("NDDEV_CACHE_PROVIDER", "nds")
    result = rust_setup.prepare("1.99.1", [], [])
    proxy = Path(result["proxy_directory"])
    frontends, bridge = tmp_path / "native-bin", tmp_path / "bridge"
    frontends.mkdir()
    bridge.mkdir()
    suffix = ".cmd" if os.name == "nt" else ""
    for folder, tool, label in (
        (frontends, "cargo", "managed"),
        (proxy, "cargo", "sdk"),
        (proxy, "rustc", "exact-sdk"),
    ):
        executable = folder / (tool + suffix)
        executable.write_text(
            "@echo off\n@echo " + label + "\n"
            if os.name == "nt"
            else "#!/bin/sh\nprintf '%s\\n' " + label + "\n"
        )
        executable.chmod(0o755)

    def admitted(values):
        assert values["PATH"] == str(proxy)
        assert values["NDDEV_CACHE_PROVIDER"] == "nds"
        return ({"PATH": os.pathsep.join(map(str, (bridge, frontends, proxy)))}, {})

    monkeypatch.setattr(cache, "nds_environment", admitted)
    rust_setup.export(result)
    # GITHUB_PATH is processed in order and the runner prepends its list in reverse.
    following_path = os.pathsep.join(reversed(path.read_text().splitlines()))
    cargo = native_which("cargo", path=following_path)
    assert cargo is not None
    assert Path(cargo) == frontends / ("cargo" + suffix)
    compiler = native_which("rustc", path=following_path)
    assert compiler is not None and Path(compiler) == proxy / ("rustc" + suffix)
    if os.name != "nt":
        assert subprocess.check_output([cargo], text=True).strip() == "managed"
    assert environment.read_text() == "RUSTUP_TOOLCHAIN=1.99.1\nRUSTUP_AUTO_INSTALL=0\n"


def test_unavailable_native_provider_does_not_export_partial_sdk_fallback(installed, tmp_path, monkeypatch):
    from nddev_cicd import cache

    environment, path = tmp_path / "env", tmp_path / "path"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.setenv("GITHUB_PATH", str(path))
    result = rust_setup.prepare("1.99.1", [], [])

    def unavailable(_):
        raise Invalid("Selected native cache unavailable")

    monkeypatch.setattr(cache, "nds_environment", unavailable)
    with pytest.raises(Invalid, match="native cache unavailable"):
        rust_setup.export(result)
    assert not environment.exists() and not path.exists()


def test_native_path_separator_injection_is_refused_before_file_commands(installed, tmp_path, monkeypatch):
    from nddev_cicd import cache

    environment, path = tmp_path / "env", tmp_path / "path"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.setenv("GITHUB_PATH", str(path))
    monkeypatch.setattr(cache, "nds_environment", lambda _: ({"PATH": "/native\n/untrusted"}, {}))
    with pytest.raises(Invalid, match="file-command-safe"):
        rust_setup.export(rust_setup.prepare("1.99.1", [], []))
    assert not environment.exists() and not path.exists()


def test_shared_downloads_are_explicit_and_keep_advisory_state_separate(installed, tmp_path, monkeypatch):
    shared, lane = tmp_path / "shared", tmp_path / "lane"
    monkeypatch.setenv("NDDEV_CARGO_DOWNLOAD_CACHE", str(shared))
    monkeypatch.setenv("CARGO_HOME", str(lane))
    monkeypatch.delenv("NDDEV_RUSTSEC_CACHE_ROOT", raising=False)
    assert "download_cache" not in rust_setup.prepare("1.99.1", [], [])
    result = rust_setup.prepare("1.99.1", [], [], shared_downloads=True)
    environment = tmp_path / "env"
    monkeypatch.setenv("GITHUB_ENV", str(environment))
    monkeypatch.delenv("GITHUB_PATH", raising=False)
    rust_setup.export(result)
    assert f"CARGO_HOME={shared}\n" in environment.read_text()
    assert f"NDDEV_RUSTSEC_CACHE_ROOT={lane / 'nddev-rustsec'}\n" in environment.read_text()
    assert "CARGO_TARGET_DIR=" not in environment.read_text()
    monkeypatch.setenv("CARGO_HOME", str(shared))
    monkeypatch.setenv("NDDEV_RUSTSEC_CACHE_ROOT", str(lane / "nddev-rustsec"))
    assert rust_setup.prepare("1.99.1", [], [], shared_downloads=True)["rustsec_cache"] == str(
        lane / "nddev-rustsec"
    )


def test_shared_download_request_without_host_hint_preserves_hosted_behavior(installed, monkeypatch):
    monkeypatch.delenv("NDDEV_CARGO_DOWNLOAD_CACHE", raising=False)
    assert "download_cache" not in rust_setup.prepare("1.99.1", [], [], shared_downloads=True)


@pytest.mark.parametrize("location", ["relative/cache", "/cache\nINJECT=1"])
def test_shared_download_root_rejects_file_command_injection(installed, monkeypatch, location):
    monkeypatch.setenv("NDDEV_CARGO_DOWNLOAD_CACHE", location)
    with pytest.raises(Invalid, match="absolute nonsymlink"):
        rust_setup.prepare("1.99.1", [], [], shared_downloads=True)
