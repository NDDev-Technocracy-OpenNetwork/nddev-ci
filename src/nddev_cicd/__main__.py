"""Thin command surface for the same shared operations used by composite entrypoints."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__, artifacts, ci, config, delivery, github, routing
from .model import Invalid, Unavailable, atomic_json


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="operation", required=True)
    run = sub.add_parser("ci", help="Execute selected native profiles and a complete result aggregate")
    run.add_argument("--root", type=Path, default=Path.cwd())
    run.add_argument("--contract", default=".github/nddev-ci.toml")
    run.add_argument("--output", type=Path, required=True)
    impact = sub.add_parser("impact", help="Expose the same conservative plan before dependent jobs allocate")
    impact.add_argument("--root", type=Path, default=Path.cwd())
    impact.add_argument("--contract", default=".github/nddev-ci.toml")
    impact.add_argument("--base")
    impact.add_argument("--head")
    gate = sub.add_parser("gate", help="Evaluate explicit expected results directly from native leaf jobs")
    gate.add_argument("--needs", required=True, help="Native toJSON(needs) object")
    gate.add_argument("--expected", required=True, help="JSON job map of expected success/skipped results")
    gate.add_argument(
        "--scopes", help="Optional raw true/false classifier outputs; malformed scope fails closed"
    )
    trivy = sub.add_parser(
        "trivy-db", help="Prepare fresh verified native Trivy databases for a job-local scan"
    )
    trivy.add_argument("--storage", type=Path, required=True)
    trivy.add_argument("--destination", type=Path, required=True)
    trivy.add_argument("--image", required=True)
    trivy.add_argument("--java", action="store_true")
    trivy.add_argument("--budget", type=int, default=4 * 1024**3)
    trivy.add_argument("--reserve", type=int, default=32 * 1024**3)
    rustsec = sub.add_parser("rustsec-audit", help="Refresh cached RustSec through native Git, then audit")
    rustsec.add_argument("--root", type=Path, default=Path.cwd())
    rustsec.add_argument("--storage", type=Path, required=True)
    rustsec.add_argument("--reserve", type=int, default=32 * 1024**3)
    rust_setup = sub.add_parser("rust-setup", help="Select exact installed Rust inputs before any download")
    rust_setup.add_argument("--toolchain", required=True)
    rust_setup.add_argument("--components", nargs="*", default=["clippy", "rustfmt"])
    rust_setup.add_argument("--targets", nargs="*", default=[])
    rust_setup.add_argument("--no-install", action="store_true")
    rust_setup.add_argument("--shared-downloads", action="store_true")
    rust_setup.add_argument("--github-environment", action="store_true")
    advisory = sub.add_parser(
        "advisory-compare",
        help="Compare findings with one actual production image inventory; does not authorize delivery",
    )
    advisory.add_argument("--candidate-report", type=Path, required=True)
    advisory.add_argument("--production-report", type=Path, required=True)
    advisory.add_argument("--candidate-image", required=True)
    advisory.add_argument("--production-image", required=True)
    advisory.add_argument("--component", required=True)
    feedback = sub.add_parser("feedback", help="Publish bounded metadata-only failure feedback")
    feedback.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    feedback.add_argument("--workflows", required=True, help="JSON array of exact workflow paths")
    feedback.add_argument("--creators", required=True, help="JSON array of allowed run creators")
    feedback.add_argument(
        "--conclusions", default='["failure","timed_out","action_required","startup_failure","stale"]'
    )
    feedback.add_argument("--events", default='["push","schedule","workflow_dispatch"]')
    feedback.add_argument("--branches", help="JSON exact branch names; defaults to the native default branch")
    feedback.add_argument("--since", help="Reconciliation UTC lower bound within the past 30 days")
    feedback.add_argument("--page-budget", type=int, default=50)
    feedback.add_argument("--run-id", type=int)
    feedback.add_argument("--task-issue", type=int)
    feedback.add_argument("--infrastructure-hints", action="store_true")
    document = sub.add_parser(
        "documentation-check", help="Check local documentation without network or authoring prerequisites"
    )
    document.add_argument("--root", type=Path, default=Path.cwd())
    document.add_argument("--contract", default=".github/nddev-ci.toml")
    secret = sub.add_parser("secrets-check", help="Verify a real full-history scan for a short native gate")
    secret.add_argument("--root", type=Path, default=Path.cwd())
    secret.add_argument("--output", type=Path)
    runners = sub.add_parser(
        "runners-check",
        help=(
            "Public: refuse floating, retiring, larger or unknown GitHub-hosted labels. Private: refuse "
            "hosted Linux and non-canonical route expressions; report routed and fixed self-hosted jobs"
        ),
    )
    runners.add_argument("--root", type=Path, default=Path.cwd())
    runners.add_argument("--visibility", choices=["public", "private"], default="public")
    expression = sub.add_parser(
        "route-expression",
        help="Print the canonical runs-on expression for a private runner class (R-0004)",
    )
    expression.add_argument("runner_class", nargs="?", choices=routing.RUNNER_CLASSES)
    expression.add_argument("--reusable", action="store_true", help="Read the class from inputs.runner-class")
    route = sub.add_parser("route", help="Choose admitted capacity before the affected job is allocated")
    route.add_argument("--policy", type=Path, required=True)
    pack = sub.add_parser("pack", help="Package exact selected files with source identity")
    pack.add_argument("--root", type=Path, default=Path.cwd())
    pack.add_argument("--files", nargs="+", required=True)
    pack.add_argument("--result", type=Path, required=True)
    pack.add_argument("--archive", type=Path, required=True)
    trust = sub.add_parser(
        "eligible", help="Validate an exact successful source run against its integrated target"
    )
    trust.add_argument("--repository", required=True)
    trust.add_argument("--run-id", type=int, required=True)
    trust.add_argument("--revision", required=True)
    trust.add_argument("--workflow", required=True)
    trust.add_argument("--phase", choices=["delivery", "pr"], default="delivery")
    trust.add_argument("--pull-request", type=int)
    trust.add_argument("--target")
    trust.add_argument("--aggregate", default="gate")
    ensure = sub.add_parser(
        "ensure-main", help="Observe missing current-main validation; explicitly dispatch once"
    )
    ensure.add_argument("--repository", required=True)
    ensure.add_argument("--workflow", required=True)
    ensure.add_argument("--dispatch", action="store_true")
    ensure.add_argument("--grace-seconds", type=int, default=90)
    apply = sub.add_parser("apply", help="Apply one authorized typed native delivery module")
    apply.add_argument("--config", type=Path, required=True)
    apply.add_argument("--download", type=Path, required=True)
    apply.add_argument("--run-id", type=int, required=True)
    apply.add_argument("--workflow", required=True)
    apply.add_argument(
        "--transport-config",
        type=Path,
        help="Optional trusted SSH transport JSON; target commands execute remotely",
    )
    apply.add_argument(
        "--remote-environment",
        type=Path,
        help="Optional caller-owned JSON of selected target credentials/settings",
    )
    release = sub.add_parser(
        "prepare-release", help="Prepare a native release candidate from an eligible integrated artifact"
    )
    release.add_argument("--run-id", type=int, required=True)
    release.add_argument("--workflow", default=".github/workflows/main-ci.yml")
    release.add_argument("--download", type=Path, required=True)
    release.add_argument("--directory", type=Path, required=True)
    release.add_argument(
        "--files", required=True, help="JSON list of selected native package/artifact patterns"
    )
    image = sub.add_parser(
        "oci-build", help="Build an actual OCI archive without publishing source PR credentials"
    )
    image.add_argument("--root", type=Path, default=Path.cwd())
    image.add_argument("--output", default="dist/image.oci.tar")
    image.add_argument("--context", default=".")
    image.add_argument("--dockerfile", default="Dockerfile")
    image.add_argument("--platforms", default="linux/amd64")
    image.add_argument("--builder")
    image.add_argument("--build-arg", action="append", default=[])
    image.add_argument("--cache-from", action="append", default=[])
    image.add_argument("--cache-to", action="append", default=[])
    image.add_argument("--cache-budget-bytes", type=int, default=0)
    publish = sub.add_parser(
        "oci-publish", help="Publish the exact eligible OCI archive to an existing registry"
    )
    publish.add_argument("--run-id", type=int, required=True)
    publish.add_argument("--workflow", default=".github/workflows/main-ci.yml")
    publish.add_argument("--download", type=Path, required=True)
    publish.add_argument("--image-file", default="dist/image.oci.tar")
    publish.add_argument("--metadata-file", default="dist/image.oci.json")
    publish.add_argument("--repository", required=True)
    publish.add_argument("--auth-file", type=Path)
    publish.add_argument("--certificates", type=Path)
    heavy = sub.add_parser("advanced-fuzz", help="Run a real bounded native cargo-fuzz/libFuzzer target")
    heavy.add_argument("--root", type=Path, default=Path.cwd())
    heavy.add_argument("--output", type=Path, required=True)
    heavy.add_argument("--engine", choices=["rust", "libfuzzer"], default="rust")
    heavy.add_argument("--target", required=True)
    heavy.add_argument("--corpus", required=True)
    heavy.add_argument("--runs", type=int, default=1000)
    heavy.add_argument("--seconds", type=int, default=30)
    heavy.add_argument("--toolchain", default="nightly-2026-10-19")
    mutation = sub.add_parser(
        "advanced-mutation", help="Run a selected native mutation engine with completed result accounting"
    )
    mutation.add_argument("--root", type=Path, default=Path.cwd())
    mutation.add_argument("--output", type=Path, required=True)
    mutation.add_argument("--maximum-missed", type=int, default=0)
    mutation.add_argument("--timeout", type=int, default=15)
    mutation.add_argument("--engine", choices=["cargo-mutants", "mutmut", "stryker"], default="cargo-mutants")
    compare = sub.add_parser("benchmark-compare", help="Compare real paired pytest-benchmark measurements")
    compare.add_argument("--root", type=Path, default=Path.cwd())
    compare.add_argument("--baseline", type=Path, required=True)
    compare.add_argument("--candidate", type=Path, required=True)
    compare.add_argument("--maximum-ratio", type=float, required=True)
    reference = sub.add_parser("reference")
    reference.add_argument("--root", type=Path, default=Path.cwd())
    reference.add_argument("--check", action="store_true")
    for helper in ("package-check", "workflow-check"):
        helper_parser = sub.add_parser(helper)
        helper_parser.add_argument("--root", type=Path, default=Path.cwd())
        if helper == "package-check":
            helper_parser.add_argument("--contract")
    sarif = sub.add_parser("sarif-check", help="Gate actual native public CodeQL findings")
    sarif.add_argument("--directory", type=Path, required=True)
    sarif.add_argument("--minimum", default="moderate")
    sub.add_parser("profiles", help="Print native profile contracts (no execution claim)")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.operation == "ci":
            root = args.root.resolve()
            contract = config.load(root, args.contract)
            result = ci.execute(root, contract, args.output.resolve())
            # Selected packaging is connected to actual successful source results, not a plan-only helper.
            if result["status"] == "success" and contract.get("artifacts", {}).get("files"):
                try:
                    result["artifact"] = artifacts.pack(
                        root,
                        contract["artifacts"]["files"],
                        args.output.resolve() / "artifact.tar.gz",
                        result["identity"],
                    )
                except (Invalid, OSError, ValueError) as error:
                    result.update(status="failure", artifact_error=ci.redact(str(error)))
                atomic_json(args.output.resolve() / "result.json", result)
            print(
                json.dumps(
                    {
                        "status": result["status"],
                        "result": str(args.output / "result.json"),
                        "limitations": result.get("limitations", []),
                    }
                )
            )
            return 0 if result["status"] == "success" else 1
        if args.operation == "documentation-check":
            from .documentation import check

            root = args.root.resolve()
            result = check(root, config.load(root, args.contract).get("documentation"))
            print(json.dumps(result))
            return 0
        if args.operation == "route-expression":
            if not args.reusable and not args.runner_class:
                raise Invalid("Name a runner class, or pass --reusable")
            print(routing.route_expression(args.runner_class or "", reusable=args.reusable))
            return 0
        if args.operation == "runners-check" and args.visibility == "private":
            findings = routing.private_jobs(args.root.resolve())
            rejected = [item for item in findings if item["verdict"] == "invalid"]
            print(
                json.dumps(
                    {
                        "status": "failure" if rejected else "success",
                        "rejected": rejected,
                        "routed": [item for item in findings if item["verdict"] == "routed"],
                        "fixed": [item for item in findings if item["verdict"] == "fixed"],
                        "hosted": [item for item in findings if item["verdict"] == "hosted"],
                        "checked": len(findings),
                    }
                )
            )
            return 1 if rejected else 0
        if args.operation == "runners-check":
            findings = routing.workflow_labels(args.root.resolve())
            rejected = [item for item in findings if item["verdict"] != "standard"]
            print(
                json.dumps(
                    {
                        "status": "failure" if rejected else "success",
                        "rejected": rejected,
                        "checked": len(findings),
                    }
                )
            )
            return 1 if rejected else 0
        if args.operation == "secrets-check":
            root = args.root.resolve()
            output = (
                args.output
                or Path(os.environ.get("NDDEV_RESULT_DIR", str(root / ".nddev-reports"))) / "secret-scan"
            )
            result = ci.secrets_check(root, output.resolve())
            successful = result["status"] == "success"
            print(
                json.dumps(
                    {
                        "status": "success" if successful else "failure",
                        "report": str(output / "result.json"),
                        "commits_scanned": int(result.get("commits_scanned", 0)),
                    }
                )
            )
            return 0 if successful else 1
        if args.operation == "impact":
            root = args.root.resolve()
            selected, plan = ci.selection(root, config.load(root, args.contract), args.base, args.head)
            if plan is None:
                raise Invalid("The impact entrypoint requires declared components")
            result = {
                "profiles": selected,
                "selected": plan["selected_components"],
                "not_applicable": plan["not_applicable"],
                "base": plan["base"],
            }
            print(json.dumps(result))
            return 0
        if args.operation == "gate":
            from .gate import evaluate

            print(
                json.dumps(
                    evaluate(
                        json.loads(args.needs),
                        json.loads(args.expected),
                        json.loads(args.scopes) if args.scopes is not None else None,
                    )
                )
            )
            return 0
        if args.operation == "ensure-main":
            print(
                json.dumps(
                    github.ensure_main(
                        args.repository,
                        args.workflow,
                        dispatch=args.dispatch,
                        grace_seconds=args.grace_seconds,
                    )
                )
            )
            return 0
        if args.operation == "rustsec-audit":
            from .rustsec import audit

            return audit(args.root, args.storage, reserve=args.reserve)
        if args.operation == "rust-setup":
            from .rust_setup import export, prepare

            result = prepare(
                args.toolchain,
                args.components,
                args.targets,
                allow_install=not args.no_install,
                shared_downloads=args.shared_downloads,
            )
            if args.github_environment:
                export(result)
            print(json.dumps(result))
            return 0
        if args.operation == "trivy-db":
            from .trivy import prepare

            result = prepare(
                args.storage,
                args.destination,
                args.image,
                java=args.java,
                budget=args.budget,
                reserve=args.reserve,
            )
            print(json.dumps(result))
            return 0
        if args.operation == "advisory-compare":
            from .advisory import compare

            paths = [args.candidate_report, args.production_report]
            if any(p.is_symlink() or not p.is_file() or p.stat().st_size > 256 * 1024**2 for p in paths):
                raise Invalid("Advisory reports require bounded regular native JSON files")
            result = compare(
                json.loads(paths[0].read_text()),
                json.loads(paths[1].read_text()),
                candidate_image=args.candidate_image,
                production_image=args.production_image,
                component=args.component,
            )
            print(json.dumps(result))
            return 1 if result["introduced"] else 0
        if args.operation == "feedback":
            from .feedback import publish

            result = publish(
                args.repository,
                json.loads(args.workflows),
                json.loads(args.creators),
                run_id=args.run_id,
                task_issue=args.task_issue,
                conclusions=json.loads(args.conclusions),
                events=json.loads(args.events),
                branches=json.loads(args.branches) if args.branches is not None else None,
                since=args.since,
                page_budget=args.page_budget,
                infrastructure_hints=args.infrastructure_hints,
            )
            print(json.dumps(result))
            return 0
        if args.operation == "sarif-check":
            from .reports import sarif

            result = sarif(args.directory, args.minimum)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] == "success" else 1
        if args.operation == "reference":
            from .reference import generate

            generate(args.root.resolve(), check=args.check)
            return 0
        if args.operation == "package-check":
            from .package_check import check

            settings = (
                config.load(args.root.resolve(), args.contract).get("package", {}) if args.contract else {}
            )
            check(args.root.resolve(), settings)
            return 0
        if args.operation == "workflow-check":
            from .workflow_check import check

            check(args.root.resolve())
            return 0
        if args.operation == "profiles":
            result = config.catalog()
        elif args.operation == "route":
            result = routing.select(**routing.caller_policy(json.loads(args.policy.read_text())))
        elif args.operation == "pack":
            evidence = json.loads(args.result.read_text())
            if evidence.get("status") != "success":
                raise Invalid("Do not package a failed/unavailable source result")
            result = artifacts.pack(args.root.resolve(), args.files, args.archive, evidence["identity"])
        elif args.operation == "eligible":
            if args.phase == "pr":
                if args.pull_request is None or args.target is None:
                    raise Invalid("PR admission requires --pull-request and --target")
                result = github.pr_eligible(
                    args.repository,
                    args.run_id,
                    args.revision,
                    args.workflow,
                    args.pull_request,
                    args.target,
                    args.aggregate,
                )
            else:
                result = github.eligible(args.repository, args.run_id, args.revision, args.workflow)
        elif args.operation in {"advanced-fuzz", "advanced-mutation", "benchmark-compare"}:
            from . import advanced

            if args.operation == "advanced-fuzz":
                result = advanced.fuzz(
                    args.root.resolve(),
                    args.output.resolve(),
                    args.target,
                    engine=args.engine,
                    corpus=args.corpus,
                    runs=args.runs,
                    seconds=args.seconds,
                    toolchain=args.toolchain,
                )
            elif args.operation == "advanced-mutation":
                result = advanced.mutation(
                    args.root.resolve(),
                    args.output.resolve(),
                    maximum_missed=args.maximum_missed,
                    timeout=args.timeout,
                    engine=args.engine,
                )
            else:
                result = advanced.benchmark(args.baseline, args.candidate, args.maximum_ratio)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] == "success" else 1
        elif args.operation == "oci-build":
            from . import oci

            result = oci.build(
                args.root,
                args.output,
                context=args.context,
                dockerfile=args.dockerfile,
                platforms=args.platforms,
                builder=args.builder,
                build_args=args.build_arg,
                cache_from=args.cache_from,
                cache_to=args.cache_to,
                cache_budget_bytes=args.cache_budget_bytes,
            )
        elif args.operation == "oci-publish":
            from . import oci
            from .model import contained

            revision = github.authorized_revision(args.run_id, args.workflow)
            archive, manifest, expected = github.bundle(
                os.environ.get("GITHUB_REPOSITORY", ""),
                args.run_id,
                revision,
                args.workflow,
                args.download,
            )
            payload = args.download / "verified-payload"
            artifacts.unpack(archive, manifest, payload, expected)
            result = oci.publish(
                contained(payload, args.image_file, exists=True),
                json.loads(contained(payload, args.metadata_file, exists=True).read_text()),
                expected,
                args.repository,
                auth=args.auth_file,
                certificates=args.certificates,
            )
        elif args.operation == "prepare-release":
            from . import release

            revision = github.authorized_revision(args.run_id, args.workflow, allow_dispatch=True)
            archive, manifest, expected = github.bundle(
                os.environ.get("GITHUB_REPOSITORY", ""),
                args.run_id,
                revision,
                args.workflow,
                args.download,
            )
            result = release.prepare(archive, manifest, expected, args.directory, json.loads(args.files))
        else:
            revision = github.authorized_revision(args.run_id, args.workflow)
            repository = os.environ.get("GITHUB_REPOSITORY", "")
            archive, manifest, expected = github.bundle(
                repository, args.run_id, revision, args.workflow, args.download
            )
            target = json.loads(args.config.read_text())
            if args.transport_config:
                from . import remote

                result = remote.apply(
                    archive,
                    manifest,
                    expected,
                    target,
                    json.loads(args.transport_config.read_text()),
                    authorized=True,
                    environment=json.loads(args.remote_environment.read_text())
                    if args.remote_environment
                    else None,
                )
            else:
                if args.remote_environment:
                    raise Invalid("Remote environment input requires the explicit SSH transport")
                result = delivery.apply(archive, manifest, expected, target, authorized=True)
        print(json.dumps(result, indent=2))
        return 0
    except Unavailable as error:
        if str(error).startswith("infrastructure.") and os.environ.get("GITHUB_ACTIONS") == "true":
            # A bounded metadata hint only; never an admission bypass or permission to replay a mutation.
            print(f"::error title=NDDev infrastructure input::{error}")
        print(f"error: {ci.redact(str(error))}", file=sys.stderr)
        return 2
    except (Invalid, OSError, ValueError) as error:
        print(f"error: {ci.redact(str(error))}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
