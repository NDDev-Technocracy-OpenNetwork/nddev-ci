"""Execute selected native profiles; aggregate every required operation exactly once."""

from __future__ import annotations

import contextlib
import copy
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import config, diagnostic_export, documentation, git_inputs, quality, reports, security
from .model import Invalid, atomic_json, contained, digest, git, identity, source_identity
from .process import run


def native_command(command, root: Path, contract: dict, diagnostics: Path | None = None):
    if isinstance(command, list) and command and command[0] == "@library":
        if len(command) < 2 or command[1] not in {
            "package-check",
            "secrets-check",
            "security-sast",
            "security-licenses",
            "documentation-check",
            "workflow-check",
            "oci-build",
            "advanced-fuzz",
            "advanced-mutation",
            "benchmark-compare",
        }:
            raise Invalid("Select a supported source-only shared native helper")
        helper = command[1]
        if diagnostics is not None:
            default_directory = diagnostics
            supplied_output = False
            for index, argument in enumerate(command[2:], 2):
                if argument == "--output" and index + 1 < len(command):
                    diagnostics = root / command[index + 1]
                    supplied_output = True
                    break
                if argument.startswith("--output="):
                    diagnostics = root / argument.split("=", 1)[1]
                    supplied_output = True
                    break
            product_directory = diagnostics
            if helper == "secrets-check" and not supplied_output:
                product_directory = default_directory.parent / "secret-scan"
            # Child helpers own these diagnostic products; corpus, failing inputs,
            # generated runners and mutated source remain application bytes.
            products = {
                "advanced-fuzz": ("dependencies.log", "fuzz.log", "result.json"),
                "advanced-mutation": (
                    "mutation.log",
                    "export.log",
                    "result.json",
                    "mutants.out/outcomes.json",
                    "mutants/mutmut-cicd-stats.json",
                    "stryker-native.json",
                ),
                "secrets-check": ("gitleaks.log", "result.json"),
            }
            for product in products.get(helper, ()):
                diagnostic_export.register(product_directory / product)
        if helper in {"security-sast", "security-licenses"}:
            from .security import native_command as security_command

            return security_command(helper, root, contract)
        arguments = [sys.executable, "-m", "nddev_cicd", helper, "--root", str(root), *command[2:]]
        if (
            helper in {"advanced-fuzz", "advanced-mutation"}
            and diagnostics is not None
            and not any(x == "--output" or x.startswith("--output=") for x in command[2:])
        ):
            arguments += ["--output", str(diagnostics)]
        if helper == "package-check":
            arguments += ["--contract", contract["_path"]]
        return arguments
    return command


def selection(
    root: Path, contract: dict, base: str | None = None, head: str | None = None
) -> tuple[list[str], dict | None]:
    selected = list(contract["profiles"])
    impact_record = None
    if contract.get("impact"):
        from .impact import affected

        specification = contract["impact"]
        components = specification.get("components", {})
        if not components or any(not item.get("profiles") for item in components.values()):
            raise Invalid("Every impact component requires explicit native profiles")
        source = source_identity(root)
        resolved_base = base or source.get("base")
        baseline_workflow = specification.get("baseline_workflow")
        if (
            base is None
            and baseline_workflow
            and os.environ.get("GITHUB_EVENT_NAME") == "push"
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
        ):
            from .github import successful_main_base

            resolved_base = successful_main_base(root, baseline_workflow)
        shared = list(specification.get("shared", [])) + [
            contract["_path"],
            *sorted(config.LOCK_NAMES),
            "*.lockfile",
            ".github/workflows/*",
        ]
        chosen = affected(
            root,
            resolved_base or "missing-base",
            head or source["tested_revision"],
            components,
            shared,
        )
        selected = sorted(set(selected) | {p for name in chosen for p in components[name]["profiles"]})
        impact_record = {
            "base": resolved_base,
            "selected_components": chosen,
            "not_applicable": {
                name: "No changed declared input or dependent" for name in components if name not in chosen
            },
        }

    return selected, impact_record


