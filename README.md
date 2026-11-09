# NDDev CI

The shared CI library of NDDev projects: checks, images, releases, publication and security,
through the same `just` commands an agent runs.

## Use

The library provides reusable delivery workflows for NDDev projects. A project
calls its reusable workflows, pinned to a released commit with the version as the comment, so
Dependabot proposes each new release (`uses: …/check.yml@<commit> # v<version>`). Start from the
callers in [examples/](examples/): `ci.yml` for the checks, `release.yml` for releases and
`security.yml` for the daily security run.

| Workflow or action | Does |
| --- | --- |
| `.github/workflows/check.yml` | The short check of a pull request and the full check of `dev` through the project's `just` recipes, with the merge stops |
| `.github/workflows/merge-stops.yml` | The merge stops beside a project's own command jobs |
| `.github/workflows/recipe.yml` | One `just` recipe on a chosen runner, the unit of a native platform matrix |
| `.github/workflows/image.yml` | A container image built once and pushed by commit |
| `.github/workflows/release.yml` | An immutable GitHub Release of the commit `main` moved to, from its verified `dev` check |
| `.github/workflows/image-tag.yml` | The release's version tag on the checked image digest |
| `.github/workflows/registry.yml` | Publication to crates.io, PyPI or npm through trusted publishing |
| `.github/workflows/provenance.yml` | Build provenance attestations of a public repository's artifacts |
| `.github/workflows/renovate.yml` | Scoped, scheduled Renovate on an explicitly selected managed runner |
| `.github/workflows/security.yml` | The daily security run: live secrets, dependencies, licences, SBOMs and images |
| `actions/hosted-sdk`, `actions/hosted-cache` | Exact SDKs, tools and dependency caches on GitHub's runners |
| `actions/qualify`, `actions/checked-artifacts` | Exact full-check qualification and separate verified artifact transfer |
| `actions/recipe`, `actions/release-assets` | A pinned Just frontend and verified native tool assets |
| `actions/telemetry`, `actions/job-record` | Outside telemetry off; each job's summary and structured record |

Every workflow names its runners the same way: `runner` is the label of our runners for a private
repository, `hosted-runner` the GitHub-hosted runner of a public one.

| Managed runner class | Project commands | Linux-only scanners and images |
| --- | --- | --- |
| `nddev-linux-standart`, `nddev-linux-small` | Linux x64 | Same class |
| `nddev-linux-arm64` | Linux ARM64 | Same class |
| `nddev-macos` | Native macOS ARM64 | `nddev-linux-arm64` |

Managed jobs use their private user account and prepared SDKs without sudo or global installers.
A requested SDK or command-line tool must already match its exact version; a mismatch fails before
project preparation. Linux ARM64 rejects Flutter because no official SDK is published for it.

## Checks

`check.yml` runs the project's own recipes:

| Event | Runs |
| --- | --- |
| Pull request | `just check`, then `just test` when the repository declares it |
| Push to `dev`, or a run by hand | `just verify` |

- Public repositories always run on GitHub's runners. Private ones run on our runners, the label
  in the `runner` input, unless the pull request carries the label `runner:blacksmith`
  (Blacksmith's 2-vCPU runners, within their free minutes) or `runner:github` (GitHub's runners),
  or a run by hand chooses `blacksmith` or `github` in its `runner` input. Adding such a label
  reruns the check there; other labels do not. Nothing moves a waiting job on its own.
- Managed runners provide their SDKs, package stores and compiler-cache configuration through
  their execution environment. The library preserves `CARGO_HOME`, `RUSTC_WRAPPER` and the
  compiler-cache settings; it does not read host configuration files or install a second cache client.
  The job record includes sccache counters when the environment selects it.
- `artifact-registry` optionally selects the tool-download registry. An empty input uses the
  runner's optional `NDDEV_CI_ARTIFACT_REGISTRY`; when neither is set, downloads use official
  upstream REST and PyPI sources. No private environment variable is required. A declared
  unavailable registry fails bootstrap, and archive and wheel checksums remain mandatory.
  The registry serves `/github-releases/sha256/<digest>/<owner>/<repository>/releases/download/<tag>/<asset>`,
  `/pypi/simple/<project>/` metadata and `/pypi-files/` payloads. It is a download source,
  separate from dependency caches and compiler-cache configuration.
