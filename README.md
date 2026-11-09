# NDDev CI

The shared CI library of NDDev projects. A project calls one reusable workflow, pinned by commit,
and it runs the same `just` commands an agent runs.

## Use

Copy [examples/ci.yml](examples/ci.yml) to `.github/workflows/ci.yml` and pin a commit of this
repository.

| Event | Runs |
| --- | --- |
| Pull request | `just check`, then `just test` when the repository declares it |
| Push to `dev`, or a run by hand | `just verify` |

- Public repositories always run on GitHub's runners. Private ones run on our runners, the label
  in the `runner` input, unless the pull request carries the label `runner:blacksmith`
  (Blacksmith's 2-vCPU runners, within their free minutes) or `runner:github` (GitHub's runners),
  or a run by hand chooses `blacksmith` or `github` in its `runner` input. Adding such a label
  reruns the check there; other labels do not. Nothing moves a waiting job on its own.
- On our runners, Rust builds compile through sccache into the contour's R2 cache, by way of the
  cache gateway of the machine named in `/etc/contour/caches/environment.toml`. Jobs of `dev` and
  `main` read and write; every other job only reads, so a pull request never writes what a
  release build reads. This separates honest builds, not hostile ones, as jobs share an account.
- Every job builds with the machine's one Cargo home, `NDDEV_CARGO_DOWNLOAD_CACHE`: Rust cache keys
  hold the paths of the dependency sources, so dependencies compiled in one job match in every other.
- The check step reports how many compilations came from the cache.
- When the runner supplies `NDS_CACHE_BASE`, tool bootstrap uses its SHA-256-addressed GitHub
  release and PyPI routes. Checksums still verify every archive and wheel. An unavailable declared
  registry fails bootstrap; environments without one use upstream REST and PyPI directly.
- A repository may omit recipes that have no work, as the command standard allows.
  The short check reads the parsed justfile before deciding whether to run `test`,
  aliases included. A failed check, a failed declared test or an invalid justfile
  remains a failure. The full check always runs `just verify`.
- `setup: true` runs `just setup` before the checks. A project whose `just check` works without
  network access, as checks.md asks, takes its dependencies and data there first.
- `fetch-depth` (default 1; 0 is the whole history) and `filter` (such as `blob:none`) go to the
  checkout, for checks that read history, such as a version rule that compares a pull request with
  its base.
- The optional secret `read-keys` lets the check read other private repositories, such as a
  superproject's modules: for each repository a line `owner/repository`, then its read-only deploy
  key. GitHub accepts a deploy key for its one repository only, so each repository gets an ssh host
  alias with only its key, over GitHub's port 443, and git rewrites the repository's `git@`,
  `ssh://` and `https://` addresses to it. `git submodule update --init` and `git clone` then work
  in the project's recipes. The keys stay in the job's temporary folder, and the merge stops never
  receive them.
- A project may name an `artifact`, such as a release binary, and an `artifact-name`. The full
  check keeps it with its run for 90 days, so a deployment takes the build of a checked commit.
- A pull request also runs the merge stops of security.md: Betterleaks over the change's commits,
  and actionlint, zizmor (high severity) and poutine (warnings and errors; its notes are only
  reported) over the workflows, and committed over the change's commit messages: a Conventional
  Commits subject in the imperative up to 72 characters, lines up to 100, no fixup or WIP commit,
  unless the repository has its own `committed.toml`. It checks only the commits the change brings:
  merge commits and commits another branch already holds are left out. Any of them stops the merge.

The same PR job compares tracked source lockfiles with OSV-Scanner. It binds the exact base,
head and proposed merge commits, reads Git blobs rather than the working tree and runs no package
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

## Hosted SDK preparation

