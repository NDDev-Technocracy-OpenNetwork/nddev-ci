# Consumer contract

Pin each external action/workflow to a reviewed full commit SHA. Keep a short gate on `pull_request` and full validation on `main` pushes.
A public main caller may use `.github/workflows/source.yml`; its explicit `uv` and `python` inputs own the project toolchain. Its facade pins a reviewed implementation
commit; use that exact implementation commit for `deliver` and inspect its `library-ref` output.
Require its `status` output to equal `success`;
its public-only contract deliberately exports no successful result for an inapplicable event/visibility.
The library's own CI demonstrates a direct composite caller. Do not use the public reusable workflow
for private execution: keep private jobs and their self-hosted labels in the caller, including planners
and final aggregation. Never grant public/fork code access to a private runner or deployment secret.

Use one final `.github/actions/gate` composite pinned to the reviewed library implementation when
intermediate rollup check names are not enforced. Its `needs` input is the caller's `toJSON(needs)`;
`expected` is an explicit JSON map from every direct leaf job ID to `success` or `skipped`.
The caller derives that map from its successful scope classifier and event conditions. Keep the
classifier itself and unconditional security checks expected to succeed. Matrix job results remain
GitHub's aggregate across their shards. Missing/extra dependencies, selected skips, cancellations
and malformed expectations fail; no empty gate passes. Keep the final job's `if: !cancelled()` so a
failed leaf still receives a verdict. Retain an intermediate job only when its distinct result is
actually required by the repository's check policy or it performs real artifact work.
Pass raw classifier outputs in `scopes` when they determine expectations: every selected scope must
be an explicit `true`/`false` string. An empty or malformed output cannot silently become unaffected.