def _execute(root: Path, contract: dict, output: Path) -> dict:
    selected, impact_record = selection(root, contract)
    profiles = config.resolve(root, contract, selected)
    unknown = set(selected) - profiles.keys()
    if unknown:
        raise Invalid(f"Unsupported selected profiles: {sorted(unknown)}")
    output.mkdir(parents=True, exist_ok=True)
    (root / ".nddev-reports").mkdir(exist_ok=True)
    result = {
        "schema": 1,
        "identity": source_identity(root),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "selection": selected,
        "results": [],
        "expected": [],
    }
    result["impact"] = impact_record
    try:
        result["identity"]["submodules"] = git_inputs.submodules(root)
    except Invalid as error:
        result["expected"] = ["inputs.submodule-integrity"]
        result["results"] = [
            {"name": "inputs.submodule-integrity", "status": "failure", "detail": str(error)}
        ]
        result.update(reports.aggregate(result["expected"], result["results"]))
        diagnostics(result, contract)
        atomic_json(output / "result.json", result)
        return result
    result["identity"]["contract_sha256"] = digest(contained(root, contract["_path"], exists=True))
    result["identity"]["locks"] = config.locks(root, contract)
    commands = contract.get("commands", {})
    coverage = {
        name: spec for name, spec in contract.get("coverage", {}).items() if spec["profile"] in selected
    }
    stale_coverage = {}
    for name, spec in coverage.items():
        try:
            reports.fresh(root, spec)
        except (Invalid, ValueError, OSError) as error:
            stale_coverage[name] = str(error)
    env = {str(key): str(value) for key, value in contract.get("environment", {}).items()}
    if any(key == "GH_TOKEN" or key.startswith(("GITHUB_", "ACTIONS_", "RUNNER_")) for key in env):
        raise Invalid("Native runner context and credentials are not project contract values")
    if "ruby" in selected:
        env["BUNDLE_FROZEN"] = "true"
    env["NDDEV_RESULT_DIR"] = str(output.resolve())
    if contract.get("security", {}).get("engine") == "semgrep":
        env.update(
            {
                "SEMGREP_APP_TOKEN": "",
                "SEMGREP_SEND_METRICS": "off",
                "SEMGREP_ENABLE_VERSION_CHECK": "0",
                "SEMGREP_SETTINGS_FILE": str(output.resolve() / "semgrep-settings.yml"),
                "OTEL_SDK_DISABLED": "true",
            }
        )
    env["NDDEV_TESTED_REVISION"] = result["identity"]["tested_revision"]
    env["NDDEV_TESTED_TREE"] = result["identity"]["tested_tree"]
    for tool, specification in contract.get("tools", {}).items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", tool) or not isinstance(specification, dict):
            raise Invalid("Tool identities require bounded names and explicit native version checks")
        command, pattern = specification.get("command"), specification.get("pattern")
        if not command or not isinstance(pattern, str) or not pattern:
            raise Invalid("Each tool requires its native version command and expected version pattern")
        name = "tool." + tool
        result["expected"].append(name)
        item = run(command, root, output / f"{name}.log", timeout=60, env=env)
        if item["status"] == "success" and not re.search(
            pattern, Path(item["log"]).read_text(), re.MULTILINE
        ):
            item.update(status="failure", detail="Executed tool version differs from selected contract")
        tool_result = {"name": name, **item}
        result["results"].append(tool_result)
        diagnostics({"results": [tool_result]}, contract)
    cancelled = False
    for profile_id in selected:
        definition = profiles[profile_id]
        stage_status = {}
        setup_failed = any(
            i["status"] != "success" for i in result["results"] if i["name"].startswith("tool.")
        )
        for stage, default in definition["stages"].items():
            if stage in definition.get("optional_stages", []) and stage not in commands.get(profile_id, {}):
                continue
            finalizer = stage in definition.get("finally_stages", [])
            name = f"{profile_id}.{stage}"
            result["expected"].append(name)
            entry: dict = {"name": name, "status": "failure"}
            report = {}
            result["results"].append(entry)
            stage_status[stage] = entry
            # Write expected/results incrementally so interruptions never yield a complete green report.
            result["status"] = "failure"
            atomic_json(output / "result.json", result)
            try:
                reason = contract.get("not_applicable", {}).get(profile_id, {}).get(stage)
                if reason:
                    entry.update(status="not-applicable", reason=reason, detail=reason)
                    continue
                if not finalizer and (cancelled or setup_failed):
                    entry.update(
                        status="unavailable",
                        detail="Execution cancelled"
                        if cancelled
                        else "Required profile setup did not succeed",
                    )
                    continue
                dependencies = definition.get("dependencies", {}).get(stage, [])
                if any(stage_status.get(parent, {}).get("status") != "success" for parent in dependencies):
                    entry.update(status="unavailable", detail="Required native prerequisite did not succeed")
                    continue
                if stage == "syntax" and profile_id == "documentation":
                    entry.update(documentation.check(root, contract.get("documentation")), status="success")
                    continue
                if profile_id == "architecture" and stage == "scope":
                    scopes = contract.get("architecture", {}).get("scopes", [])
                    if not scopes or any(
                        not list(contained(root, scope, exists=True).rglob("*")) for scope in scopes
                    ):
                        raise Invalid("Architecture needs existing nonempty module scopes")
                    entry.update(status="success", scopes=scopes)
                    continue
                command = commands.get(profile_id, {}).get(stage, default)
                semgrep = (
                    command == ["@library", "security-sast"]
                    and contract.get("security", {}).get("engine") == "semgrep"
                )
                command = native_command(command, root, contract, output / name)
                if command is None:
                    raise Invalid(f"Selected {name} requires a native project command")
                if stage == definition.get("test_stage", "test"):
                    # Old reports cannot make a no-op test command green.
                    report = contract.get("reports", {}).get(profile_id, definition.get("report", {}))
                    reports.fresh(root, report)
                if profile_id == "security" and stage == "secrets" and command == default:
                    require_secret_history(root)
                if profile_id == "documentation" and stage == "external-links":
                    native_report = contract.get("documentation", {}).get("external_link_report")
                    if native_report:
                        reports.fresh(root, {"path": native_report})
                entry.update(
                    run(
                        command,
                        root,
                        output / f"{name}.log",
                        timeout=contract.get("timeouts", {}).get(profile_id, 900),
                        env=env,
                        stderr_log=output / f"{name}.stderr.log" if semgrep else None,
                    )
                )
                if (
                    profile_id == "security"
                    and stage == "secrets"
                    and command == default
                    and entry["status"] == "success"
                ):
                    verify_secret_scan(entry)
                if (
                    entry["status"] == "success"
                    and stage in definition.get("empty_output", [])
                    and command == default
                    and Path(entry["log"]).read_text().strip()
                ):
                    raise Invalid(f"{name} reported source formatting drift")
                if profile_id == "documentation" and stage == "external-links":
                    disposition = documentation.external_outage(
                        root, contract.get("documentation", {}), entry
                    )
                    if disposition:
                        entry.update(disposition)
                if entry.get("detail") == "cancelled":
                    cancelled = True
                if stage == "setup" and entry["status"] != "success":
                    setup_failed = True
                if entry["status"] == "success" and stage == definition.get("test_stage", "test"):
                    entry["tests_executed"] = reports.tests(root, report, Path(entry["log"]))
                if entry["status"] == "success" and semgrep:
                    entry["sast_targets"] = security.verify_semgrep(
                        root, contract["security"], Path(entry["log"])
                    )
                if (
                    entry["status"] == "success"
                    and profile_id == "rust"
                    and stage == "build"
                    and command == default
                ):
                    from .rust import retain_package

                    entry["final_packages"] = retain_package(root, env)
                if entry["status"] == "success" and stage == "generate":
                    documentation.generation_clean(root)
            except (Invalid, ValueError, OSError, subprocess.SubprocessError) as error:
                entry.update(status="failure", detail=str(error))
            finally:
                native_report = report
                if profile_id == "documentation" and stage == "external-links":
                    native_report = {
                        "path": contract.get("documentation", {}).get("external_link_report", "")
                    }
                if native_report.get("path"):
                    try:
                        entry["retained_reports"] = reports.retain(
                            root, native_report, output / "native-reports" / name
                        )
                    except (Invalid, OSError) as error:
                        entry.update(status="failure", detail=str(error))
                diagnostics({"results": [entry]}, contract)
    for name, extra in contract.get("extras", {}).items():
        if not isinstance(extra, dict) or not extra.get("command") or not extra.get("purpose"):
            raise Invalid("Each selected extra needs a concrete purpose, command and finite timeout")
        result["expected"].append("extra." + name)
        if extra.get("report"):
            reports.fresh(root, extra["report"])
        if cancelled:
            item: dict = {"status": "unavailable", "detail": "Execution cancelled"}
        else:
            item = run(
                native_command(extra["command"], root, contract, output / ("extra-" + name)),
                root,
                output / f"extra-{name}.log",
                timeout=extra.get("timeout", 600),
                env=env,
                stderr_log=output / f"extra-{name}.stderr.log"
                if extra["command"] == ["@library", "security-sast"]
                and contract.get("security", {}).get("engine") == "semgrep"
                else None,
            )
        if item["status"] == "success" and extra.get("report"):
            try:
                item["tests_executed"] = reports.tests(root, extra["report"], Path(item["log"]))
            except (Invalid, ValueError, OSError, subprocess.SubprocessError) as error:
                item.update(status="failure", detail=str(error))
        if (
            item["status"] == "success"
            and extra["command"] == ["@library", "security-sast"]
            and contract.get("security", {}).get("engine") == "semgrep"
        ):
            try:
                item["sast_targets"] = security.verify_semgrep(root, contract["security"], Path(item["log"]))
            except (Invalid, ValueError, OSError) as error:
                item.update(status="failure", detail=str(error))
        if extra.get("report", {}).get("path"):
            try:
                item["retained_reports"] = reports.retain(
                    root, extra["report"], output / "native-reports" / ("extra." + name)
                )
            except (Invalid, OSError) as error:
                item.update(status="failure", detail=str(error))
        extra_result = {"name": "extra." + name, **item}
        result["results"].append(extra_result)
        diagnostics({"results": [extra_result]}, contract)
    for name, spec in coverage.items():
        check = "coverage." + name
        result["expected"].append(check)
        try:
            if name in stale_coverage:
                raise Invalid(stale_coverage[name])
            entry = quality.coverage(root, spec, output / "native-reports" / check)
        except (Invalid, ValueError, OSError) as error:
            entry = {"status": "failure", "detail": str(error)}
        result["results"].append({"name": check, **entry})
    result["expected"].append("inputs.lock-integrity")
    try:
        current_locks = config.locks(root, contract)
    except Invalid:
        current_locks = {}
    original_locks = result["identity"]["locks"]
    changed_inputs = sorted(
        path
        for path in original_locks.keys() | current_locks.keys()
        if original_locks.get(path) != current_locks.get(path)
    )
    if digest(contained(root, contract["_path"], exists=True)) != result["identity"]["contract_sha256"]:
        changed_inputs.append(contract["_path"])
    try:
        if git_inputs.submodules(root) != result["identity"]["submodules"]:
            changed_inputs.append("submodules")
    except Invalid:
        changed_inputs.append("submodules")
    result["results"].append(
        {
            "name": "inputs.lock-integrity",
            "status": "failure" if changed_inputs else "success",
            "changed_inputs": changed_inputs,
        }
    )
    result.update(reports.aggregate(result["expected"], result["results"]))
    result["inputs_digest"] = identity(result["identity"])
    diagnostics(result, contract)
    atomic_json(output / "result.json", result)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as stream:
            from html import escape

            stream.write("\n| Native check | Result | Detail |\n|---|---|---|\n")
            for entry in result["results"]:
                detail = (
                    escape(
                        redact(entry.get("detail", "") + "\n" + entry.get("diagnostic_tail", "")).strip()[
                            :2000
                        ]
                    )
                    .replace("|", "&#124;")
                    .replace("\n", "<br>")
                )
                stream.write(f"| {escape(entry['name'])} | {entry['status']} | {detail} |\n")
    return result