`check.yml`, `recipe.yml` and `actions/hosted-sdk` prepare only the SDKs explicitly selected by the caller:
`node-version`, `python-version`, `uv-version`, `bun-version` and `rust-version`.
Each value is an exact stable version; an empty input leaves that SDK unchanged.
The Bun setup action receives the native asset's official API redirect for the selected stable
tag. Its published source identity is recorded, its installed version is still measured and the
transient signed transport URL is masked. It never selects another provider or architecture
when the native asset cannot be resolved.
`rust-components` and `rust-targets` accept comma-separated names alongside a Rust selection.
The workflows use the same action and pinned upstream setup actions, then measure the actual executables before `just setup` or the selected preparation recipe.
A missing or different version fails before project preparation. Its `receipt` output
records the measured versions and native OS/architecture. It runs only on GitHub-hosted
runners; managed private environments retain their own SDK provider.

```yaml
- uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/hosted-sdk@<commit>
  with:
    node-version: ${{ vars.CI_NODE_VERSION }}
    bun-version: ${{ vars.CI_BUN_VERSION }}
    rust-version: ${{ vars.CI_RUST_VERSION }}
    rust-components: clippy,rustfmt
```

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
It accepts an explicit hosted `runner`, `recipe`, JSON `arguments`, optional
dependency `prepare` recipe and checkout depth. Optional exact `node-version`,
`python-version` and `uv-version` inputs prepare hosted SDKs before either recipe.
Public callers select from the documented hosted platforms; private callers use
their `private-runner` label and retain its prepared toolchain and cache placement.
Specialized jobs keep services, signing, packaging and acceptance in their owning
workflow and use the recipe action for individual commands.

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

`add-to-path: true` exposes the directory only after every declared file has passed;
it requires at least one explicitly executable file. The `receipt` output records verified
archive and file identities. This supports independently qualified native tools without
putting their versions or provider choices in this library. A file's digest does not replace
its provider, licence or consumer qualification.

The diff secret scan uses Betterleaks' built-in detection rules. Repository-local scanner
configuration is not loaded automatically. The newer scanner isolates local Git configuration;
this workflow does not opt out of that boundary.

## Releases

`actions/release` publishes the commit `main` moved forward to as one immutable GitHub Release,
without building again. It takes the newest push check of that exact commit on `dev` from the
caller's check workflow: a newer failed, cancelled or unknown run is never replaced by an older
green one, a running check is awaited up to `wait-minutes`, and a missing one stops the release.
A commit with the same tree but another identity never borrows a result.

The named `artifacts` of that run are downloaded with their recorded digests, and their top-level
files become the release files, with `SHA256SUMS`. Folders, links and hidden or repeated names
stop the release. The version raises the last number of the newest `<tag-prefix><version>` tag;
the owner chooses a new first or middle number through `version`. The tag is created at the
commit, never moved, and a draft receives and verifies every file before it is published.
A rerun finds the same tag and release and completes them once. The job needs `contents: write`
and `actions: read`; enable immutable releases in the repository settings.

```yaml
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-24.04
    permissions:
      actions: read
      contents: write
    steps:
      - uses: NDDev-Technocracy-OpenNetwork/nddev-ci/actions/release@<commit>
        with:
          check-workflow: ci.yml
          artifacts: |
            build
```

This library releases itself the same way (`.github/workflows/publish.yml`). Callers pin a
released commit with its version as a comment, so Dependabot proposes each new release.

## Daily security

`security.yml` is the daily run of security.md, called from a schedule in each repository with
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
  deps.dev, the one source of a lock file's licences, and lists the dependencies outside
  licenses.md's list; packages deps.dev knows no licence for are counted.
  Both reports use the shared policy outside the checkout: local OSV package overrides and
  ignore files cannot hide their findings. Scans do not resolve or execute package code;
  malformed input fails the run instead of publishing a clean report.
- Syft makes an SBOM of the repository and of each image; Trivy and Grype check it. Their shared
  policy overrides local scanner configuration and Trivy ignore files. Explicit caller SBOMs
  must exist and contain JSON inventories; missing, empty or malformed inputs fail the run.
- One open issue, "Security report", holds the latest run's findings. A finding never fails the
  run; a scanner that cannot run does. No scanner reports to its maker or checks for updates.

## Check

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