For full main validation, use a workflow/ref concurrency group with `cancel-in-progress: false`.
GitHub completes the running validation and replaces its single pending candidate with the newest
push. The newest head may wait for that running validation; production still requires its own exact
successful main result. Short PR gates can cancel obsolete PR heads. Delivery keeps its independent
target lock and never inherits source-cancellation policy. See [native concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

The CI action resolves `contract` inside `working-directory` (the checkout root by default).
A component can keep its contract at `backend/.github/nddev-ci.toml` and select
`working-directory: backend`. Separate invocations use unique `result-key` values; reusing an
existing result directory is refused. Select profiles with actual native
manifests and all relevant extras. For example, a Python package with architectural contracts selects
`profiles = ["python", "architecture"]`; its architecture configuration declares nonempty source scopes
and the native dependency command (such as Import Linter). Exact stage names and defaults are generated
in [profiles](profiles.md). A required native command with no default fails until supplied.

`[commands.PROFILE]` overrides native command arrays or intentional trusted shell commands. Use arrays
for data arguments. `[reports.PROFILE]` selects native JUnit/TRX/Go/Cargo/Dart or explicitly documented
positive-count report parsing. Zero tests, stale/empty/all-skipped reports and missing selected stages
fail. `[timeouts]` bounds native operations in seconds. `[extras.NAME]` requires a purpose, command and
finite timeout. Use extras for project-selected race/property/fuzz/mutation/browser/accessibility,
feature/MSRV or compatibility checks; preserve retained failing inputs in selected artifacts.

The CI action's `python` input sets the caller's actual uv interpreter selection independently from the
library's isolated runtime declared in the [CI action](../.github/actions/ci/action.yml). Tool provisioning belongs in job-local setup or the existing
runner owner. Project lockfiles remain authoritative. Environment values in the contract are nonsecret;
credentials belong in caller repository/environment secrets and are passed only to the operation that
needs them. Never pass deployment credentials to source checks.

For Linux Rust jobs outside `.github/actions/ci`, `.github/actions/rust-setup` accepts an exact
`toolchain` (an exact version or dated nightly), optional comma/space-separated `components`
(default `clippy,rustfmt`) and `targets`. Native rustup probes installed compiler identity, components
and targets with automatic installation disabled. A complete prepared SDK needs no channel-manifest
request. Only absent inputs invoke bounded native installation; `install-missing: 'false'` requires
offline availability and fails if anything is missing. Floating channels are refused. Subsequent
steps use the exact `RUSTUP_TOOLCHAIN` and native proxies through GitHub's file commands; the action
does not change a shared default, directory override or project pin. Provision rustup itself through
the existing reviewed host/setup mechanism. [Native rustup selection](https://rust-lang.github.io/rustup/examples.html)
and [minimal CI profiles](https://rust-lang.github.io/rustup/concepts/profiles.html) retain upstream
ownership of SDK installation and component resolution.

The CI action exposes the native `artifact-id`, `artifact-digest` and `producer-attempt` outputs.
Forward them as producer job outputs and consume them through `needs` in a reusable delivery job.
Download by immutable artifact ID and verify the producer's attempt from that output, rather than
assuming the delivery job's `github.run_attempt` also rebuilt its dependency. Failed-only reruns
retain successful job outputs while assigning a new workflow attempt.

Source manifests bind the native [`job.check_run_id`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
when available. The shared bundle reader can use a previous producer attempt only when its successful
execution remains in the latest native job graph, with unchanged runner, execution interval and step
results. A replacement execution, ambiguous history, failed producer, missing provenance or changed
archive digest fails closed. GitHub can clone retained jobs with new job/check IDs; identical IDs
alone are not the retention test. Legacy artifacts without this provenance keep strict same-attempt
behavior and require a full rerun. Producer proof does not authorize delivery: the expected full main
workflow still must pass for the exact current source and library binding.

Producer selection/completion failures include a bounded `producer_observation` JSON suffix in the
existing error. It binds the run, source and attempts to named predicate outcomes and at most four
latest-job execution comparisons from the responses already read. Names, step contents, URLs and
arbitrary response strings are omitted. The observation explains that invocation's rejection;
it does not reconstruct an earlier response, certify provider consistency or retry admission.

`.github/actions/main-validation` observes a caller's exact full-main `workflow` through native REST.
It requires a read-scoped caller token in `GH_TOKEN` or `GITHUB_TOKEN`. The default only reports
metadata. With `dispatch-missing: 'true'` and caller `actions: write`, it can dispatch that same
workflow on `main` after a bounded grace period when no matching run exists. The workflow must
support `workflow_dispatch` and run its ordinary full checks for that event. Put this step in the
existing scheduled feedback/reconciliation job, serialized with that job's native concurrency.
Queued, running, failed and cancelled runs are observed without automatic replay. A dispatch is an
acknowledged request, not a successful validation. Delivery applies the same exact-main and complete
successful-workflow guards to a trusted manual validation as to a push validation.

## Native Docker and scanner inputs

Ordinary service containers, Buildx builds and daemon image scans can share a qualified rootless
Docker pool. Daemon-mounted OCI operations resolve the selected local Unix socket using native
context/environment precedence; they refuse an absent/remote endpoint instead of mounting an
unrelated host socket. A job that actually needs privileged host devices/networking must declare
and qualify that different capability explicitly. Adding a root-equivalent socket to every static
job is not required by image scanning. Fixtures detect `name=rootless` in Docker security options:
container root maps to the runner user, whereas the host UID inside a rootless container does not.
See [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/) and
[rootless clients](https://docs.docker.com/engine/security/rootless/tips/#client).

The Linux `.github/actions/rustsec-audit` composite refreshes the public RustSec database through
native shallow Git, then executes the caller's `cargo audit --deny warnings` against that successfully
refreshed repository with `--no-fetch`. Select the directory containing the lockfile through
`working-directory`. Cargo-audit must already be prepared. Each lane reuses its existing `CARGO_HOME`
cache with a 512 MiB namespace budget, seven-day unused TTL and explicit free-space reserve. Only
known transient fetch failures receive one bounded retry; native findings are never retried or
waived. A failed refresh cannot use an older database. Native Git object reuse avoids repeating
the full advisory history download. [Cargo-audit's native database options](https://docs.rs/cargo-audit/0.22.2/cargo_audit/config/struct.DatabaseConfig.html)
retain scanner ownership of advisories, warnings and staleness checks.

The Linux `.github/actions/trivy-db` composite accepts a digest-pinned scanner `image`, optional
`java: 'true'`, and finite `budget-bytes`/`reserve-bytes`. The prepared host may provide
`NDDEV_TRIVY_CACHE_ROOT` or its existing `NDDEV_BUILD_CACHE_ROOT`; otherwise the cache is job-local. Use the action's successful `cache-dir`
output for each scan with `--skip-db-update` (and `--skip-java-db-update` when Java was prepared).
Keep `--scanners vuln` explicit for vulnerability-only scans. The existing native Docker daemon and
GNU `cp` provide execution and reflink/copy snapshots; no registry proxy, scanner server or new
background service is installed.

Mount the prepared `db` subdirectory read-only at the scanner cache's `db` path, and do the same for
`java-db` when selected. The scan cache root remains writable for job-local analysis.
Native Trivy downloads validate OCI content through its upstream transport. Reuse binds the scanner
digest and compatible database schemas and requires `UpdatedAt <= now < NextUpdate`; stale data
cannot become success after a failed refresh. Refresh has two finite attempts and a finite lock
wait. Read-only hardlinks snapshot only the database and metadata; cross-filesystem callers use a
read-only reflink/copy fallback. Snapshots retain their generation through refresh/eviction without
holding the refresh lock while scanning. Concurrent scans keep separate mutable Bolt analysis
caches. Java and non-Java jobs share the same vulnerability DB namespace. Refresh replaces only expired
requested databases and retains a still-fresh Java index without downloading it again.
Unavailable input downloads emit an `NDDev infrastructure input` annotation;
findings and invalid DBs remain ordinary failures. That hint never admits a release or authorizes a
blind replay of deployment. GitHub metadata and genuinely new dependencies still require network
access. The cache owns inactive TTL/quota reclamation and respects its free-disk reserve.
Failure feedback can opt into `infrastructure-hints: 'true'` with `checks: read`; it reads at most
100 native annotations for each of at most 32 failed jobs and reports only the known typed input categories. It never
downloads logs or scanner reports, and a hint does not classify other failures in the same workflow.
Trivy documents [DB preparation](https://github.com/aquasecurity/trivy/blob/main/docs/guide/configuration/db.md)
and [concurrent cache constraints](https://www.trivy.dev/docs/latest/guide/references/troubleshooting/).

`[artifacts] files = ["dist/*.whl", "dist/*.tar.gz"]` packages only explicit successful outputs.
The manifest binds bytes/modes, caller source/merge tree, lock/contract identities, run attempt and callee
code identity. The upload policy and bounded retention belong to the action inputs. Caches and credentials
are rejected. This is content/provenance binding, not a claim of signed SLSA attestation.

## Private repositories: runner classes and the fallback

Private work runs on the NDDev self-hosted fleet (STD-0004 R-0004). A job names its capacity once, as
a **runner class**, through the canonical route expression. It never names a hosted fallback label
itself:

```yaml
jobs:
  check:
    runs-on: ${{ fromJSON(vars.NDDEV_ROUTE_LABELS || '{}')[format('{0}/{1}', fromJSON(vars.NDDEV_RUN_ROUTES || '{}')[github.run_id] || 'self', 'nddev-linux-small')] || 'nddev-linux-small' }}
```

`nddev-cicd route-expression nddev-linux-small` prints that value for a class; `--reusable` prints the
form that reads `inputs.runner-class` for a reusable workflow, whose caller names the class literally
in `with:`.

| Class | Self-hosted capacity |
| --- | --- |
| `nddev-linux-small` | light Linux x64 lane |
| `nddev-linux` / `nddev-linux-standart` | standard Linux x64 lane |
| `nddev-linux-arm-small` | Linux arm64 guest |
| `nddev-macos-small` | macOS arm64 lane |

How the fallback works:

- **Who decides.** The fleet controller, not the workflow. It owns two repository variables that the
  expression only reads, and writes them in a repository right before it moves one of that
  repository's runs. Organization variables are not visible to private repositories on GitHub Free.
  A repository never defines these names itself:
  - `NDDEV_ROUTE_LABELS` maps `<tier>/<class>` to a label, for example
    `blacksmith/nddev-linux-small` to `blacksmith-2vcpu-ubuntu-2404`;
  - `NDDEV_RUN_ROUTES` maps the run id of a run it moved to `blacksmith` or `hosted`.
- **When a run moves.** When a routed job has waited ten minutes and none of the run's jobs is
  running, the controller cancels the run and re-runs it. The new attempt resolves to the Blacksmith
  label.
  - If Blacksmith does not start the run within three minutes, or its free allowance is spent, the
    controller moves the run on to the standard GitHub-hosted label.
  - If that is refused too, the run goes back to waiting for the self-hosted lane.
  - Every move stays within the free allowances of R-0005.
- **What stays put.** A run without an entry keeps its class, so a manual re-run of an unmoved run stays
  self-hosted. A job that needs the lane's own SDK, device or network keeps explicit self-hosted labels
  and is never moved.
- **Caches.** Blacksmith and GitHub-hosted runs have neither the NDDev network cache nor lane caches.
  Library steps fall back to the pinned download sources and fail only on integrity checks (R-0018).

`nddev-cicd runners-check --visibility private --root .` reports every job as routed, fixed
(self-hosted labels, or a runner chosen by a matrix, input or repository variable such as
`${{ vars.RUNNER_LANE || 'nddev-linux-standart' }}`), hosted (Windows/macOS GitHub-hosted labels) or
invalid. It fails on hosted Linux labels and on an altered route expression, one that reads
`NDDEV_ROUTE_LABELS`/`NDDEV_RUN_ROUTES` differently from the canonical form. The controller never
moves a fixed job; deploy jobs belong there.

## Public repositories on GitHub-hosted runners

### Free standard runners

GitHub runs its [standard GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)
in public repositories [without charge](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
[Larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners) are billed per minute
even there. Public routing (`nddev-cicd route`) therefore selects only these exact labels (STD-0004
R-0004/R-0005):

| Platform | Architecture | Label | Runner |
| --- | --- | --- | --- |
| Linux | x64 | `ubuntu-26.04` | 4 vCPU, 16 GB RAM, 14 GB SSD |
| Linux | arm64 | `ubuntu-26.04-arm` | 4 vCPU, 16 GB RAM, 14 GB SSD |
| Windows | x64 | `windows-2025` | 4 vCPU, 16 GB RAM, 14 GB SSD |
| Windows | arm64 | `windows-11-arm` | 4 vCPU, 16 GB RAM, 14 GB SSD |
| macOS | arm64 | `macos-15` (`macos-26` where the product needs it) | 3 M1 cores, 7 GB RAM, 14 GB SSD |
| macOS | x64 | `macos-15-intel` (`macos-26-intel`) | 4 vCPU, 14 GB RAM, 14 GB SSD |

`nddev-cicd runners-check --root .` refuses any other GitHub-hosted label in a repository's workflows,
matrix values included:
- a floating `-latest` label, which changes image without a reviewed change;
- a retiring image, such as `macos-14`, unsupported from 2026-11-02, or `ubuntu-22.04`, unsupported from 2027-04-17;
- a larger runner (`-large`, `-xlarge`, `-N-cores`, GPU);
- an unknown label.

Self-hosted jobs are outside this check; private repositories use `--visibility private` (above).

The free capacity has limits, and the standard handles them by waiting, never by paying
([Actions limits](https://docs.github.com/en/actions/reference/limits)):

- **Concurrency.** GitHub Free allows 20 concurrent standard jobs, 5 of them macOS. Extra jobs queue.
- **Job time.** A hosted job runs for at most 6 hours.
- **Disk.** Each runner has a 14 GB SSD. Large Rust workspaces split lint and test jobs and drop CI
  debuginfo (`CARGO_PROFILE_DEV_DEBUG=0`) rather than outgrow it.
- **Cache.** A repository holds 10 GB of [dependency cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
  and entries unused for 7 days are evicted. Use beyond the limit is billed, so the limit is never raised.
  Only default-branch pushes write (`hosted-cache` below).

Linux release binaries are built on the image whose glibc matches the systems they ship to:
`ubuntu-26.04` since the owner's decision of 2026-11-01. The pinned actionlint release predates the 26.04 labels
([rhysd/actionlint#682](https://github.com/rhysd/actionlint/issues/682)), so callers declare them in
`.github/actionlint.yaml`, as this repository does.

### Hosted caches

Public callers run on standard GitHub-hosted runners and have no owned host cache. The
[hosted cache composite](../.github/actions/hosted-cache/action.yml) restores lockfile-keyed native
caches for the selected `ecosystems`: `cargo`, `bun`, `npm`, `pub` and `go`. Select it after the
toolchain setup and before the native commands. Each selected ecosystem needs a committed lockfile
under `working-directory`; `cargo` needs the workspace `Cargo.lock` there. A missing lockfile or
unknown ecosystem fails instead of caching an unkeyed tree.

Every event restores. Only a `push` or `workflow_dispatch` on the default branch saves, so pull
requests, forks and privileged events never write the cache that later trusted runs restore.
Keys include the runner OS and architecture, the selected ecosystems, the working directory and
the lockfile contents. A changed lock restores the nearest earlier entry and lets the native tool
verify and complete it. Cargo uses [rust-cache](https://github.com/Swatinem/rust-cache) with a
shared key across jobs, so pull-request gates reuse the dependency builds of the latest `main`
validation; cached Cargo binaries are not retained. The other ecosystems use the native
[GitHub cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
and export the native cache variables (`BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `PUB_CACHE`,
`GOMODCACHE` and `GOCACHE`).

Jobs that build the same lockfile differently, such as `cargo clippy` beside the tests or Go
`-race` beside a plain build, set `key` to a short profile (letters, digits, `_`). Cache entries are
immutable, so without it the first job to save the shared entry wins and the others restore an
unrelated build. Each profile gets its own entry and restore prefix; jobs that only download
packages share one entry and leave `key` empty.

uv is cached by [setup-uv](https://github.com/astral-sh/setup-uv#enable-caching) instead: set
`enable-cache: 'true'`, `cache-dependency-glob` to the `uv.lock` paths, `prune-cache: 'true'` and
`save-cache` to a default-branch-push expression. Pruning runs
[`uv cache prune --ci`](https://docs.astral.sh/uv/concepts/cache/#caching-in-continuous-integration)
before saving, which keeps only source-built wheels; an unpruned uv cache grew to 2.5 GB on a public
caller and restored slower than a fresh download. The composite refuses `uv` and points to these
inputs, because a composite cannot prune after the caller's steps.

A cache hit accelerates downloads and dependency compilation only; it is not a passed check. The
repository's free cache allowance, least-recently-used eviction and seven-day inactivity expiry bound
the storage; no paid cache expansion is selected. On a self-hosted runner the composite reports
`enabled: false` and selects nothing, so private callers keep their owned caches.

Provision tools from verified prebuilt binaries through the `tools` action rather than compiling them
in each job. Keep every external `uses:` on a reviewed full commit SHA with its version comment and
let a scheduled update proposal, such as Dependabot with a cooldown, keep those pins current.

# Admission and delivery

The selected standard permits an explicitly owner-selected project advisory exception; it is never a
global ignore or a green CI result. The existing `eligible`/`deliver` path remains strict. A project
that selects this exception implements its native admission adapter: verify the latest complete
main attempt and successful scans, admit only known advisory-policy findings, bind report/artifact
identities, observe the actual current production component images, and recheck that baseline under
the existing target lock before activation. Ordinary build/test/startup/network failures still refuse.

`nddev-cicd advisory-compare` supplies only the package-inclusion part. Pass `--component`, exact
`--candidate-image`/`--production-image` Docker image IDs and the corresponding native Trivy JSON
`--candidate-report`/`--production-report`. Retain the production report's complete `Packages`
inventory, for example through the scanner's native list-all-packages mode. Candidate findings are
compared by exact native PURL, installed version, ecosystem and language artifact path in that one
component. A current production image may reuse its verified immutable inventory when advisories
change; it does not need a second package download or a live service scan.

The command emits a separate `disposition` and returns nonzero for introduced or unidentifiable
packages. It does not read the target, prove scan completion, authorize deployment or convert a
failed workflow into success. Source lockfiles, byte-identical Dockerfiles and repository-wide
digest searches cannot replace runtime inventory. The project records its owner policy, baseline,
native scan/main-attempt bindings and admitted occurrences alongside ordinary delivery evidence.

Admission policy is trusted account configuration, never PR body labels or a remaining-balance guess.
Public Linux, Windows and macOS always use compatible standard GitHub-hosted runners. Private Linux
cannot fall back from self-hosted to hosted/Blacksmith. Private Windows/macOS try a verified compatible
Blacksmith no-overage route, then an equivalent admitted standard GitHub route.
An email alert is insufficient. A failing test is never rerun on another provider to obtain success.
Use `admit` outputs in a dependent job's `runs-on: fromJSON(...)` before that job exists.
For a private same-repository PR, `trusted_actors` selects the actual PR author's login, never
its rerunner. Include `dependabot[bot]` explicitly when approved; forks remain refused even for an
allowlisted author. Without this list, owner/member/collaborator association is required.
Private label selection reports `availability: not-checked`: it does not observe online runners,
repository access, busy runners or queue delay. Establish these from the existing native runner
inventory before dispatch; a valid label list alone does not establish runner availability.

Official private Linux scale sets can select a native group/label object instead of classical
`self-hosted/Linux/X64` labels. In trusted routing policy, set `admission.self_hosted` to
`{"kind":"scale-set","name":"my-pool","group":"Default","platform":"linux","architecture":"x64","guarantee":"self-hosted-only","reference":"owner-verified-native-inventory"}`.
The owner reference must establish that actual group/name is a self-hosted scale set with those
capabilities; groups can also contain paid larger runners, so a group name alone proves no such
authority. The output is `{"group":"Default","labels":"my-pool"}` for native `runs-on: fromJSON(...)`.
If `private_labels` is also supplied, it must be exactly the scale-set name. Classical routes remain
unchanged. Neither route queries online state/access, and invalid Linux authority never falls back
to a hosted provider. See [native group/label syntax](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).

Delivery follows completion of full main CI, using read-scoped Actions access. A trusted
`workflow_run` caller first invokes `eligible` with the source run ID, exact workflow and main
revision before checking out delivery code or preparing a target. It admits only a completed
successful same-repository main run that still identifies current main. Pass that run and a trusted
existing target JSON to `deliver`. Build and delivery use the same library SHA. The runtime verifies
the exact attempt, source tree and artifact bytes again before mutation; it does not rebuild them.
A project-owned server may build the payload, provided full main validation checks that exact
immutable payload or OCI digest and binds it to its native run/attempt before promotion. Source CI
for the same commit alone cannot validate a separately built binary. The built-in `deliver` path
expects the native verified source bundle; another server path must retain equivalent artifact
checks in its existing project workflow rather than claim that this adapter imported the artifact.
The historical PR-artifact integration mode remains available only through its explicit source
workflow selection for older adoptions.

Target configuration selects one of `static-web`, `systemd-binary`, `compose`, `packages`,
`mobile-artifacts`; an existing `target_directory`; a monotonically increasing target-owner `generation`;
and `expected_previous` artifact identity (`null` on first delivery). The target lock serializes actual
mutations, and stale generations cannot replace newer state. Final release directories are distinct
from compiler/download caches. Keep current and needed rollback artifacts.

Static/systemd targets activate exact versioned files through `current`; the existing web server or
service must already use that location. Configure a meaningful health_url and expected scenario content. The response must also contain the
tested revision; use version_url for a separate native version endpoint when needed. Builds receive
NDDEV_TESTED_REVISION and NDDEV_TESTED_TREE for this identity. A generic successful health response
cannot establish the deployed revision.
Systemd selects one existing service. Compose selects an existing stable project and actual services,
uses immutable image digests and `up --wait --no-build`. Package publication selects an existing HTTPS
registry and native Python/npm/NuGet publisher; secrets and registry verification remain caller-owned.
Mobile delivery validates configured artifact files and makes no store-submission claim.

Data mutations require existing backup/recovery or an explicit scoped backup waiver. A failed/partial
operation remains pending; the library never blindly retries it. After the target owner reconciles its
actual state, `recover_partial: true` can verify the same installed artifact and actual health before
completing the record. Registry/mobile recovery additionally requires a native `reconcile_command`.
Automatic file rollback is allowed only when explicitly compatible and no data migration occurred;
service/data recovery is still verified. No production target is invented by the source-only pilots.

# Prepared runner inputs

An existing trusted POSIX runner owner may supply `NDDEV_ARTIFACT_CACHE`, an absolute,
administrator-owned read-only upstream archive store. Its `sha256/` entries are named by the exact
upstream digest the pinned callee requests. The callee copies and checks bytes before its existing
job-local extraction. Missing prepared bytes retain ordinary verified download behavior; an unsafe
store or corrupt entry fails explicitly. Public callers need neither this store nor private tools.

`NDDEV_UV_CACHE_ROOT` optionally selects an owner-admitted persistent native uv package cache.
The owner supplies its isolated writable location, permissions, disk reserve and reclamation policy.
Without it, each callee retains the existing job-local cache. This cache changes no selected lock,
interpreter, per-job environment or implementation identity. A cache hit is not readiness or a passed
check. Keep shared immutable SDK inputs separate from mutable project and package-manager state.

# Packages and owned caches

Prepared Linux/macOS hosts can explicitly select `NDDEV_CACHE_PROVIDER=nds`.
They supply absolute `NDS_CLEANER_BIN`, `NDS_CLEANER_CONFIG`, `NDS_CACHE_FRONTENDS`
and the corresponding `NDS_CLEANER_BIN_SHA256`/`NDS_CLEANER_CONFIG_SHA256` pins.
The currently qualified protocol selects Cleaner alpha.5 with an explicit whole-day
`retention_seconds` policy. The library validates its pins, native ownership and
argv-preserving frontends, then uses that preparation instead of creating a
second Cargo target/cache owner. Its `cache.json` records the provider/policy and
`collection: external_owner`; actual completed GC belongs to the owning native
maintenance receipt. This record makes no hit claim. Explicit caller staging and
project environment settings remain authoritative. A selected but missing,
changed or unsupported provider fails instead of falling back to another store.
The shared bootstrap validates the same pinned owner before preparing the library,
then returns its package-owned library uv entrypoint. It requires the native
configuration's protected `environment_root`, and removes inherited project,
virtual-environment and import-path overrides only from the callee's child environment.
This includes a composite's job-temporary `UV_PROJECT_ENVIRONMENT`: the native
owner selects the library environment in its protected store instead. Caller
admission retains its separate uv entrypoint and explicit project settings.
No shared-host profile or caller environment is rewritten. A missing or invalid explicit selection fails
without downloading a temporary public uv. Composite entrypoints preserve managed
cache routing; their download defaults apply only without a selected provider.
Quality and security tool preparation ask the original uv runtime for its actual
`sys.prefix` after locked synchronization, then execute and export that runtime's
`bin` directory. The probe retains the same project, groups and Python selection
and uses `run --locked --no-sync`; it does not resolve a second environment.
A native owner can therefore keep the tool callee in its protected environment
store, while an unselected caller keeps the existing job-temporary placement.
Caller project and environment overrides are not restored into the native
library callee. Failed preparation or runtime discovery fails the tool step.

The prepared native host supplies Python for this admission. Interpreter, locked
library environment preparation and real offline reuse still need host acceptance.
This mode currently rejects separately selected ccache/sccache lifetime contracts;
those require their own qualified integration. Public hosted callers remain
independent of private bindings and credentials when no provider is selected.

Native store placement alone does not establish central network transport. An already admitted
NDS host can additionally select `NDDEV_UV_CENTRAL_INDEX` with its existing central public PyPI
index URL (HTTPS, or HTTP on loopback). The same shared bootstrap then returns the package-owned
uv preparation bridge. Caller execution receives that bridge through the existing admission PATH
delta; Cargo/Bun, native cache generations, installed environments and inherited leases retain
their existing owner. No extra service, resolver, download cache or collector is installed.

For project `uv sync` and `uv run`, native frozen exports select the requested groups, extras and
workspace packages with the original hashes. Native uv prepares registry wheels and local
`uv_build` or static Hatchling packages/build dependencies through the selected central index, then validates the
original canonical lock with `uv sync --locked --offline`. Warm checks avoid reinstalling an
already current environment; `uv run` keeps native inexact semantics unless `--exact` is selected.
If the requested prepared interpreter changes, native uv recreates the identified virtual environment
before preparing dependencies, so the final offline check uses the same interpreter.
Explicit project environments and prepared Python selections are preserved. Final native uv uses
CLI offline mode, so it does not impose `UV_OFFLINE` on the executed program's own environment.

This bounded integration admits canonical public PyPI and local/workspace sources inside that
workspace with qualified `uv_build` or static `hatchling.build` backends. Additional/private indexes, direct URL/VCS
dependencies, external local paths, script/`--with` environments and other local backends/Hatch hooks
or dynamic metadata need separate qualification and fail before online preparation. The static Hatchling
subset additionally admits a nonempty wheel `packages` list of existing directories inside the workspace;
other Hatchling configuration remains outside this subset. Native exports,
pip wheel-consumer operations and build operations outside project sync/run consume offline inputs
only; this bridge is not an online replacement for arbitrary uv commands. It never rewrites a
manifest or lock to change its index. Index URLs cannot contain credentials; unsupported private
closures fail instead of changing their native credential precedence. Public hosted CI without
the explicit selection keeps its autonomous bootstrap. A central endpoint still requires its
owner's actual cold/warm/fresh-offline/outage transport acceptance; the configured URL is not a
cache-hit assertion or evidence of installation across hosts.

Registry packages use wheels by default. A workspace can explicitly select native isolated source
builds with `tool.uv.require-build-hashes = true` and nonempty `build-constraint-dependencies` tables.
Each table supplies an exact `name==version` requirement and SHA-256 hashes for every admitted build
dependency, including transitive build dependencies. The bridge forwards those inputs to native uv
with `--build-constraint` and `--require-build-hashes`; runtime requirements retain their exported lock
hashes. Missing or mismatched hashes fail. Build isolation stays enabled and no cache layout is edited.
This uv feature is experimental in the selected stable tool; native target/compiler and backend
acceptance remains necessary. An arbitrary backend can perform its own I/O, so this path alone does
not establish central-only execution: the consumer retains its qualified egress boundary and actual
cold/warm/offline/outage evidence. A canonical lock still identifies its original public sources.

The Python consumer accepts a contained package.directory (default dist) and optional explicit
package.imports for namespace/root-layout packages. It consumes the built wheel outside the checkout
using the actual caller interpreter and locked runtime dependencies, separately from the library.
A failed build makes a dependent consumer/package test unavailable; stale outputs cannot establish
that the failed candidate built.

Set NDDEV_CACHE_ROOT only for an owned Rust cache and declare cache_budget_bytes,
cache_min_free_bytes, cache_ttl_seconds in the rust table. Opaque compiler namespace collection is
deferred until a pinned native Cleaner has qualified ownership, completed-use, inherited-child and
pin protection for that scope. Directory mtime and byte/free-space pressure do not authorize deletion.
The library preserves legacy namespaces and reports `collection: deferred` in `cache.json`;
the measured free-disk reserve still gates admission. These settings are policy/admission inputs,
not a filesystem quota. Compiler stores, Cargo downloads/intermediates and retained final packages have
distinct locations/controls. The default root Cargo package is staged into dist before cache cleanup;
workspace/custom packaging uses its native project command.

The cache root can be supplied in the process or contract environment. Each producer needs its own
root and retention budget. `cache.json` records namespace selection and whether target/download
directories existed; actual compiler output and optional native statistics establish hits. A busy
namespace falls back to job-local compilation instead of waiting behind another complete run.

The `rust-setup` action can explicitly select `shared-downloads: 'true'` when the prepared host
exports `NDDEV_CARGO_DOWNLOAD_CACHE`. Cargo's native package locks coordinate this common
`CARGO_HOME` across jobs; without the host hint the existing hosted/job-local behavior remains.
The owned compiler cache preserves that selected download home and keeps its own target namespace
and retention policy. `cache.json` reports `downloads_shared`. The host owns the download budget
and inactive cleanup, so a compiler namespace never reclaims the common inputs.

This opt-in leaves SDKs and compiler targets separate. Callers deriving targets from `CARGO_HOME`
must select a lane/job-owned target instead. Keep registry login files and auxiliary Cargo tool
databases in their own scope. `rust-setup` preserves the previous RustSec location through
`NDDEV_RUSTSEC_CACHE_ROOT`, which the matching `rustsec-audit` action honors. Cargo configuration
and native [package locking](https://doc.rust-lang.org/stable/nightly-rustc/cargo/util/cache_lock/index.html)
retain their upstream behavior; no registry proxy or extra dependency service is installed.

Compiler target namespaces include the resolved checkout path; compile-time paths cannot be reused
from another checkout. Same-root runs retain warm targets, while explicit common native downloads
stay shared across separate targets.

Native Cargo target reuse works independently from optional sccache=true. Sccache disables Rust
incremental compilation, holds the store lock for its complete server lifetime and stops that owned
server before releasing the owned namespace. Its native compiler-store limit is half the declared budget, at most 2GiB.
A failed stop protects the namespace for owner reconciliation. Windows uses the native Cargo cache;
this local sccache mode currently requires Unix sockets. No shared-host prune or routine cargo clean
is used. Native feature/MSRV/cross-target checks are selected native stage/extra commands.

C/C++ and Qt projects can select an independent `compiler_cache` table with the same explicit
`cache_budget_bytes`, `cache_min_free_bytes` and `cache_ttl_seconds` fields. The job owner supplies
a dedicated absolute `NDDEV_CCACHE_ROOT`, separately from Cargo storage. The Linux tools action's
`compiler` capability provisions the verified native ccache binary without host package changes.
CMake C/C++ launcher variables select that binary; conflicting existing launchers fail rather than
being overwritten. Native compiler-content keys and bounded owner namespaces preserve relevant
toolchain, platform, configuration and trust context. The source result retains actual native
hit/miss counters. A counter is evidence of cache behavior, not a promised speedup. Opaque namespace
collection remains deferred to the selected native owner; published and rollback artifacts stay outside
compiler storage. Projects with other native build systems retain their explicit launcher commands.

A caller-owned monorepo job can select an existing contained working-directory; the callee package
continues to resolve from its own action path. Private admission labels include self-hosted, Linux
and the selected actual architecture. A requested architecture cannot be inferred from a prose host name.

For native external-link checks, documentation.external_link_report can point to the actual Lychee
JSON output. An explicit documentation.network_timeouts URL-to-Issue map classifies only those native
timeouts as advisory unavailable results. The aggregate retains them in limitations and never claims
the URL was verified. Broken URLs, malformed/missing reports and unlisted timeouts remain blocking.
No scanner/test failure is converted into a successful check.

Documentation may exclude an exact historical directory with a trailing-slash `exclude` entry.
Current source links stay checked. `network_outages` maps native connection failures/timeouts to an
actual Issue; `access_outages.URL` requires the exact 403/429 status, reason and Issue. These remain
unavailable in results and limitations. HTTP 404 and other broken responses cannot use this path.

Target JSON rejects unknown or inapplicable fields. Pending recovery binds the same module/resource
selectors, artifact and generation; correcting a health endpoint does not retarget a service/project.
Compose uses `--no-deps` for precisely selected services and inspects their running immutable image
references before acceptance or recovery. APK manifests are parsed by the selected SDK apkanalyzer. AAB structure and manifest are validated
by the pinned bundletool selected through BUNDLETOOL_JAR. Missing native tools block delivery.
IPA/XCArchive application metadata is inspected; signing remains explicitly unverified by this generic artifact adapter.
Native signing checks and any store submission need their separately authorized SDK/account path.

The bundled Rust fixture declares and executes its minimum compiler through native configuration and tests both its
default and declared alternate feature implementation. A consumer declaring a different MSRV selects
that actual installed compiler through its native job/extra commands; no unexecuted MSRV is inferred.

`package.commands` selects native argument arrays for installed console scripts, for example
`[["project-cli", "check"]]`. They execute inside the same isolated consumer environment outside the
checkout, using the actual caller interpreter. Every command must belong to the built distribution;
system executables or a source checkout cannot satisfy this installed-CLI check.

Trusted command strings use Bash with `-euo pipefail` on Unix and a supported PowerShell with native
error propagation on Windows. Prefer argument arrays for project-native data arguments. The Python
fixture exercises both successful quoting and an earlier failing process in a native shell pipeline.

Inside GitHub Actions, the admission CLI checks the actual caller event/repository visibility and
refuses a mismatched policy before emitting runner labels. Fork context cannot assert trusted private
capacity. Public reusable workflow ownership never supplies a private caller's billing entitlement.

## Existing remote targets over SSH

Set the delivery composite's optional `transport-config` input to a caller-owned JSON file:

```json
{"kind":"ssh","hostname":"deploy.example.invalid","user":"deploy","port":22,
 "identity_file":"/run/example/ssh.key","known_hosts":"/run/example/known_hosts","python":"python3"}
```

The caller materializes the private key and pinned known-host keys from GitHub repository secrets
into its job directory (key mode 0600); it supplies the target configuration separately. No key,
password or GitHub token is copied into the application artifact or installed on the target.
The transport ignores ambient SSH configuration/agents and enforces the supplied host key.

`target_directory`, native tools and health/version URLs belong to the remote environment. The
existing SSH user needs access to that target and its selected service/registry. The target provides
an interpreter satisfying the [package runtime requirements](../pyproject.toml) and compatible PyYAML; the adapter installs no system packages,
service or deployment daemon. Its selected module's native tools must already be available.

The CLI downloads and verifies the artifact from the exact eligible successful main run and attempt
before SSH transfer. It transfers the artifact, bindings and the same licensed implementation into
an owned temporary remote directory, then the target rechecks bytes/modes and performs preflight,
locking, mutations and health locally.
The receipt must match the tested artifact, revision and target generation. Concurrent callers use
the lock in the same remote target directory. A network failure is not permission to replay an
uncertain migration; reconcile the target's durable record and use the existing recovery contract.
Only transport staging is removed automatically; current/recovery releases remain target-owned.

`tests/native_remote.py` exercises a separate SSH server/container and filesystem through actual
SSH/SCP with pinned host identity, concurrent clients and failed-health recovery. The integrated
main completion smoke uses that same transport with its successful full-CI artifact. This is representative
remote transport acceptance, not a production deployment or a separate physical-server benchmark.

The optional `remote-environment` input names a caller-owned JSON file of explicitly selected native
settings/credentials, such as a registry token sourced from repository secrets. It is transferred only
inside private SSH staging and applied only to the authenticated adapter process; it is not included
in release files or receipts. Runner GitHub/SSH authority and interpreter/search-path controls are
refused. Existing systemd service secrets remain in their native target-owned environment mechanism.

## Source releases for tagged repositories

The [source release composite](../.github/actions/source-release/action.yml) publishes a numeric tag
(`X.Y.Z`, equal to the tag and the repository's VERSION file) as one immutable GitHub Release. It
replaces the retired ci-workflows `release-supply-chain` reusable workflow, which some repositories
still called. The caller checks out `refs/tags/<version>` with full history and without persisted
credentials. The action refuses any other checkout and never checks out code itself. It produces:

- a deterministic tracked-source archive of the selected `archive-paths`;
- an optional runtime bundle of `runtime-paths`, which must be a subset of the archive;
- an SPDX SBOM of the exact archive payload (Syft, digest-verified download);
- canonical release notes, from `notes-file` or the matching CHANGELOG section;
- a release manifest and `SHA256SUMS`.

All assets are attached in a single `gh release create --verify-tag`. The action refuses an existing
release and never clobbers one.

Attestations (SLSA build provenance for the archive and runtime bundle, plus an SBOM attestation)
follow `attest`:

- `auto` (default) attests in public repositories only, because private repositories on GitHub
  Free, Pro or Team cannot store artifact attestations;
- `true` forces attestations;
- `false` skips them.

The caller job runs on Linux and grants `contents: write`; for attestations it also grants
`id-token: write`, `attestations: write` and `artifact-metadata: write`.

```yaml
jobs:
  release:
    runs-on: ubuntu-26.04 # or a private runner class route
    permissions:
      contents: write
      id-token: write
      attestations: write
      artifact-metadata: write
    steps:
      - uses: actions/checkout@<sha> # <release>
        with:
          ref: refs/tags/${{ needs.resolve.outputs.version }}
          fetch-depth: 0
          persist-credentials: false
      - uses: NDDev-Technocracy-Standarts/std-0004-ci-cd-workflows/.github/actions/source-release@<sha> # nddev-cicd-v<version>
        with:
          version: ${{ needs.resolve.outputs.version }}
          package-name: my-package
          archive-paths: README.md LICENSE VERSION CHANGELOG.md scripts
```

## Public security and release modules

`public-security.yml` is a public source-analysis reusable module for main pushes and explicit legacy PR callers. It executes pinned native CodeQL,
SARIF finding thresholds, Dependency Review and community runner hardening. Enable the repository's
free dependency graph before selecting Dependency Review. The module grants no private Code Security
entitlement, starts no private hosted helper, and returns no successful status for an inapplicable event.
Its successful output means both the native analysis and the selected finding gates completed.

When a CodeQL rule has no numeric security severity, the gate resolves its effective result level
using [the SARIF specification and its approved errata](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html):
an explicit result level wins, then the applicable invocation override, then the rule default,
and finally warning. A sole invocation is the default; multiple invocations need an explicit
result provenance index to apply an override. Driver and extension rules retain separate identities.
Invalid or ambiguous references fail validation. Numeric security scores keep the selected threshold.

`prepare-release` consumes the exact eligible source run through the same library ref as source CI.
Its explicit file selection produces a mode-preserving candidate tar, source/asset bindings,
SHA256SUMS and native Syft SPDX inventory. Package containers are safely exposed to native catalogers;
the library does not invent a dependency list. Native cataloger support still bounds what can be
identified. Supporting metadata describes those limits; an SBOM is not a vulnerability-free certificate.

Public `release.yml` adds actual GitHub provenance and SBOM attestations, verifies both signatures,
and uploads the candidate plus offline bundles. It follows successful full main CI or explicit main
dispatch. It creates no tag or published release. Private free consumers use the preparation
composite on their existing Linux job without assuming private GitHub attestations are available.
Actions retention is bounded; retain an accepted/current candidate in the project's existing release
store before expiration. Payloads are promoted unchanged; source is not rebuilt after integration.

## Native OCI archives

`oci-build` creates an actual OCI archive and source/digest/compiler metadata. Its default Buildx
builder is uniquely owned and removed without changing the default/shared builder. An explicitly
selected existing builder retains its caller-owned storage/GC policy. This pinned SDK surface is
currently Linux x64; cross-platform builds still need the corresponding project SDK/runtime tests.
The builder exposes no deployment/registry credentials to source PR code.

The build action accepts newline-separated `build-args`, `cache-from` and `cache-to`, using native
Buildx option syntax. Build arguments are non-secret `KEY=value` data; credentials belong to the
project's separately authorized native secret mounts. Argument names and a binding digest are
recorded without copying values into the artifact metadata.

Local exports need a dedicated contained directory and an explicit `cache-budget-bytes`. The
operation refuses foreign populated directories, holds an owner lock during use and fails when
the retained cache exceeds its declared budget. It never prunes host-wide caches or silently deletes
an over-budget store. The target owner reconciles that retained state. Declare the cache and lock
locations as local-only material. An existing caller-owned Buildx builder remains supported.

Registry and GHA caches are opt-in, with caller-owned capacity, authentication and retention. No
backend is enabled automatically or asserted free by its name. GHA uses only its native v2 runtime
credentials, an explicit project/platform scope and a finite transfer timeout. The action exposes
that runtime through a pinned native JavaScript action without logging credentials. Missing runtime
credentials fail explicitly; URL/token overrides are rejected. GitHub PRs can import caches but
cannot export them; exports require a trusted default-branch push or explicit dispatch. NDDev uses
main for this role. Heavy cache
and image work remains in the selected full-main path.

Retain both `dist/image.oci.tar` and `dist/image.oci.json` in the source artifact. `oci-publish` then
downloads the exact eligible full-main bundle and copies the archive through pinned native Skopeo without
rebuilding. Native inspection must confirm the same registry digest. It publishes a content-addressed
tag and returns `repository@sha256:...`; mutable channel aliases remain an independently coordinated
target operation. Caller secrets supply an explicit private registry auth file; optional native CA
material does not disable TLS verification. No registry/account/storage purchase is performed.

## Selected native coverage

Coverage budgets belong to the project. Selecting a source profile does not impose a universal
percentage or require an external reporting account. An explicit gate binds fresh reports to the
profile that produces them, for example:

```toml
[coverage.application]
profile="python"
path=".nddev-reports/coverage.xml"
format="cobertura"
minimum_percent=80
minimum_branch_percent=70
```

These percentages are illustrative project choices. Native Cobertura XML, LCOV, coverage.py JSON
and Go coverprofiles are supported. The primary metric is lines except for Go's native statement
coverage. A selected branch threshold requires measured branches; it cannot silently pass a report
without branch data. Empty, stale, malformed or escaping reports fail. Original reports are retained
with the source result on both threshold success and failure, independently from executed-test counts.
Projects may publish those native files through their existing separately selected reporting service.
No Codecov/Coveralls account, token or service is required by this contract.

## Ready bounded advanced operations

Source-only shared helpers are available through both the CLI and native project stage/extra commands.
`@library` preserves explicit native arguments and resolves the same isolated implementation.
For example, after selecting a real native source profile and preparing its pinned nightly/tool SDK:

```toml
[extras.fuzz]
purpose="Bounded native fuzzing of the selected parser"
command=["@library","advanced-fuzz","--target","parser","--corpus","fuzz/corpus/parser","--runs","1000","--seconds","30"]
timeout=600
```

For fuzz/mutation helpers, omitting `--output` under CI allocates diagnostics inside the retained
source result directory, including real failing inputs. Canonical seed corpora are copied before
fuzzing. Rust uses a pinned installed nightly's actual rustc/cargo paths and a preserved fuzz lock;
libFuzzer consumes a caller-built native executable. The native LLVM build stage owns its compiler
identity. SDK absence, zero native executions and changed locks fail.

`advanced-mutation` defaults to cargo-mutants and also accepts `--engine mutmut` or `--engine stryker`.
It requires a successful unmutated baseline and complete nonempty native outcomes, and applies the
project's explicit missed-mutant budget. Mutmut requires a POSIX fork-capable executor; its existing
workspace is never deleted or adopted. Only state created by this invocation is moved into retained
diagnostics. Stryker uses the project's installed dependency lock and native public SDK, forces
copy-based mutation and full measurements, disables dashboard reporters, and retains original native
outcomes and JSON reports. Native project breaking thresholds still apply. Missing, interrupted,
timed-out or incomplete results fail; zero actual mutations cannot pass. Other engine settings belong
to their native project configuration; `--timeout` remains the Cargo per-mutant setting.

The existing process budget reaps a nested SDK before an outer cancellation kills its intermediate
library process. Cancellation remains a failed operation and does not authorize a retry of target
mutations. Native logs, diffs and outcomes remain available for diagnosis.

`benchmark-compare` reads actual paired pytest-benchmark JSON, requires matching
case/tool/machine/interpreter identities and positive native measurements, then applies the explicit
regression ratio. These capabilities add no universal coverage percentage, schedule or production load.

The optional [benchmark composite](../.github/actions/benchmark/action.yml) uses the pinned native
github-action-benchmark SDK for Cargo, Go, Benchmark.js, pytest and Google Benchmark formats.
Supply `measurement-file`, `tool` and an explicit `maximum-ratio`. `mode: record` collects an initial
native history; `compare` requires its accepted `history-file` from a different source revision and
the same measured cases and units. Select comparable hardware, toolchain and measurement conditions
in the project workflow. This SDK does not establish machine equivalence. The accepted history is
copied before execution; only a successful nonempty comparison emits the next `history` output.
Caller artifact retention owns that file. There are no Pages writes, comments, external tokens or
silent replacement of a missing baseline. The stricter paired pytest helper remains available.

The optional [Scorecard composite](../.github/actions/scorecard/action.yml) collects the caller's
native source-host assessment on Linux with Docker. It publishes no external results and uses only
the provider token. The default is advisory: unavailable checks remain explicitly unavailable.
An optional `required-scores` JSON object, such as `{"Pinned-Dependencies":8}`, enforces the project's
chosen check scores. An empty assessment fails. Scores describe upstream repository heuristics;
they do not certify application security or qualify a deployment. Retain its original `report`
through the caller's ordinary artifact policy.

The optional [ClusterFuzzLite composite](../.github/actions/clusterfuzz/action.yml) builds native
C/C++ fuzz targets and runs a bounded batch with an explicit `seconds` budget. The caller supplies
its real `.clusterfuzzlite` Dockerfile, build script and project configuration in `project-directory`.
The digest-pinned upstream SDK uses its native standalone mode against that checked-out source,
without cloning a second revision or requiring a root configuration. It requires a public
repository and a disposable GitHub-hosted Linux job: upstream SDK disk cleanup is unsuitable for
a persistent private Docker host. Build validation is mandatory, broken-target allowance is zero,
and dry-run is disabled. Split `phase: build` and `phase: run` only to prepare native corpora between
validated build and execution in the same job. No storage repository or schedule is selected.
The composite retains the SDK's reproducing inputs and stacks as GitHub artifacts; a finding or
unavailable SDK fails. Native SDK images are pinned by digest. Persistent SDK storage is disabled.
Use the existing direct libFuzzer/Cargo helper when that SDK execution model is unsuitable.

Before recursive source checks, native gitlink validation rejects stale, dirty, unavailable or
symlinked submodule worktrees. Callers initialize each required checkout using their existing scoped
credentials; the library does not delete stale worktrees or fetch arbitrary submodules automatically.
The same inputs are checked again before an aggregate can pass.

## Mechanical documentation scope

The existing documentation profile can select finite `documentation.style` path lists for authored,
generated, historical, literal and legal Markdown. Every tracked Markdown document then has one
explicit source role. An empty selector, conflicting ownership or an unclassified document fails.
Historical, fixture and legal exemptions require their actual source locations; an active README
cannot be hidden through a whole-file exemption.

Selected active text is checked for copied release values, fingerprints, transient claims, em dashes
and emoji. Native Markdown tokens distinguish links and code; identity checks also cover authored
comments, HTML attributes and fenced examples. Native link destinations retain their identities.
The check reports paths and mechanical categories without printing document content. It does not
establish factual correctness or semantic completeness. See this repository's
[native contract](../.github/nddev-ci.toml) for a selected example.


## Explicit native shapes and diagnostics

Impact paths use root-anchored POSIX globs: `*` stays within one path segment and `**` spans zero or
more segments. Exact native root lock names are shared inputs. A covered nested lock follows its component and
affected dependents; an uncovered path remains conservative. A source name containing `lock` is not
a shared lock. Explicit shared globs still take precedence. Fetch the comparison base explicitly or use
`fetch-depth: 0`; unavailable bases select every component. The `impact` composite exposes `selected`,
`not-applicable`, `profiles` and `base` as JSON. A dependent job can use
`if: contains(fromJSON(needs.impact.outputs.selected), 'backend')` before SDK/sidecar setup.

The security profile's default history scan requires `fetch-depth: 0` and a positive native scanned
commit count. A shallow checkout or a scanner that examined no commits fails. Machine Git output
ignores inherited global/system/config-injection settings and disables colour. Caller overrides of
security commands own their actual coverage and native finding thresholds.

Private Linux has a free Python route through the `tools` action's `security` capability. It
provisions checksum-verified Gitleaks/OSV and lock-resolved Bandit in job-owned storage. The security
profile defaults use these native tools with an explicit project policy, without CodeQL access:

```toml
[security]
python = ["src/**/*.py"]
licenses = ["MIT", "Apache-2.0"]
```

`python` scopes must each match tracked source. Bandit findings fail SAST; OSV checks lock-derived
dependencies and the caller's SPDX license allowlist. The sample licenses are illustrative, not a
legal grant or a universal allowlist. Missing scopes, missing policy, unavailable tools and scanner
errors fail. Other languages can select local Semgrep CE rules or their explicit native
`commands.security.sast` checks; the Python default does not claim to analyze them. OSV uses its native advisory and deps.dev metadata
services. This route needs no paid GitHub security service and cannot waive required security stages.

For an independently selected SAST stage or extra, Semgrep uses an explicit project-owned source
and rule selection:

```toml
[security]
engine="semgrep"
rules=["security/rules.yml"]
paths=["src/**/*.py", "web/**/*.js"]
```

Rules must be tracked local regular files with their original grants preserved. Language-specific
rules remain the project's responsibility. The helper uses only the OSS engine, disables metrics
and version checks, isolates its settings from host accounts, and accepts no remote rule URL.
Native findings, scanner errors or a source scope missing from the native scanned-file result fail.
The original JSON and separate diagnostic stream remain in the source result. Selecting this helper
does not select the full security profile or authorize a license policy.

Spelling and unused-dependency checks remain explicit project extras. The `quality` tool capability
provides `typos` and `cargo machete`; `rust` also provides the latter. Select actual tracked text or
native Cargo manifests, for example `command=["typos","README.md","src"]` or
`command=["cargo","machete","--with-metadata"]`. Project dictionaries and intentional dependency
exemptions belong in those tools' native configuration. Findings fail the selected operation;
these tools do not establish prose quality or replace dependency vulnerability checks.

Tracked locks at every depth are bound to the result and checked again after execution. Native
ecosystem names include JavaScript managers, Gradle and Swift. `[inputs] locks = ["config/tool.lock"]`
adds a project-specific tracked input; a selector matching nothing fails.
`[inputs.manifests] sql-data = ["database/revisions/*.py"]` names an actual migration layout.
Selectors must remain inside the selected project. Alembic, nested SQL/ORM migration scripts,
recursive shell scripts and named Dockerfile/Containerfile layouts are recognised directly.
Non-default layouts supply their real native lint/build/test commands.

Requirements-only Python applications provide explicit commands for each stage instead of invoking
package defaults against a nonexistent project. `[not_applicable.python]` can give bounded nonempty
reasons for `build` and `consumer`; `[not_applicable.typescript-javascript]` can explain `package`.
The result records `not-applicable` with its reason. Tests, setup and security cannot be waived.
A prerequisite that did not execute cannot satisfy a dependent native operation. Application image
or bundle packaging uses its real command; an unneeded wheel or registry package uses the declared
non-applicability. An empty command or successful no-op is not evidence of packaging.

JavaScript and web defaults resolve one native manager from `packageManager` and the tracked npm,
bun, pnpm or yarn lock. Conflicting managers fail. Frozen installation and script commands use that
manager. Node remains part of the toolchain even for bun; provision both when the project requires
Node-based tools. Non-npm package publication needs an explicit native command or allowed
non-applicability. Test scripts select their actual unit/browser scopes so bun does not collect
Playwright cases accidentally. The library neither provisions every SDK nor changes caller uv:
its own bootstrap uses an absolute verified executable outside caller PATH.

The Linux `tools` action accepts a space/comma-separated capability list, for example
`capability: security shell container`. Workflow tools include actionlint, lychee and zizmor;
security adds Gitleaks, OSV-Scanner and the locked Python SAST toolchain; quality adds isolated
Semgrep/mutmut plus typos and cargo-machete; rust adds cargo-deny, cargo-audit, cargo-nextest,
cargo-machete and sccache; compiler adds ccache; shell adds Bats and ShellCheck. The native script validates
capabilities and verified owned binaries before reuse. SDKs and system libraries such as libmagic
belong to the runner owner or an explicit job-local caller setup. A caller setup verifies downloaded
packages against its trusted native package metadata and supplies only that job's library paths;
the shared action does not install packages into the host.

Non-success stages print a bounded diagnostic tail in the job log and an escaped summary detail.
`[diagnostics] tail_lines = 200` selects the limit, from zero to one thousand. Passing stages keep
full logs without flooding the console. Known sensitive environment values (names containing
TOKEN, SECRET, PASSWORD, CREDENTIAL or PRIVATE_KEY, values at least four characters) are redacted
from registered stdout/stderr logs, retained native text reports and result text after native
parsing and cache finalizers, including failure paths. Native JSON/XML reports keep their format;
caller originals and application payload bytes/digests are preserved. Nested helpers register their
owned diagnostics separately from corpora, failing inputs and mutated source. Upload requires
completed diagnostic export preparation; interrupted/failed preparation cannot upload raw results.
This treats known values, not arbitrary unknown or encoded private output; caller-native masking
and safe commands remain necessary.
Workflow-command processing is suspended while tails are printed.

The CI action accepts `upload: always`, `failure` or `never` and `retention-days` from one to three.
The compatibility default is `always`. Text results use artifact compression. `deliver`,
`oci-publish` and `prepare-release` need `always` on their source run because they consume its exact
bundle. A log-only caller can select failure-only upload or retain diagnostics in the native log.

Container and infrastructure contracts may declare `[commands.container] cleanup = [...]` or the
corresponding infrastructure command. Selected cleanup runs after success, failure, native timeout
or cooperative cancellation, and cleanup failure also fails the aggregate. It removes only resources
owned by that invocation. Use run ID, attempt and component in tags/container/network names.
A shared-host prune is not a cleanup contract. Runner termination can bypass process cleanup;
self-hosted callers also retain an `if: always()` recovery step scoped to those same resource IDs.

## Failure feedback and pin identity

The `feedback` composite accepts exact workflow paths and a creator allowlist, plus one completed
`run-id` or bounded reconciliation of recent completed runs. It needs `actions: read` and
`issues: write`. An optional `task-issue` receives deduplicated comments; otherwise one failure Issue
is created for each run attempt. Closed markers are reused and reruns have distinct attempt markers.
Markers are accepted only from the workflow bot or explicitly allowed actors. Missing pagination
coverage fails before publication. Reconciliation defaults to the native default branch and push, schedule and workflow_dispatch events
within seven days. `events` and `branches` explicitly select other cases, including PRs or a
workflow_run delivery handler; both filters also apply to an explicit run ID. `since` selects a UTC
lower bound within thirty days. `page-budget` bounds run-list API requests across all workflows,
branches and events; exhausted coverage fails before writing. Failed job names come from the exact
attempt's bounded native job metadata; `stale` is a supported failure conclusion.
All publishers in a repository share one concurrency group with
`cancel-in-progress: false`, so simultaneous event and reconciliation calls serialize.

A trusted `workflow_run` caller invokes the pinned action without checking out the failed candidate,
reading its artifacts or executing its code. Pass only the native run ID as data; paths, creator
allowlists and permissions come from trusted workflow configuration. The same bounded entrypoint
can serve an explicitly declared feedback schedule; it does not rerun source CI or repair code.
The owning agent still returns to native diagnostics and unresolved task work.


### After diagnosis, follow the actual implementation owner

A failed consumer run establishes a failure in that run's selected context. It does not itself
identify a shared library defect. Inspect the exact selected library revision, run and attempt,
contract, original diagnostic and a bounded reproduction. Distinguish consumer configuration or
code, an unsupported capability claim, a shared implementation defect, executor or connectivity
failure, and an unavailable external service. Preserve uncertainty when evidence does not identify
the cause.

Keep the original consumer task and run linked. Create or reuse the Issue in the repository that
owns a confirmed problem, including the affected contract, public provider pin, impact, relevant
facts and remaining uncertainty. Search existing open and closed work first. For a public report,
use a sanitized minimal reproduction; keep private source, repository identities, host paths,
credentials and raw diagnostic payloads in their authorized private location.

An active repair has one current execution owner until an explicit handoff. Another agent's
report, contribution or Issue link does not silently transfer that responsibility. Coordinate
with an existing repair through the task's accepted collaboration method. Ordinary authorized
work does not acquire another waiting or approval stage solely because it affects a shared
component; changes outside that authority follow the consuming project's decision process.

| Confirmed situation | Follow-through |
| --- | --- |
| Consumer-only defect | Correct the consumer and verify its affected scenario. |
| Shared defect necessary to the current task | Link the provider Issue, correct the actual owner within task authority, and retain the original consumer failure. |
| Duplicate report | Add relevant distinct evidence to the existing owning Issue. |
| Another owner is already repairing it | Contribute evidence and coordinate scope without creating a competing writer. |
| A provider correction requires a consumer update | Link a task in each affected project and identify its actual implementation owner. |
| The provider has published but a consumer is unchanged | Record provider publication separately; consumer acceptance remains pending until its selected update and checks complete. |

Select updates and procedures for the actual authorized scope. Keep required checks and truthful
unresolved results; publication does not imply fleet migration, deployment or product acceptance.
This guidance adds no automatic classifier, cross-repository publisher, permission, scheduler or
routing registry.

The native [runtime lock](../.github/runtime-lock.json) maps reviewed implementation and reusable workflow
commits independently. A draft pin has no invented release-tag comment. Published release notes
must identify both native refs; a standard edition tag alone does not identify the facade/backend
pair. The online zizmor job complements offline source analysis with read-only metadata checks.


## Validation phases

The short PR gate uses finite syntax, lint/type, relevant unit and critical secret checks. Full main
CI owns native builds, SDK/browser cells, package consumption, selected security and target readiness.
Each repository keeps its real commands in the existing workflow/contract, without a second gate
inventory. The convention is one stable `gate` aggregate in the existing PR workflow. It accounts
for every applicable premerge obligation and fails unexpected missing or skipped work. A native
main check with the same job name does not satisfy this phase.

`nddev-cicd eligible --phase pr --repository OWNER/REPO --workflow .github/workflows/ci.yml
--run-id RUN --revision HEAD --pull-request NUMBER --target dev` reads that existing aggregate.
It requires the exact PR event, current head, target/base, latest run and successful latest attempt;
pending, cancelled, missing, superseded or non-success evidence is refused. `--aggregate` supports
an existing different aggregate name without copying its check inventory. The result is read-only
evidence, not an atomic base lock: reconcile candidate and material base changes immediately before
an ordinary guarded merge under the adopted branch policy.

GitHub dev pushes perform neither full CI nor CD. An existing dev server builds dev
locally; repositories without one can still promote normally. A parent task remains open until its
applicable main validation and target acceptance finish.

A main impact contract declares `impact.baseline_workflow` as the exact full-validation workflow.
Its comparison starts at a completed successful ancestor obtained from bounded native run metadata.
Failed, pending and cancelled pushes cannot advance that baseline. Missing history or API coverage
selects every declared component. Shared inputs and dependency closure still apply. Superseding main
CI can cancel obsolete source work; target mutations use their existing lock and recovery rules.
A source-only repository has a package/documentation completion boundary and needs no invented server.

The [native cache lifecycle](cache-lifecycle.md) describes placement, completed
use, descendant protection and the qualification required before host adoption.
