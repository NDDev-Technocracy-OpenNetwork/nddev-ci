"""Run real native fixture profiles in isolated Git checkouts, including rejected source errors."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path

from nddev_cicd.ci import execute
from nddev_cicd.config import load
from nddev_cicd.package_check import check as consumer_check
from nddev_cicd.process import run
from nddev_cicd.quality import coverage as coverage_check

SOURCES = {
    "python": "src/ciwf_fixture/__init__.py",
    "rust": "src/lib.rs",
    "go": "checksum.go",
    "cpp": "src/main.cpp",
    "node": "checksum.js",
    "web": "index.html",
    "bun": "index.html",
    "dotnet": "src/Checksum/Class1.cs",
    "sql": "migrations/002.sql",
    "alembic": "migrations/versions/002_names.py",
    "advanced": "checksum.py",
    "shell": "checksum.sh",
    "qt": "src/fixture_identity.cpp",
    "flutter": "lib/main.dart",
    "swift": "Sources/CiwfFixture/Checksum.swift",
    "jvm": "src/main/java/example/Checksum.java",
    "ruby": "lib/native_checksum.rb",
    "architecture": "src/native_graph/domain.py",
    "infrastructure": "main.tf",
    "container": "Dockerfile",
    "php": "src/Checksum.php",
    "security": "app.py",
    "r": "R/checksum.R",
    "android": "app/src/main/kotlin/com/nddev/ci/fixture/MainActivity.kt",
}


def exercise(name: str, output: Path) -> dict:
    fixture = Path(__file__).with_name("native") / name
    if name not in SOURCES or not fixture.is_dir():
        raise ValueError(f"No integrated native fixture for {name}")
    with tempfile.TemporaryDirectory(prefix=f"nddev-native-{name}-") as directory, ExitStack() as cleanup:
        root = Path(directory) / "caller"
        if name in {"cpp", "qt"} and not os.environ.get("NDDEV_CCACHE_ROOT"):
            previous_cache = os.environ.get("NDDEV_CCACHE_ROOT")
            os.environ["NDDEV_CCACHE_ROOT"] = str(Path(directory) / "compiler-cache")
            if previous_cache is None:
                cleanup.callback(os.environ.pop, "NDDEV_CCACHE_ROOT", None)
            else:
                cleanup.callback(os.environ.__setitem__, "NDDEV_CCACHE_ROOT", previous_cache)
        standard_ignores = shutil.ignore_patterns(
            ".venv",
            "node_modules",
            "test-results",
            "playwright-report",
            "target",
            "build",
            "dist",
            "__pycache__",
            ".pytest_cache",
            ".nddev-reports",
            "vendor",
            ".terraform",
            ".gradle",
        )

        def ignored(path, names):
            omitted = standard_ignores(path, names)
            if name == "r" and Path(path).name == "renv":
                omitted.update({"library", "staging"} & set(names))
            return omitted

        shutil.copytree(
            fixture,
            root,
            ignore=ignored,
        )
        if name in {"web", "bun"}:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            with (root / ".github/nddev-ci.toml").open("a") as contract:
                contract.write(
                    '\n[environment]\nNDDEV_WEB_PORT="'
                    + str(port)
                    + '"\nPLAYWRIGHT_BROWSERS_PATH="'
                    + str(Path(directory) / "browsers")
                    + '"\n'
                )
        if name == "container":
            cleanup.callback(
                subprocess.run, [sys.executable, str(root / "native.py"), "cleanup"], cwd=root, check=False
            )
        for args in (
            ["init", "-b", "main"],
            ["config", "user.name", "Fixture"],
            ["config", "user.email", "fixture@example.invalid"],
            ["add", "."],
            ["commit", "-qm", "native fixture"],
        ):
            subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
        positive = execute(root, load(root), output / "positive")
        if positive["status"] != "success":
            raise RuntimeError(f"Native {name} fixture failed: {positive.get('failed')}; logs: {output}")
        if name in {"cpp", "qt"}:
            cold = next(
                item["counters"] for item in positive["results"] if item["name"] == "cache.ccache-statistics"
            )
            (root / SOURCES[name]).touch()
            warm = execute(root, load(root), output / "cache-warm")
            if warm["status"] != "success":
                raise RuntimeError("Native cached compilation did not pass its actual source checks")
            hits = next(
                item["counters"] for item in warm["results"] if item["name"] == "cache.ccache-statistics"
            )
            if (
                cold["cache_miss"] < 1
                or hits["direct_cache_hit"] + hits["preprocessed_cache_hit"]
                <= cold["direct_cache_hit"] + cold["preprocessed_cache_hit"]
            ):
                raise RuntimeError("Actual native compiler requests must produce a measured cache hit")
        if name == "python":
            measured = next(item for item in positive["results"] if item["name"] == "coverage.application")
            if not measured.get("retained_reports") or not 50 <= measured["percent"] < 100:
                raise RuntimeError("Native coverage must retain actual partial source measurements")
            spec = {**load(root)["coverage"]["application"], "minimum_percent": 100}
            if coverage_check(root, spec, output / "coverage-negative")["status"] != "failure":
                raise RuntimeError("A native measured coverage regression must remain blocking")
            executable = (
                "'" + sys.executable.replace("'", "''") + "'"
                if os.name == "nt"
                else shlex.quote(sys.executable)
            )
            invoke = "& " + executable if os.name == "nt" else executable
            pipeline = invoke + " -c 'import sys; sys.exit(0)' | " + invoke + " -c 'print(42)'"
            quoting = run(pipeline, root, output / "native-pipeline-positive.log")
            assert quoting["status"] == "success" and "42" in Path(quoting["log"]).read_text()
            failure = run(
                pipeline.replace("sys.exit(0)", "sys.exit(7)"), root, output / "native-pipeline-failure.log"
            )
            assert failure["status"] == "failure", "The shell pipeline lost an earlier native process failure"
            try:
                consumer_check(root, {"commands": [["python", "--version"]]})
            except subprocess.CalledProcessError:
                pass
            else:
                raise RuntimeError("A system executable cannot stand in for the built distribution's CLI")
        if name == "go":
            source = root / SOURCES[name]
            original = source.read_text()
            source.write_text(original.replace("func Checksum(", "func Checksum( "))
            formatting = execute(root, load(root), output / "format-negative")
            if (
                "go.format" not in formatting.get("failed", [])
                or next(i for i in formatting["results"] if i["name"] == "go.test")["status"] != "success"
            ):
                raise RuntimeError("Native formatting drift must fail independently of passing Go tests")
            source.write_text(original)
        if name == "flutter":
            source = root / SOURCES[name]
            original = source.read_text()
            changed = original.replace("class FixtureApp extends", "class FixtureApp  extends", 1)
            if changed == original:
                raise RuntimeError("The formatter fixture did not alter Dart formatting")
            source.write_text(changed)
            formatting = execute(root, load(root), output / "format-negative")
            if (
                "dart-flutter.format" not in formatting.get("failed", [])
                or next(i for i in formatting["results"] if i["name"] == "dart-flutter.test")["status"]
                != "success"
            ):
                raise RuntimeError("Dart formatting drift must fail independently of passing Flutter tests")
            source.write_text(original)
        # A genuine source syntax error must reach the real compiler/test path and remain a failed aggregate.
        source = root / SOURCES[name]
        if name == "security":
            source.write_text(
                source.read_text().replace(
                    "yaml.safe_load(payload)", "yaml.load(payload, Loader=yaml.Loader)"
                )
            )
        elif name == "architecture":
            # A valid Python import closes a real adapter/domain cycle and violates the declared boundary.
            source.write_text(source.read_text() + "\nfrom . import adapter\n")
        elif name in {"web", "bun"}:
            original = source.read_text()
            changed = original.replace("(a + b) % 256", "(a + b + 1) % 256")
            if changed == original:
                raise RuntimeError("The native web failure fixture did not alter application behavior")
            source.write_text(changed)
        elif name == "advanced":
            source.write_text(source.read_text().replace("sum(payload) % 256", "(sum(payload) + 1) % 256"))
        else:
            source.write_text(source.read_text() + "\nNDDEV deliberately invalid native source !\n")
        negative = execute(root, load(root), output / "negative")
        if negative["status"] != "failure" or not negative.get("failed"):
            raise RuntimeError(f"Native {name} accepted deliberately invalid source")
        if name == "security":
            if "security.sast" not in negative["failed"]:
                raise RuntimeError("The default native SAST tool must reject the unsafe YAML loader")
            source.write_text(
                source.read_text().replace(
                    "yaml.load(payload, Loader=yaml.Loader)", "yaml.safe_load(payload)"
                )
            )
            settings = load(root)
            settings["security"]["licenses"] = ["Apache-2.0"]
            license_negative = execute(root, settings, output / "license-negative")
            if "security.licenses" not in license_negative.get("failed", []):
                raise RuntimeError("The default native license scanner must reject the disallowed dependency")
        if name in {"web", "bun"} and "web.test" not in negative["failed"]:
            raise RuntimeError("The actual browser must reject the deliberately wrong application result")
        if (
            name == "cpp"
            and next(i for i in negative["results"] if i["name"] == "c-cpp.test")["status"] != "unavailable"
        ):
            raise RuntimeError("A failed native build cannot validate an old test binary")
        if name == "architecture":
            source.write_text(source.read_text().replace("\nfrom . import adapter\n", ""))
            settings = load(root)
            settings["architecture"]["scopes"] = ["src/unmatched_module"]
            unmatched = execute(root, settings, output / "unmatched-scope")
            if unmatched["status"] != "failure" or "architecture.scope" not in unmatched["failed"]:
                raise RuntimeError("An unmatched architectural scope cannot be vacuous success")
        return {
            "profile": name,
            "positive": "success",
            "negative": "rejected",
            "result_directory": str(output),
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=sorted(SOURCES))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(exercise(args.profile, args.output.resolve())))