def execute(root: Path, contract: dict, output: Path) -> dict:
    contract = copy.deepcopy(contract)
    output.mkdir(parents=True, exist_ok=False)
    with diagnostic_export.prepare(output, contract.get("environment", {})) as values:
        result = _execute_cached(root, contract, output)
        safe = diagnostic_export.redact_data(result, values)
        result.clear()
        result.update(safe)
        return result


def _execute_cached(root: Path, contract: dict, output: Path) -> dict:
    from .cache import nds_environment

    environment = {**os.environ, **{str(k): str(v) for k, v in contract.get("environment", {}).items()}}
    native = nds_environment(environment)
    if native is not None:
        if "compiler_cache" in contract and {"c-cpp", "qt"} & set(selection(root, contract)[0]):
            raise Invalid("The selected NDS provider has no qualified ccache namespace owner")
        if contract.get("rust", {}).get("sccache"):
            raise Invalid("The selected NDS provider has no qualified sccache lifetime selection")
        admitted, observation = native
        contract.setdefault("environment", {}).update(admitted)
        atomic_json(output / "cache.json", observation)
        return _execute(root, contract, output)
    if "compiler_cache" not in contract or not {"c-cpp", "qt"} & set(selection(root, contract)[0]):
        return _execute_with_rust_cache(root, contract, output)
    from .cache import compiler

    with compiler(
        root, contract["compiler_cache"], contract.get("environment", {}), contract["_path"]
    ) as compiler_environment:
        contract.setdefault("environment", {}).update(compiler_environment)
        result = _execute_with_rust_cache(root, contract, output)
        statistics = run(
            ["ccache", "--print-stats"],
            root,
            output / "ccache-statistics.log",
            timeout=30,
            env={**contract["environment"]},
        )
        if statistics["status"] == "success":
            try:
                counts = {
                    key: int(value)
                    for key, value in (
                        line.split("\t") for line in Path(statistics["log"]).read_text().splitlines()
                    )
                }
                if not {"cache_miss", "direct_cache_hit", "preprocessed_cache_hit"} <= counts.keys() or any(
                    value < 0 for value in counts.values()
                ):
                    raise Invalid("Ccache did not provide complete nonnegative native statistics")
                statistics["counters"] = counts
            except (Invalid, ValueError) as error:
                statistics.update(status="failure", detail=str(error))
        result["expected"].append("cache.ccache-statistics")
        result["results"].append({"name": "cache.ccache-statistics", **statistics})
        result.update(reports.aggregate(result["expected"], result["results"]))
        atomic_json(output / "result.json", result)
        return result


