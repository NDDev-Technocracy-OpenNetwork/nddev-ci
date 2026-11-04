"""Real native fuzz/mutation/benchmark acceptance, with controlled defects and retained failing inputs."""

import json
import os
import shutil
import subprocess
from pathlib import Path

from nddev_cicd import ci, config
from nddev_cicd.__main__ import main
from nddev_cicd.model import git


def project(repository, name):
    root = repository(
        {"README.md": "# Native advanced fixture\n", ".gitignore": "target/\n.venv/\n.nddev-reports/\n"}
    )
    shutil.copytree(
        Path(__file__).parent / "native" / name,
        root,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns(
            "target",
            ".venv",
            "__pycache__",
            ".pytest_cache",
            "node_modules",
            "mutants",
            ".stryker-tmp",
            "reports",
        ),
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "actual native fixture")
    return root


def test_actual_rust_fuzzer_retains_a_real_failure(repository, tmp_path):
    root = project(repository, "rust")
    common = [
        "advanced-fuzz",
        "--root",
        str(root),
        "--target",
        "checksum",
        "--corpus",
        "fuzz/corpus/checksum",
        "--runs",
        "100",
        "--seconds",
        "10",
    ]
    assert main([*common, "--output", str(tmp_path / "positive")]) == 0
    result = json.loads((tmp_path / "positive/result.json").read_text())
    assert result["executions"] > 0 and "nightly" in result["compiler"]
    source = root / "fuzz/fuzz_targets/checksum.rs"
    source.write_text(
        source.read_text().replace(
            "let _ = ciwf_fixture::checksum(text);", "assert_eq!(ciwf_fixture::checksum(text), 123);"
        )
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled fuzz defect")
    assert main([*common, "--output", str(tmp_path / "negative")]) == 1
    result = json.loads((tmp_path / "negative/result.json").read_text())
    assert result["failing_inputs"] and all(Path(p).is_file() for p in result["failing_inputs"])


def test_actual_cpp_libfuzzer_rejects_a_crashing_target(repository, tmp_path):
    root = project(repository, "advanced")
    source = root / "checksum_fuzzer.cpp"
    arguments = [
        os.environ.get("CXX", "clang++"),
        "-std=c++17",
        "-g",
        "-O1",
        "-fsanitize=fuzzer,address",
        str(source),
        "-o",
        str(root / "fuzzer"),
    ]
    if os.environ.get("NDDEV_CLANG_RESOURCE_DIR"):
        arguments[1:1] = ["-resource-dir", os.environ["NDDEV_CLANG_RESOURCE_DIR"]]
    subprocess.run(arguments, check=True, capture_output=True)
    common = [
        "advanced-fuzz",
        "--root",
        str(root),
        "--engine",
        "libfuzzer",
        "--target",
        "fuzzer",
        "--corpus",
        "corpus",
        "--runs",
        "100",
        "--seconds",
        "10",
    ]
    assert main([*common, "--output", str(tmp_path / "positive")]) == 0
    source.write_text(
        source.read_text().replace(
            "  std::uint8_t checksum = 0;", "  if (size) { __builtin_trap(); }\n  std::uint8_t checksum = 0;"
        )
    )
    subprocess.run(arguments, check=True, capture_output=True)
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled native crash")
    assert main([*common, "--output", str(tmp_path / "negative")]) == 1
    result = json.loads((tmp_path / "negative/result.json").read_text())
    assert result["failing_inputs"]


def test_actual_cargo_mutants_detects_weakened_tests(repository, tmp_path):
    root = project(repository, "mutation")
    contract = root / ".github/nddev-ci.toml"
    contract.parent.mkdir(exist_ok=True)
    contract.write_text(
        'schema=1\nprofiles=["documentation"]\n[commands.documentation]\nexternal-links=["true"]\ngenerate=["true"]\nexamples=["true"]\n[extras.mutation]\npurpose="Actual native mutation gate and retained diagnostic integration"\ncommand=["@library","advanced-mutation","--maximum-missed","0"]\ntimeout=300\n'
    )
    git(root, "add", ".github")
    git(root, "commit", "-qm", "actual shared-helper caller contract")
    integrated = ci.execute(root, config.load(root), tmp_path / "integrated")
    assert integrated["status"] == "success"
    assert (tmp_path / "integrated/extra-mutation/mutants.out/outcomes.json").is_file()
    common = ["advanced-mutation", "--root", str(root), "--maximum-missed", "0"]
    assert main([*common, "--output", str(tmp_path / "positive")]) == 0
    result = json.loads((tmp_path / "positive/result.json").read_text())
    assert result["counts"]["caught"] > 0 and result["counts"]["missed"] == 0
    (root / "src/lib.rs").write_text(
        "pub fn is_even(value: u32) -> bool { value % 2 == 0 }\n#[test] fn weak_test() { let _ = is_even(0); }\n"
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled inadequate assertions")
    assert main([*common, "--output", str(tmp_path / "negative")]) == 1
    result = json.loads((tmp_path / "negative/result.json").read_text())
    assert result["counts"]["missed"] > 0


def test_actual_native_benchmark_detects_a_measured_regression(repository, tmp_path):
    root = project(repository, "advanced")

    def measure(name):
        report = tmp_path / (name + ".json")
        subprocess.run(
            [
                "uv",
                "run",
                "--locked",
                "pytest",
                "test_benchmark.py",
                "--benchmark-only",
                "--benchmark-json=" + str(report),
            ],
            cwd=root,
            check=True,
            capture_output=True,
        )
        return report

    baseline = measure("baseline")
    candidate = measure("candidate")
    common = ["benchmark-compare", "--root", str(root), "--baseline", str(baseline), "--maximum-ratio", "5"]
    assert main([*common, "--candidate", str(candidate)]) == 0
    source = root / "test_benchmark.py"
    source.write_text(
        source.read_text().replace('if os.environ.get("NDDEV_BENCHMARK_SLOW") == "true":', "if True:")
    )
    git(root, "add", ".")
    git(root, "commit", "-qm", "controlled actual performance regression")
    slower = measure("slower")
    assert main([*common, "--candidate", str(slower)]) == 1