- A repository may omit recipes that have no work, as the command standard allows.
  The short check reads the parsed justfile before deciding whether to run `test`,
  aliases included. A failed check, a failed declared test or an invalid justfile
  remains a failure. The full check always runs `just verify`.
- `setup: true` runs `just setup` before the checks. A project whose `just check` works without
  network access takes its dependencies and data there first.
- `fetch-depth` (default 1; 0 is the whole history) and `filter` (such as `blob:none`) go to the
  checkout, for checks that read history, such as a version rule that compares a pull request with
  its base.
- `sparse-checkout` leaves part of the tree out of the checkout, such as generated store images a
  check never reads: patterns one per line, read as cone directories unless
  `sparse-checkout-cone-mode: false` makes them gitignore-style patterns. Empty keeps the whole tree.
- A new push to a pull request cancels its older check and merge stops. Every commit of `dev` and
  `main` keeps its own full check.
- The check runs natively on Linux x64 or ARM64, or managed macOS ARM64. A public repository may choose its GitHub-hosted
  runner in `hosted-runner`: `ubuntu-24.04` (the default), `ubuntu-24.04-arm`, `ubuntu-26.04` or
  `ubuntu-26.04-arm`. Each job turns outside telemetry off (`actions/telemetry`) and ends with a
  summary of its runner, architecture, duration and compiler-cache use.
- `diagnostics` names workspace-relative reports, one per line, such as test reports. When the check
  fails they are kept for 14 days as the artifact `diagnostics-check-<attempt>`, so a failure can be
  read without host access. Only the named files are kept; absolute, parent and hidden paths are
  refused, and a failed check never leaves its release artifact.
- The optional secret `read-keys` lets the check read other private repositories, such as a
  superproject's modules: for each repository a line `owner/repository`, then its read-only deploy
  key. GitHub accepts a deploy key for its one repository only, so each repository gets an ssh host
  alias with only its key, over GitHub's port 443, and git rewrites the repository's `git@`,
  `ssh://` and `https://` addresses to it. `git submodule update --init` and `git clone` then work
  in the project's recipes. The keys stay in the job's temporary folder, and the merge stops never
  receive them.
- A project may name an `artifact`, such as a release binary, and an `artifact-name`. The full
  check keeps it with its run for 90 days, so a deployment takes the build of a checked commit.
- A pull request also runs the merge stops: Betterleaks over the change's commits,
  and actionlint, zizmor (high severity) and poutine (warnings and errors; its notes are only
  reported) over the workflows, and committed over the change's commit messages: a Conventional
  Commits subject in the imperative up to 72 characters, lines up to 100, no fixup or WIP commit,
  unless the repository has its own `committed.toml`. It checks only the commits the change brings:
  merge commits and commits another branch already holds are left out. Any of them stops the merge.

The same PR job compares tracked source lockfiles with OSV-Scanner. It binds the exact head and
proposed merge commits and compares the merge with its own base, which must be the pull request's
base or a later commit the base branch moved forward to, reads Git blobs rather than the working tree and runs no package
installers, build scripts, dependency resolution or call analysis. A change to a supported lockfile
or dependency declaration selects all supported tracked lockfiles in both the base and merge.
Unchanged dependency inputs and repositories without supported tracked lockfiles are explicitly
reported as skipped. Images, submodules and installed packages remain outside this source check.

One preparation downloads the union of the required vulnerability databases. Both scans then run
offline against those same verified database bytes, with an empty configuration outside the input
tree. A PR cannot hide findings with scanner ignore files. Only a newly introduced finding with
the scanner's computed score of at least 9.0 and a matching advisory's fixed-version event stops
the comparison. Existing findings, unknown or lower severity and critical findings without a fix
remain diagnostics. Advisory aliases and Git lockfile renames preserve existing findings.
Source revisions, blob digests, scanner pin and database digests are recorded in the job.
Unavailable tools, malformed extraction and database errors fail the check explicitly.