def _execute_with_rust_cache(root: Path, contract: dict, output: Path) -> dict:
    environment = {**os.environ, **{str(k): str(v) for k, v in contract.get("environment", {}).items()}}
    cache_root = environment.get("NDDEV_CACHE_ROOT")
    if "rust" not in selection(root, contract)[0] or not cache_root:
        return _execute(root, contract, output)
    from .cache import namespace, reclaim

    policy = contract.get("rust", {})
    budget, reserve, ttl = (
        policy.get(k) for k in ("cache_budget_bytes", "cache_min_free_bytes", "cache_ttl_seconds")
    )
    if (
        any(type(value) is not int for value in (budget, reserve, ttl))
        or budget < 1024 * 1024
        or reserve < 0
        or ttl < 1
    ):
        raise Invalid("Owned Rust caches require explicit byte budget, free-disk reserve and positive TTL")
    shared = environment.get("NDDEV_CARGO_DOWNLOAD_CACHE")
    shared_downloads = bool(shared) and environment.get("CARGO_HOME") == shared
    if shared_downloads:
        assert shared is not None
        if not Path(shared).is_absolute() or Path(shared).is_symlink() or any(c in shared for c in "\r\n"):
            raise Invalid("Native Cargo downloads require an absolute nonsymlink owner root")
    inputs = {
        "repository": os.environ.get("GITHUB_REPOSITORY", str(root.resolve())),
        "checkout": str(root.resolve()),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "trust": os.environ.get("NDDEV_TRUST_SCOPE", "local"),
        "configuration": {"rust": policy, "contract": digest(root / contract["_path"])},
        "toolchain": subprocess.check_output(["rustc", "-vV"], cwd=root, env=environment, text=True).strip(),
        "compiler_environment": {
            key: environment.get(key, "")
            for key in (
                "RUSTFLAGS",
                "CARGO_ENCODED_RUSTFLAGS",
                "RUSTUP_TOOLCHAIN",
                "CC",
                "CXX",
                "CFLAGS",
                "CXXFLAGS",
                "CARGO_BUILD_TARGET",
            )
        },
        "lock": digest(root / "Cargo.lock") if (root / "Cargo.lock").exists() else "missing",
    }
    if shared_downloads:
        # Cargo home changes registry source paths. Retain old private-cache
        # namespaces for queued callers instead of alternating one target tree.
        inputs["native_download_cache"] = shared
    storage = Path(cache_root)
    try:
        with contextlib.ExitStack() as contexts:
            try:
                owned = contexts.enter_context(namespace(storage, inputs, blocking=False))
            except BlockingIOError:
                print("Cargo cache is in use; running with job-local build output", flush=True)
                return _execute(root, contract, output)
            output.mkdir(parents=True, exist_ok=True)
            downloads = owned / "downloads"
            if shared_downloads:
                assert shared is not None
                downloads = Path(shared)
            observation = {
                "schema": 1,
                "kind": "cargo",
                "namespace": owned.name,
                "target_present": (owned / "target").is_dir(),
                "downloads_present": downloads.is_dir(),
                "downloads_shared": shared_downloads,
                "sccache": bool(policy.get("sccache")),
                "collection": "deferred",
                "collection_reason": "qualified_native_cleaner_required",
            }
            atomic_json(output / "cache.json", observation)
            print(f"Cargo cache: {observation}", flush=True)
            reclaim(storage, budget, reserve, ttl)
            if shutil.disk_usage(storage).free < reserve:
                raise Invalid("Available disk is below the owner's reserve after inactive cache reclamation")
            env = contract.setdefault("environment", {})
            env["CARGO_TARGET_DIR"], env["CARGO_HOME"] = str(owned / "target"), str(downloads)
            if not policy.get("sccache"):
                return _execute(root, contract, output)
            if os.name == "nt":
                raise Invalid(
                    "Local sccache ownership currently requires a Unix socket; native Cargo cache remains available"
                )
            active = owned / ".sccache-active.json"
            if active.exists():
                raise Invalid("An earlier sccache server needs owner reconciliation before reusing its store")
            # A short owned socket path avoids Unix socket limits on long runner/checkouts.
            socket_directory = Path(tempfile.mkdtemp(prefix="nddev-sc-"))
            env.update(
                {
                    "RUSTC_WRAPPER": "sccache",
                    "CARGO_INCREMENTAL": "0",
                    "SCCACHE_DIR": str(owned / "compiler"),
                    "SCCACHE_CACHE_SIZE": str(min(budget // 2, 2 * 1024**3)),
                    "SCCACHE_SERVER_UDS": str(socket_directory / "server.sock"),
                }
            )
            atomic_json(active, {"socket": env["SCCACHE_SERVER_UDS"], "owner": "nddev-cicd"})
            started = run(
                ["sccache", "--start-server"], root, output / "sccache-start.log", timeout=60, env=env
            )
            result = None
            try:
                if started["status"] != "success":
                    raise Invalid(
                        "Owned sccache server could not start; its store stays protected for reconciliation"
                    )
                result = _execute(root, contract, output)
            finally:
                statistics = run(
                    ["sccache", "--show-stats", "--stats-format=json"],
                    root,
                    output / "sccache-stats.log",
                    timeout=60,
                    env=env,
                )
                stopped = run(
                    ["sccache", "--stop-server"], root, output / "sccache-stop.log", timeout=60, env=env
                )
                if stopped["status"] == "success":
                    active.unlink()
                    shutil.rmtree(socket_directory)
                if result is not None:
                    entries = [
                        {"name": "cache.start", **started},
                        {"name": "cache.statistics", **statistics},
                        {"name": "cache.stop", **stopped},
                    ]
                    result["expected"].extend(item["name"] for item in entries)
                    result["results"].extend(entries)
                    result.update(reports.aggregate(result["expected"], result["results"]))
                    atomic_json(output / "result.json", result)
            if result is None:
                raise Invalid("Native cache execution produced no completed result")
            return result
    finally:
        if (storage / ".nddev-cache-owner.json").is_file():
            reclaim(storage, budget, reserve, ttl)


def redact(text: str, environment: dict[str, str] | None = None) -> str:
    return diagnostic_export.redact(
        text, diagnostic_export.sensitive_values({**os.environ, **(environment or {})})
    )


def diagnostics(result: dict, contract: dict) -> None:
    import uuid
    from collections import deque

    count = contract.get("diagnostics", {}).get("tail_lines", 200)
    for entry in result["results"]:
        if entry["status"] in {"success", "not-applicable"} or entry.get("diagnostics_published"):
            continue
        tail = ""
        if count and entry.get("log") and Path(entry["log"]).is_file():
            with Path(entry["log"]).open(encoding="utf-8", errors="replace") as stream:
                tail = "".join(deque((line[:2000] for line in stream), maxlen=count))
        tail = redact(tail, contract.get("environment"))
        detail = redact(
            entry.get("detail") or f"Native command exited with {entry.get('exit_code')}",
            contract.get("environment"),
        )
        entry["diagnostic_tail"] = tail[-1500:].strip()
        entry["detail"] = detail
        marker = uuid.uuid4().hex
        print(f"::group::{entry['name']} ({entry['status']})")
        print(f"::stop-commands::{marker}")
        print(detail)
        if tail:
            print(tail)
        print(f"::{marker}::")
        print("::endgroup::", flush=True)
        entry["diagnostics_published"] = True


def secrets_check(root: Path, output: Path) -> dict:
    """Run the same default history scanner with explicit completeness for a short gate."""
    require_secret_history(root)
    command = config.catalog()["security"]["stages"]["secrets"]
    result = {"name": "security.secrets", **run(command, root, output / "gitleaks.log", timeout=120)}
    try:
        verify_secret_scan(result)
    except Invalid as error:
        result.update(status="failure", detail=str(error))
    diagnostics({"results": [result]}, {})
    atomic_json(output / "result.json", result)
    return result


def require_secret_history(root: Path) -> None:
    if git(root, "rev-parse", "--is-shallow-repository") != "false":
        raise Invalid("Secret history scan requires a full checkout (fetch-depth: 0)")


def verify_secret_scan(entry: dict) -> None:
    if entry["status"] != "success":
        return
    counts = re.findall(r"(\d+) commits? scanned", Path(entry["log"]).read_text())
    if not counts or sum(map(int, counts)) <= 0:
        raise Invalid("Secret history scanner established no examined commits")
    entry["commits_scanned"] = sum(map(int, counts))
