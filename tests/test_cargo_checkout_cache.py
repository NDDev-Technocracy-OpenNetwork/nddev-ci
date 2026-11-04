"""Native offline Cargo reuse must not retain another checkout's compile-time paths."""

import copy
import json
import os
import shutil
import subprocess

import pytest

from nddev_cicd import ci


@pytest.mark.skipif(
    not shutil.which("cargo") or not shutil.which("rustc"), reason="native Cargo/Rust required"
)
def test_relocated_checkout_rebuilds_and_same_checkout_stays_warm(tmp_path, monkeypatch):
    first = tmp_path / "first"
    (first / "src").mkdir(parents=True)
    (first / "Cargo.toml").write_text('[package]\nname="checkout-fixture"\nversion="0.1.0"\nedition="2021"\n')
    (first / "Cargo.lock").write_text(
        'version = 3\n[[package]]\nname = "checkout-fixture"\nversion = "0.1.0"\n'
    )
    (first / "contract.toml").write_text("schema=1")
    (first / "input.txt").write_text("current checkout")
    (first / "src/lib.rs").write_text("""#[test]
fn reads_its_compiled_checkout() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/input.txt");
    assert_eq!(std::fs::read_to_string(path).expect("compiled checkout exists"), "current checkout");
}
""")
    common = tmp_path / "downloads"
    common.mkdir()
    (common / "owner-input").write_bytes(b"preserved shared download")
    contract = {
        "profiles": ["rust"],
        "_path": "contract.toml",
        "environment": {
            "NDDEV_CACHE_ROOT": str(tmp_path / "cache"),
            "NDDEV_CARGO_DOWNLOAD_CACHE": str(common),
            "CARGO_HOME": str(common),
            "RUSTC_WRAPPER": "",
        },
        "rust": {"cache_budget_bytes": 128 * 1024**2, "cache_min_free_bytes": 0, "cache_ttl_seconds": 3600},
    }
    monkeypatch.setenv("GITHUB_REPOSITORY", "Example/checkout-fixture")
    executions = []

    def native(root, selected, output):
        environment = {**os.environ, **selected["environment"]}
        result = subprocess.run(
            ["cargo", "test", "--locked", "--offline", "--verbose"],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        executions.append((environment, result.stdout + result.stderr))
        assert result.returncode == 0, result.stdout + result.stderr
        return {"status": "success"}

    monkeypatch.setattr(ci, "_execute", native)
    ci._execute_with_rust_cache(first, copy.deepcopy(contract), tmp_path / "result-a")
    second = tmp_path / "second"
    shutil.copytree(first, second, copy_function=shutil.copy2)
    assert (first / "src/lib.rs").stat().st_mtime_ns == (second / "src/lib.rs").stat().st_mtime_ns
    shutil.rmtree(first)
    ci._execute_with_rust_cache(second, copy.deepcopy(contract), tmp_path / "result-b")
    ci._execute_with_rust_cache(second, copy.deepcopy(contract), tmp_path / "result-warm")
    a, b, warm = executions
    assert a[0]["CARGO_HOME"] == b[0]["CARGO_HOME"] == warm[0]["CARGO_HOME"] == str(common)
    assert a[0]["CARGO_TARGET_DIR"] != b[0]["CARGO_TARGET_DIR"] == warm[0]["CARGO_TARGET_DIR"]
    assert "Compiling checkout-fixture" in b[1] and "Fresh checkout-fixture" in warm[1]
    assert not json.loads((tmp_path / "result-b/cache.json").read_text())["target_present"]
    assert json.loads((tmp_path / "result-warm/cache.json").read_text())["target_present"]
    assert (common / "owner-input").read_bytes() == b"preserved shared download"