An organization that disables deploy keys can use its admitted GitHub App instead.
The caller supplies `read-app-client-id`, `read-app-installation-id`, an explicit
list of `read-repositories`, and the `read-app-private-key` secret:

```yaml
with:
  setup: true
  read-app-client-id: ${{ vars.CI_READ_APP_CLIENT_ID }}
  read-app-installation-id: ${{ vars.CI_READ_APP_INSTALLATION_ID }}
  read-repositories: |
    example-org/private-module
secrets:
  read-app-private-key: ${{ secrets.CI_READ_APP_PRIVATE_KEY }}
```

This profile accepts repositories in the caller's organization only and cannot
be combined with `read-keys`. The signing step requests a short-lived installation
token with `contents: read` for exactly those repositories, then checks the granted
permissions and repository list before exposing it to Git. The PEM key reaches
only that step; it is never written to disk or passed to the project's commands.
Git recipes use HTTPS module URLs. The token is masked, lives in the ephemeral job
environment, and is revoked in an always-run cleanup step. A forcibly terminated
runner can miss cleanup; GitHub's installation-token expiration remains the bound.
Merge stops receive neither credential. The caller keeps the App key in its
repository secret under its contour's key policy; this library stores no keys.

## Merge stops beside a project's own jobs

A project whose commands run in its own native, database or browser jobs keeps those jobs and
calls `.github/workflows/merge-stops.yml` beside them, pinned to the same commit, instead of
copying the stops or running `check.yml` a second time:

```yaml
jobs:
  merge-stops:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/merge-stops.yml@<commit>
    permissions:
      contents: read
```

It runs only for pull requests, on the runner rules above, and applies the same tools, pins and
conditions as `check.yml`. The stops run natively on Linux x64 or ARM64, each archive with its own
pinned digest. A public repository may choose its GitHub-hosted Linux runner in `hosted-runner`:
`ubuntu-24.04` (the default), `ubuntu-24.04-arm`, `ubuntu-26.04` or `ubuntu-26.04-arm`.

## Outside telemetry

`actions/telemetry` sets the switches of `actions/telemetry/switches.env` for the rest of its job,
so tools and SDKs on GitHub-hosted runners send nothing to their makers and skip update checks, as
on our runners, which carry the contour's own list.

## Job records

Each job of the library ends with `actions/job-record`: a summary on the run page and one JSON log
line with OpenTelemetry's CI/CD and VCS attribute names, and carries
`event.name` `nddev_ci.job.completed`, the workflow and run (`cicd.pipeline.*`), the task, its
type and result (`cicd.pipeline.task.*`, with `success`, `failure` or `cancellation`), the runner
(`cicd.worker.name`), repository, ref and commit (`vcs.*`), system and architecture, measured queue time when supplied by the runner, duration and
compiler-cache counters, and never a secret or command output. When our runner names a file in
`NDDEV_CI_TELEMETRY_FILE`, the line is appended there and the contour delivers it to its
observability stack; GitHub's runners keep it in the job log.
The runner may supply `NDDEV_CI_QUEUE_SECONDS` (or the action's `queue-seconds` input). Missing queue
time stays unknown; it is never reported as zero.

## Hosted SDK preparation

`check.yml`, `recipe.yml` and `actions/hosted-sdk` prepare only the SDKs explicitly selected by the caller.
On GitHub-hosted runners both workflows also restore the dependency caches of
`actions/hosted-cache` unless `hosted-cache: false`. The SDK inputs are:
`node-version`, `python-version`, `uv-version`, `bun-version`, `rust-version`, `java-version`
(Temurin), `go-version` and `flutter-version` (stable, with its Dart SDK, whose version the receipt
also records; Flutter publishes Linux and Windows SDKs for x64 only, so an ARM64 Linux or Windows
runner refuses it; Temurin publishes no JDK for Windows on ARM64, which refuses `java-version`). Each value is an exact stable version; an empty input leaves that SDK unchanged.
Node, Python and uv come from GitHub releases; once a job has prepared an exact selection on a
runner image and architecture, later jobs of the repository restore it from the Actions cache and
download nothing. The 8–9 November 2026 HTTP 504 failures of anonymous release downloads showed
why. Flutter comes from its official release manifest and archive on Google's storage, verified by
the manifest's SHA-256 and cached the same way; flutter-action is not used because it calls
actions/cache by tag, which commit pinning refuses. The JDK uses setup-java's own SDK cache.
Flutter and Dart analytics are turned off.

`tools` takes comma-separated `name@version` command-line tools, such as
`cargo-nextest@0.9.151,cargo-deny@0.20.2,cargo-audit@0.22.2,cargo-shear@1.14.0`, at the
caller's exact versions. They come from their official releases through `taiki-e/install-action`,
which verifies each archive against its checksum manifest; nothing is compiled and no other
source is tried. Private runners verify their managed SDK instead.
The Bun setup action receives the native asset's official API redirect for the selected stable
tag. Its published source identity is recorded, its installed version is still measured and the
transient signed transport URL is masked. It never selects another provider or architecture
when the native asset cannot be resolved.
`rust-components` and `rust-targets` accept comma-separated names alongside a Rust selection.
The workflows use the same action and pinned upstream setup actions, then measure the actual executables before `just setup` or the selected preparation recipe.
A missing or different version fails before project preparation. Its `receipt` output
records the measured versions and native OS/architecture. It installs only on GitHub-hosted
runners; managed private environments retain their SDK provider and verify the selected executables.

```yaml
- uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/hosted-sdk@<commit>
  with:
    node-version: ${{ vars.CI_NODE_VERSION }}
    bun-version: ${{ vars.CI_BUN_VERSION }}
    rust-version: ${{ vars.CI_RUST_VERSION }}
    rust-components: clippy,rustfmt
```

A project's `just setup` must support its chosen execution environment. Hosted jobs use the
explicit SDK inputs and official upstream downloads; they cannot invoke a private runner installer
or require private cache settings. Recipes that optionally read the tool-download registry use
`NDDEV_CI_ARTIFACT_REGISTRY` with an empty default. Updating the library alone cannot repair a
caller's mandatory private environment-variable lookup.

Projects select their compatible versions and retain dependency locks, browser and native
prerequisites, and their own setup/check/test recipes. Preparing a language SDK does not
install all tools for that language. In particular, FFmpeg and ffprobe require an explicit
qualified binary provider with the needed codecs and filters; neither a Python wrapper nor
an arbitrary preinstalled executable supplies that contract. Native prerequisite acceptance
still belongs to the consumer's complete tests. SDK preparation never adds media binaries
to a product distribution.

The action disables Bun's outside telemetry and isolates uv's cache and project environment
in the job's temporary directory. A selected Python is also passed to uv. Package caches
are not implicitly enabled by upstream setup actions.

## Hosted dependency caches

`actions/hosted-cache` restores a hosted job's dependency caches, keyed by the lock files in its
`working-directory`: Cargo through rust-cache when `Cargo.lock` exists, and the Bun, npm, pnpm and
uv package stores for `bun.lock`, `package-lock.json`, `pnpm-lock.yaml` and `uv.lock`. As with
the contour's network cache, jobs of `dev` and `main` save at the end of a successful job and
every other job only reads, so a pull request never writes what a release build reads. It serves
GitHub-hosted runners only; our runners use the network cache. Package managers still verify
every package against the lock files. The Cargo cache keeps dependency artifacts only: Cargo judges
workspace packages by source mtimes, so their artifacts are always rebuilt from the checked-out
sources. A project's own persistent target cache, such as a BuildKit cache mount, follows the same
rule (contour-platform-infrastructure#168).

## Native recipe steps

Projects with separate native, database, browser or packaging jobs can invoke their
own just recipes through `actions/recipe`, pinned to a commit. Each job keeps its
runner, SDK preparation, services, permissions and acceptance evidence.

```yaml
- uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/recipe@<commit>
  with:
    recipe: desktop-test
    arguments: '[]'
```

`arguments` is a JSON array of strings. The action passes argv directly to Just;
the recipe owns any shell quoting within its commands. `working-directory` and
`justfile` stay inside the checked-out workspace, including resolved symlinks.
Hosted Linux, macOS and Windows runners receive a pinned Just executable whose
archive, size and extracted bytes are verified. A self-hosted runner must already
provide the matching managed frontend; this action installs no compiler or SDK.

For an entire command job, call `.github/workflows/recipe.yml` at a pinned commit.
Like every workflow of the library, `runner` is the label of our runners for a private
repository and `hosted-runner` the GitHub-hosted runner of a public one: `ubuntu-24.04`,
`ubuntu-24.04-arm`, `ubuntu-26.04`, `ubuntu-26.04-arm`, `macos-15`, `macos-26`, `windows-2025` or
`windows-11-arm`. It takes the `recipe`, JSON `arguments`, an optional dependency `prepare` recipe,
the checkout depth and the SDK and `tools` inputs of `check.yml`; private runners keep their
prepared toolchain and cache placement.
Specialized jobs keep services, signing, packaging and acceptance in their owning
workflow and use the recipe action for individual commands.

A native platform matrix is a caller matrix over `recipe.yml`, with `merge-stops.yml` beside it:

```yaml
jobs:
  native:
    strategy:
      fail-fast: false
      matrix:
        hosted-runner: [ubuntu-24.04, ubuntu-24.04-arm, macos-26, windows-2025, windows-11-arm]
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/recipe.yml@<commit> # v<version>
    permissions:
      contents: read
    with:
      hosted-runner: ${{ matrix.hosted-runner }}
      recipe: test
      artifact: target/package
      artifact-name: package-${{ matrix.hosted-runner }}
      diagnostics: target/reports
  merge-stops:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/merge-stops.yml@<commit> # v<version>
    permissions:
      contents: read
```

`recipe.yml` keeps a named `artifact` of every run outside pull requests for `release.yml`, keeps
named `diagnostics` of a failed run for 14 days, accepts `sparse-checkout`, and ends with a summary.

For this repository, run `just setup` once before offline `just check`. Execution
tests belong to `just test` and `just verify`. Its Linux x64 check tools use exact
upstream archive/wheel digests and installed-binary receipts. Setup prepares each
replacement privately before publishing it and removes the exact obsolete tool
generations. Checks only verify that prepared content; a missing or changed tool
requires setup. The pinned PyPI wheel supplies zizmor's standalone binary without
a retained Python environment.
The merge-stop job extracts the same pinned standalone wheel and creates no Python environment.

## Pinned public assets

`actions/release-assets` prepares tools used by hosted native packaging jobs.
Its manifest lives in the caller checkout and contains `schema_version: 1` and an
`assets` array. Each entry pins `repository`, numeric release `asset` ID, exact
`size`, `sha256`, destination `file` basename and optional `executable: true`.
The destination stays inside the checkout or `RUNNER_TEMP`; symlink escapes and
nonregular targets are rejected before writing. Prepared private runners keep
their native provider instead of bootstrapping tools through this action.

Downloads use the official public release API, with the existing job token only
on that API request. Redirected content receives no credentials. A bounded retry
handles transport failures from the same immutable source; permission refusals,
byte mismatches and recipes are never retried. Valid warm files are checked and
reused. New bytes replace the destination only after size and digest verification.

An archive may declare `members`, each with an exact internal `path`, portable output
`file` basename, `size`, `sha256` and optional `executable: true`. Only those byte streams
are copied; the archive tree is never extracted into the workspace. Each member is bounded
at 256 MiB, the full output inventory at 128 files and the receipt at 64 KiB. Duplicate
names, case aliases, device names and escaping paths fail before preparation. A failed
member check preserves the previously accepted destination. Archive and warm member
hashes are read in bounded chunks.

Windows uses its system archive program, so a recipe's shell cannot replace it with
Git's GNU tar, which interprets drive-letter paths as remote archives. Cold Just preparation
uses the same bounded, verified member extraction as native tool assets.

The reusable `check.yml` and `recipe.yml` accept `tool-assets`, the path of this
caller-owned manifest. On hosted runners the verified executables reach PATH before
project setup or the selected preparation recipe. A private runner refuses that input
and retains its managed SDK. Omitting the input prepares no native assets.
When an artifact registry is selected, each manifest asset also names its exact `tag` and upstream
`name`; these identify the registry route while `asset`, size and digest remain the byte pins.

`add-to-path: true` exposes the directory only after every declared file has passed;
it requires at least one explicitly executable file. The `receipt` output records verified
archive and file identities. This supports independently qualified native tools without
putting their versions or provider choices in this library. A file's digest does not replace
its provider, licence or consumer qualification.

The diff secret scan uses Betterleaks' built-in detection rules. Repository-local scanner
configuration is not loaded automatically. The newer scanner isolates local Git configuration;
this workflow does not opt out of that boundary.

## Releases

A project calls `.github/workflows/release.yml` when `main` moves forward. It publishes that commit
as one immutable GitHub Release without building again (`actions/release`). It takes the newest
push check of that exact commit on `dev` from the caller's check workflow: a newer failed,
cancelled or unknown run is never replaced by an older green one, a running check is awaited up to
`wait-minutes`, and a missing one stops the release. A commit with the same tree but another
identity never borrows a result.

```yaml
on:
  push:
    branches: [main]
jobs:
  release:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/release.yml@<commit> # v<version>
    permissions:
      actions: read
      contents: write
    with:
      check-workflow: ci.yml
      artifacts: |
        build
```

The named `artifacts` of that run are downloaded with their recorded digests, and their top-level
files become the release files, with `SHA256SUMS`. Folders, links and hidden or repeated names
stop the release. The version raises the last number of the newest `<tag-prefix><version>` tag;
the owner chooses a new first or middle number through `version`. The tag is created at the
commit, never moved, and a draft receives and verifies every file before it is published.
A rerun finds the same tag and release and completes them once. Public repositories release on
GitHub's runners, private ones on `runner`. Enable immutable releases in the repository settings:
GitHub then protects the tag and signs the release, and `gh release verify-asset` checks a file.

This library releases itself the same way (`.github/workflows/publish.yml`). Callers pin a
released commit with its version as a comment, so Dependabot proposes each new release.

## Qualifying deployments

`actions/qualify` selects the newest full check of an exact repository, commit, workflow, event and
integration branch. It refuses malformed or truncated run inventories, failed or unknown results,
and an older green run when a newer attempt exists. A pending check has a finite `wait-minutes`
budget. Equal Git trees never substitute for commit identity.

```yaml
- uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/qualify@<commit>
  id: checked
  with:
    commit: ${{ inputs.source-commit }}
    check-workflow: ci.yml
    check-branch: dev
- uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/checked-artifacts@<commit>
  with:
    receipt: ${{ steps.checked.outputs.receipt }}
    artifacts: build
```

Source deployments need only the first action. It outputs `run-id`, `run-attempt`, `commit` and a
structured `receipt`. The optional transfer action rechecks that receipt before and after copying,
requires fresh artifacts from that attempt with their recorded digests, and publishes a new
directory only after every file verifies. Its `directory` is a new direct child of `RUNNER_TEMP`;
`manifest` records the source, artifact identities and file digests. Expired, missing, repeated,
foreign or stale artifacts refuse transfer. ZIP entries must be bounded regular top-level files.

Both actions accept an explicit `api-url` for metadata. The transfer action and release interface
also accept `artifact-api-url`, serving `/repos/<owner>/<repo>/actions/artifacts/<id>/zip`, with its
own optional `artifact-token`. A declared transport does not fall back to another source. Metadata
credentials stay at their API origin, and storage redirects receive no credentials. Signed storage
URLs and transport exception details never enter diagnostics. Release publication uses the same
qualification and transfer code.

## Container images

`.github/workflows/image.yml` builds a project's image once. A pull request
builds it to prove the Dockerfile and pushes nothing; `dev`, `main` and runs by hand push it to
GitHub's container registry as `ghcr.io/<owner>/<image>:sha-<commit>`, with BuildKit's provenance
and SBOM attestations, and output `reference` gives it by digest. The build runs natively on the
runner's platform (`ubuntu-24.04` for linux/amd64, `ubuntu-24.04-arm` for linux/arm64) with the
pinned Buildx 0.38.2 and BuildKit 0.34.2 pinned by digest; GitHub's runners keep layers in the
Actions cache, written only outside pull requests.

```yaml
  image:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/image.yml@<commit> # v<version>
    permissions:
      contents: read
      packages: write
    with:
      image: platform-backend
      dockerfile: docker/backend/Dockerfile
```

When `main` moves forward, `.github/workflows/image-tag.yml` gives the image that this exact
commit's check pushed the release's version tag, without building again; a version tag that
already names another digest stops it. The release then scans its images with `security.yml`
and `images` for every release.
## Build provenance

A public repository attests what its build jobs produce with `.github/workflows/provenance.yml`,
called after the job that uploaded the artifact in the same run, outside pull requests:

```yaml
  provenance:
    needs: native
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/provenance.yml@<commit> # v<version>
    permissions:
      actions: read
      attestations: write
      artifact-metadata: write
      id-token: write
    with:
      artifact-name: package-ubuntu-24.04
```

Anyone then verifies a file with `gh attestation verify <file> --repo <owner>/<repository>`, which
names the source commit and workflow run that built it. GitHub records attestations of private
repositories only on Enterprise Cloud, so a private repository relies on its immutable release's
attestation. Only callers that attest grant these permissions; `check.yml` callers are unaffected.
A release's container images get their release-time scan by calling `security.yml` with `images`
on the promotion to `main` for every release.
## Package registries

`.github/workflows/registry.yml` publishes files of an immutable release to crates.io, PyPI or npm
through trusted publishing: the job exchanges its identity for a short-lived registry token, so
no registry token is stored. It downloads the named release files, requires their `SHA256SUMS`
entries and GitHub's release attestation (`gh release verify-asset`), and publishes those exact
bytes. A rerun skips a version the registry already holds with the same bytes and stops on
different ones.

- `crates`: one `.crate` file. The tagged source in `crate-directory` must reproduce it with
  `cargo package --locked`, byte for byte, before `cargo publish`.
- `pypi`: the wheels and source distribution; `environment` names the environment of the PyPI
  trusted publisher.
- `npm`: one package `.tgz` whose version is the release's, with npm provenance.

```yaml
jobs:
  release:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/release.yml@<commit> # v<version>
    permissions:
      actions: read
      contents: write
    with:
      artifacts: |
        python-dist
  pypi:
    needs: release
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/registry.yml@<commit> # v<version>
    permissions:
      contents: read
      id-token: write
    with:
      tag: ${{ needs.release.outputs.tag }}
      registry: pypi
      environment: pypi
      files: |
        example-1.2.3-py3-none-any.whl
        example-1.2.3.tar.gz
```

Register the repository, workflow file of the caller and environment as the registry's trusted
publisher first. Registries accept trusted publishing from GitHub's runners, so this job runs
there for private repositories too.

## Daily security

`security.yml` is the daily security scan, called from a schedule in each repository with
`contents: read` and `issues: write`:

```yaml
jobs:
  security:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/security.yml@<commit>
    permissions:
      contents: read
      issues: write
    with:
      images: |            # optional: the container images the project releases
        ghcr.io/<owner>/<image>:<tag>
```

Private images are read by the caller, which alone has the credentials: a job before it makes
their SBOMs with Syft, uploads them as one artifact (`<name>.json`, CycloneDX, and `<name>.name`
holding the image) and passes its name as `sboms`; they are scanned with the rest.

- TruffleHog and Kingfisher look for live secrets in the whole history: only secrets their makers'
  services accept count.
- OSV-Scanner checks every lock file against its offline database. A second, online run asks
  deps.dev, the one source of a lock file's licences, and lists the dependencies outside the
  licence policy; packages deps.dev knows no licence for are counted. The policy is the `[licenses]
  allow` list of the caller's `license-policy` file, such as the `deny.toml` cargo-deny reads, so
  both read one list; a named policy that is missing, malformed or empty fails the run. Without
  one, the scan uses the default embedded-dependency allowlist: MIT, Apache-2.0, BSD-2-Clause,
  BSD-3-Clause, ISC, Zlib, Unicode-3.0 and CC0-1.0.
  Both reports use the shared policy outside the checkout: local OSV package overrides and
  ignore files cannot hide their findings. Scans do not resolve or execute package code;
  malformed input fails the run instead of publishing a clean report.
- Syft makes an SBOM of the repository and of each image; Trivy and Grype check it. Their shared
  policy overrides local scanner configuration and Trivy ignore files. Explicit caller SBOMs
  must exist and contain JSON inventories; missing, empty or malformed inputs fail the run.
- The scanners run natively on Linux x64 or ARM64, each archive with its own pinned digest; any
  other system stops before preparation. A public repository may choose its GitHub-hosted runner
  in `hosted-runner`, as in `check.yml`.
- One open issue, "Security report", holds the latest run's findings. A finding never fails the
  run; a scanner that cannot run does. No scanner reports to its maker or checks for updates.

## Managed Renovate

A caller schedules `.github/workflows/renovate.yml` once a day and passes its exact managed
`renovate-version`, explicit repositories and App client ID. It runs only for schedule or manual
events, on the selected managed runner. The runner supplies Renovate and its package-manager
prerequisites; the library verifies the version and installs no replacement SDK.

```yaml
on:
  schedule:
    - cron: '17 2 * * *'
  workflow_dispatch:
permissions: {}
jobs:
  renovate:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/renovate.yml@<commit>
    with:
      renovate-version: ${{ vars.CI_RENOVATE_VERSION }}
      repositories: ${{ github.repository }}
      app-client-id: ${{ vars.RENOVATE_APP_CLIENT_ID }}
    secrets:
      app-private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}
```

The App must be installed on the explicit repositories in the caller's organization. The token
requests contents, pull-request and issue write access, plus checks and statuses read access.
The signing key reaches only the token action. Renovate receives a short-lived installation token
in its environment, and the token action revokes it after the job. The whole-job timeout must be
below the token's one-hour lifetime. Repository configuration owns release age, grouping, update
rules and the target branch; the workflow does not enable automerge.

`dockerhub-username` and the optional `dockerhub-token` secret enable Docker Hub reads. Credentials
stay in memory, outside command arguments and written global configuration. `dry-run: true`
performs the lookups without publishing updates. Every run uses a private temporary workspace;
cleanup removes its clones and local credential configuration on success, failure and normal
cancellation. Forced runner termination relies on slot cleanup and token expiration. Repository
scripts, plugins, post-upgrade commands and inherited environment overrides remain disabled.

## Developing the library

```sh
just setup    # prepare the pinned analysis tools explicitly
just check    # offline format, syntax, actionlint and zizmor checks
just verify   # everything the full check runs
```

Bootstrap tools are fetched through the official GitHub REST release API, resolving the tag and
exact asset name of their source URL. Every archive must match its pinned SHA-256 before
execution. Workflow steps use their contents-read token for API rate limits; a local check may
read public assets without a token. A source with restricted token access declares public
access explicitly (Trivy); failures never switch identities. Package/compiler caching belongs to the runner SDK and
network-cache contract. Tool bootstrap has one source and fails if it cannot fetch or verify it.

## Credit

NDDev CI is licensed under [Apache 2.0](LICENSE). When you use or adapt it, please name NDDev and
link this repository.
