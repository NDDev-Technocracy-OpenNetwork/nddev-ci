# NDDev CI

Reusable checks, builds and publication through a project's own `just` commands.
Projects own their checks and artifacts; this library prepares the execution tools,
runs those commands and enforces the merge and release boundaries.

Copy a caller from [examples](examples) and replace `RELEASE_COMMIT` and `RELEASE_VERSION`
with the commit SHA and tag of the [latest release](https://github.com/NDDev-Technocracy-OpenNetwork/nddev-ci/releases/latest).
Let Renovate or Dependabot update the pin. Each workflow and action declaration documents its inputs.

## Entry points

| Workflow | Purpose |
| --- | --- |
| [check.yml](.github/workflows/check.yml) | Project checks and merge stops |
| [merge-stops.yml](.github/workflows/merge-stops.yml) | The same stops beside a project's existing jobs |
| [recipe.yml](.github/workflows/recipe.yml) | One project recipe in a native platform matrix |
| [image.yml](.github/workflows/image.yml) | Build a native container image and push it by source commit |
| [source-version.yml](.github/workflows/source-version.yml) | Require a trusted readiness status before full-build fan-out |
| [promote.yml](.github/workflows/promote.yml) | Move `main` forward to the newest `dev` commit whose full check passed, then start the release |
| [merge-on-green.yml](.github/workflows/merge-on-green.yml) | Merge a labelled pull request once every check of its head passed, where branch rules are unavailable |
| [release.yml](.github/workflows/release.yml) | Publish the exact verified commit and its files as an immutable GitHub Release |
| [image-tag.yml](.github/workflows/image-tag.yml) | Give the checked image digest its release tag without rebuilding |
| [registry.yml](.github/workflows/registry.yml) | Publish released files to crates.io or PyPI through trusted publishing |
| [provenance.yml](.github/workflows/provenance.yml) | Attest artifacts of a public repository's build |
| [security.yml](.github/workflows/security.yml) | Daily secrets, dependency, licence, SBOM and image scans |

## Prepared source

A caller that prepares version metadata before its full build calls `source-version.yml`
once and makes its full-build jobs depend on it. Ordinary pull requests retain their short
checks. Other events require `success` on the exact commit for the configured status
`context` and immutable numeric `creator-id`, within `maximum-statuses` records, including history.
Missing, pending, failed, foreign, malformed or incomplete status histories fail immediately.
The gate neither waits nor writes a status, changes source or authorizes a release. The trusted
producer owns preparation and must bind its output to that commit before writing readiness.

`actions/require-status` exposes the same read-only predicate for a custom frame. It returns
`state`, `sha` and `status-id` only after a complete bounded inventory passes. The library's
`source-version-smoke.yml` exercises real API statuses in its own isolated fixture context;
that context does not represent a project's readiness or a required project check.

## Building blocks

Every job of `check.yml` and `recipe.yml` is the same frame around the project's command:

1. [prepare](actions/prepare/action.yml): report path checks, checkout, outside telemetry off,
   the artifact registry, private reads, the task runner, SDKs, native tool assets, caches and
   in-job image builds.
2. The project's own `just` command.
3. [complete](actions/complete/action.yml), whatever the result: the deployment artifact, reports
   and the check that each was left, failure diagnostics, the read-token revocation and the job
   record.

A project job that cannot use an entry point yet takes the same two actions, so it is prepared
and recorded like the rest. `complete` takes the job's status and the outcome of the project's
own steps, and records a later failure of its own artifact or reports as the job's.

## Project checks

| Event | Commands |
| --- | --- |
| Pull request | `just check`, then `just test` if declared, including aliases |
| Push to `dev`, or manual run | `just verify` |

`setup: true` runs `just setup` first. A missing optional test recipe is allowed;
a failed command or invalid justfile fails the job. New PR pushes cancel their
superseded checks. Each `dev` commit keeps its full check.

### The full check in parts

A full check runs the parts of `verify` as jobs of their own, side by side, and joins them into one
result named `full check`. The parts are the recipes `verify` depends on, read from
`just --dump --dump-format json` by a light first job: a project declares nothing beyond its
justfile, and `just verify` stays the one command an agent runs.

- A part that another part needs, directly or through its own dependencies, runs in that part's
  job, as `just image test-image`, so nothing runs twice and the declared order holds. A part that
  reads what another part leaves names that part as its dependency, as `just` itself requires of
  a recipe run alone.
- `verify` runs as one `full check` job when it has commands of its own, parameters, a recipe after
  `&&`, a computed, variadic or option-like argument, fewer than two independent parts, or when
  the caller names `reports`, which the job running `verify` must leave.
- Every part takes the same inputs, setup, runner choice, SDKs and caches. One run of each part runs
  on a branch at a time; a newer push's waiting part replaces an older waiting one.
- The deployment `artifact` is kept by the part whose recipes left it; the joined result fails
  unless exactly one part did. Diagnostics are kept per part. Promotion reads the run as before.

Use `check.yml` for this standard path. A project with existing command jobs calls
`merge-stops.yml` beside them. Use `recipe.yml` for a native matrix, with a declared
recipe, optional preparation recipe and literal arguments as a JSON string array.
Each matrix platform gives its artifact a distinct name. Workflow artifacts that carry a
checked build to release or deployment are kept for three days by default. Use
`artifact-days` for a deployment that needs a longer handoff. GitHub also applies the
repository's retention limit.

Use `retain-runs: true` when a project requires a verdict for every run. This gives
`check.yml` and its merge stops a separate concurrency group for each run. A project
with native command jobs passes it directly to `merge-stops.yml` and owns concurrency
for its own jobs.

Subscribe the caller's pull request trigger to opened, synchronize, reopened, labeled and edited
events, as in the example. Editing a title or description must rerun its metadata checks. The
short check does not run again for such an event: after it passes, it keeps a mark of the merge
commit and runner it checked in GitHub's cache. An `edited` event or an unrelated label can reuse
a pass of the same merge on the same runner platform and provider. A new merge commit or a label
that selects the job's hosted route runs the check in full.
The authorship stop rejects generated assistant signatures and machine coauthor trailers in
the introduced commits, including merge commits, and in the title/description. Bot requests
receive the same check. Human coauthors, cryptographic signatures, tool-version discussion and
quoted examples remain valid. It reads Git objects and event data without executing project code
or requesting another permission.

The PR merge stops scan secrets in the changed commits, dangerous workflows and newly
introduced fixed critical dependency vulnerabilities. Commit messages and the pull request's
text are checked as warnings that never stop a merge, and so are the tracked lines that build
against what a managed runner gives a job ([build-conventions](actions/build-conventions/action.yml)):
- setting `GRADLE_USER_HOME`, which replaces the runner's persistent Gradle home; Gradle's settings
  go in `GRADLE_OPTS` as `-Dorg.gradle.*`, and a proxy as `-Dhttps.proxyHost` and
  `-Dhttps.proxyPort`, since the JVM ignores `HTTPS_PROXY`;
- an image build without `$NDDEV_CI_IMAGE_BUILD_FLAGS`, whose `RUN` steps take the builder's default
  network past the package mirror, where a package manager can stall for minutes; set
  `images: true` and build with the flags, as the in-job image builds below say;
- an exported local layer cache, which costs its export on every run while the library's builder
  shares layers between jobs on the machine.
Dependency comparison reads the exact proposed merge and its own base from Git,
runs no project installers, and scans both against the same vulnerability data.
Existing findings remain diagnostics. Native source packages without a registry version stay
counted and appear explicitly in the receipt; matched advisories are checked normally.
Missing or malformed metadata and unavailable scanners still fail.
The stops fetch complete history for authorship and the exact blob contents needed for the change.
Use `sparse-merge-stops: true` with `check.yml`, or `sparse-checkout: true` directly with
`merge-stops.yml`, to keep only `.github` and the root merge-stop policy files in its worktree.
Use this for repositories with retained payloads when their local action metadata lives in
`.github`. The project check's own sparse checkout is configured independently.
The message rules leave out a commit whose author is exactly Dependabot: it writes one long line
for a grouped update and offers no setting for it. A repository's own `committed.toml` replaces
the default rules whole.

The release's `scan-before-push.zip` contains a local Git pre-push entry point. Install
`nddev-ci/tools/scan-before-push.mjs` with its adjacent library files and pass Git's remote name,
destination and ref updates to it. It uses Node 24, Python 3.11 or later and Betterleaks 1.10.1.
Existing ref updates exclude their advertised old commits. New refs use the remote's default
branch as their base. Both the local hook and the PR stop scan commit patches, including merge
commits, and load the scanner policy from the published base.

For a reviewed, deliberately synthetic fixture that has to be checked in, add one
`[[allowlists]]` entry to the base branch's `.betterleaks.toml`. Set `condition = "AND"`, match
the exact fixture path in `paths` and match the exact fake value in `regexes`. Anchor both
patterns with `^` and `$` and escape any regular expression metacharacters. Merge the
policy change first so that both scans can read it from the base. Prefer generating
fixture credentials at test runtime when their literal value has no purpose.

Daily security findings go to the run summary and the `security-report-<attempt>` artifact,
retained for 14 days. The artifact contains `security-report.json` with `schema_version: 1`,
the run URL and every finding's scanner, kind, identifier, package/ecosystem, installed version,
target, severity (null when unavailable) and `fixed_versions` (empty when none are reported).
OSV rows also retain their matching affected ranges and severity scores; reported fixes are
upstream range data, not a qualified upgrade recommendation. Secret rows contain verification
and source-location metadata, never the matched value. The bounded summary may omit rows that
remain in JSON and the full run log. The workflow opens, edits and closes no issue; existing
findings remain report-only and scanner execution errors still fail the run.

The first attempt of a fixed daily UTC security schedule reports the nominal cron slot and
how late the security job started. The runner's measured queue time is shown separately when
available. To see GitHub's run creation delay and the time from creation to the first job, run
`just security-schedule owner/repository '17 3 * * *'` with an authenticated `gh`. An optional date
and workflow filename select a past slot or a caller whose workflow file has a different name.
Until a scheduled run appears in GitHub, the command reports that it may still be delayed.

The default licence list is declared in `security.yml`; a caller's `license-policy`
can supply its own `[licenses].allow`. OSV accepts identifiers, so a `WITH` entry
requires its base to be independently allowed too; exception-only policies fail. Unchanged
MPL/EPL dependencies retain their notice and source obligations; modified files need
review and corresponding source publication. LGPL stays outside the default: an
explicit policy for unchanged dynamic use must preserve replaceability, licence and
source information. Static linking or modifications need review. The scanner does
not infer these use and distribution conditions.

Checkout inputs support projects that read history or omit generated trees; `submodules` checks
out public submodules at their recorded commits for a superproject's checks.
`diagnostics` keeps only named workspace reports on failure; release artifacts are
uploaded only after successful non-PR checks.
`reports` keeps named workspace reports whether the job passes or fails, pull requests included,
for 14 days and apart from release artifacts. Each named path must hold a file the job left: the
ones that exist are kept, and any missing one then fails the job, even when another matched. Both
lists refuse absolute, parent and hidden paths, so a project that writes reports to a hidden folder
copies them to a visible one.

`repository-token: true` gives the project's commands the job's own token as `GITHUB_TOKEN`, for
checks of the project's own private repository, such as a link check of its README. The token
reads only that repository's contents; GitHub masks it in logs, and the project keeps it out of
its reports.

### Protected registry input

Both `check.yml` and `recipe.yml` accept `registry-commit` when a recipe verifies
its lock against a protected registry snapshot. Use `select-registry-input.yml` to
read the commit from the tracked lock and pass it to both checks. The trusted publisher prepares the repository's
`registry-input-<commit>` environment before that source enters CI. It places the
gzip-compressed, base64-encoded schema-1 snapshot in the environment secrets
`REGISTRY_SNAPSHOT_FIRST` through `REGISTRY_SNAPSHOT_FOURTH` and records its
uncompressed SHA-256 in the environment variable `REGISTRY_SNAPSHOT_SHA256`.

Map all four `REGISTRY_SNAPSHOT_*` names in the caller job's `secrets` section.
The called job loads the values from its selected protected environment.

The job verifies the digest and commit and exports the private regular file as
`NDDEV_CI_REGISTRY_SNAPSHOT`. The project uses that file to verify the selected
versions before installation. The input action removes the file after the job.

For a pull request or a push to `dev`, `check.yml` runs a separate, managed Linux x64
technology registry job when a protected registry commit is selected. This input is for
private repositories and pull requests from branches in the same repository. The snapshot supplies the
CLI settings and the numeric repository, release and asset IDs with the archive's SHA-256.
The job downloads from the runner's gateway, verifies the compressed bytes, then reads the
checked source and its exact comparison commit. New unregistered choices and declarations outside
the accepted lines fail a pull request. Existing findings and findings on a `dev` push are
reported. An invalid snapshot, failed download or failed scan fails the check. The registry job
uses the managed runner even when the other jobs move to a GitHub-hosted runner.

### Gradle on a managed runner

After checkout, call `actions/gradle-mirror` before a job invokes its Gradle Wrapper.
Set `working-directory` to the directory that contains the wrapper, such as `android`
for a mobile build. The action keeps the runner's Gradle home and temporarily points
official wrapper distributions at the declared artifact registry. Put the publisher's
`distributionSha256Sum` in the checked-in wrapper properties. The wrapper still validates
the downloaded bytes, and the action restores the original properties after the job.

The action routes the supported public Maven Central, Google Maven, Gradle Plugin Portal
and Huawei repository URLs for dependency and plugin resolution. Existing repository
objects keep their position, content rules and credentials. Authenticated and custom
repositories use their own source. For settings plugins, declare the repositories in
`pluginManagement` before the plugins block. The hosted-runner path uses Gradle's ordinary
sources.

## Runners and SDKs

Public projects use the selected GitHub-hosted runner. Private projects use `runner`:

| Managed class | Project commands | Image builds | Merge stops, image tags, daily scans |
| --- | --- | --- | --- |
| `nddev-linux-standart` | Linux x64 | Same class | `nddev-linux-small` |
| `nddev-linux-small` | Linux x64 | Same class | Same class |
| `nddev-linux-arm64` | Linux ARM64 | Same class | Same class |
| `nddev-macos` | Native macOS ARM64 | `nddev-linux-arm64` | `nddev-linux-arm64` |

The jobs of the last column are light by their nature, so they leave the standard class to a
project's own builds and tests.

The shared check workflow routes private Linux x64 PRs authored and triggered
by a bot to the matching `nddev-linux-small-maintenance` or `nddev-linux-standart-maintenance` label.
The runner service registers those labels against the same hardware and class.
A person's run or rerun, a branch check and a release use the ordinary managed
label. Explicit hosted selections keep their existing route.

Configure `runner-profile` for each private `check.yml` or `recipe.yml` call that supports
automatic fallback. The caller listens for PR `labeled` events and declares the optional string
`runner-profile` alongside its `runner` choice in `workflow_dispatch`. A scheduler restarts the
run using `runner:github:<profile>` on a PR or `runner=github` plus `runner-profile=<profile>`
on a branch. Only matching jobs use a GitHub-hosted runner in the replacement run. Other jobs
continue to target their managed labels. Lightweight Linux jobs use the profile of their own
runner class.

The supported profiles are Linux x64, Linux ARM64, macOS ARM64 and Windows x64. Each
selects a standard GitHub-hosted image of the same platform.

For branch release checks, set the caller's run name to `Contour hosted fallback` when the
dispatch selects both `runner=github` and a nonempty `runner-profile`, as in the example.
The `NDDEV_BRANCH_FALLBACK_ACTOR_ID` configuration variable holds the scheduler App's numeric
bot user ID. A push or a dispatch with that run name and both matching actor IDs qualifies the
same exact repository, workflow, branch and commit. Promotion and release check the newest
eligible run and revalidate its attempt before consuming the artifact receipt.

The unqualified PR label `runner:github` and a manual `runner: github` without a profile move the
whole check and its portable jobs. For a call without a profile, the manual selection keeps its
legacy hosted label. Public calls always use GitHub-hosted runners. A public recipe can use
`runner-profile` to select a standard image or set `hosted-runner` explicitly.

[hosted-sdk](actions/hosted-sdk/action.yml) prepares only selected exact Node, Python,
uv, Bun, Rust, Temurin Java, Go, standalone Dart or stable Flutter versions and selected
`name@version` command-line tools. Managed runners verify those selections against
their prepared SDK, without sudo or global installation. A managed SDK keeps every Python
line in uv's `UV_PYTHON_INSTALL_DIR`; the selected line goes first on `PATH` and becomes
`UV_PYTHON`. Without it, the `python` on `PATH` must have that version. External runners bootstrap
them through the pinned upstream actions. Preparation uses the embedded action
runtime, so it requires no preinstalled Node SDK.

Linux and Windows ARM64 reject Flutter; Windows ARM64 rejects Temurin Java.
For standalone Dart, use `dart-version`. On hosted runners the stable archive is verified against
its official SHA-256 before use. Managed runners verify their installed Dart executable.
Native tools such as FFmpeg require a separately qualified provider and the project's
complete acceptance tests. A language SDK or Python wrapper supplies neither.
[release-assets](actions/release-assets/action.yml) prepares explicitly declared
public archive members, checking archive and executable digests before adding PATH.
Member paths keep their exact archive spelling, including one leading `./`; the remaining
components must be nonempty and contain no `.` or `..`. Managed runners retain their SDK instead.

Private source reads use either `read-keys` deploy keys or a scoped GitHub App,
never both. The App grants contents-read access only to the explicit same-organization
repositories. Keys stay in the job's private temporary directory and are removed by completion on success,
failure or cancellation; App tokens are revoked in cleanup. The key profile preserves one identity
per repository and GitHub's pinned host keys. Connections and SSH negotiation have a 15-second
bound; encrypted keepalives detect a dead peer after three unanswered 15-second probes. A declared
`HTTPS_PROXY` (or `https_proxy`) uses a binary-safe HTTP CONNECT tunnel, with `NO_PROXY`/`no_proxy`
matching hosts or domains and optional ports. HTTP and HTTPS proxy URLs are supported. The
execution provider owns the route; the library contains no private endpoint. Proxy commands get
a command shell even when the isolated account's login shell is disabled. Merge stops receive neither credential. [check.yml](.github/workflows/check.yml) and
[recipe.yml](.github/workflows/recipe.yml) take the same inputs and optional secrets and run the
same steps, so one job can read a superproject's modules and also build and test its images with
`images: true` and keep `reports`.

## GitHub's free runners

Public projects run on GitHub's standard runners, which are free for public repositories without
a minute quota: Linux x64 and arm64, Windows and macOS. Larger runners are billed in public
repositories too, so the library never selects one. A private repository on the free plan gets $12
of hosted compute a month (2,000 Linux minutes; a Windows minute costs about 1.7 of them and a
macOS minute about 10), so private projects run on managed runners instead.

A public run is bound by the plan's limits, not by minutes. On the free plan for organizations
([limits](https://docs.github.com/en/actions/reference/limits),
[caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
[billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), checked
13 November 2026):

| Limit | Value |
| --- | --- |
| Concurrent jobs on standard runners, per account | 20 |
| Of them on macOS | 5 |
| Time of one job | 6 hours |
| Jobs of one matrix | 256 |
| Actions cache, per repository | 10 GB; entries unused for 7 days are deleted, and above the limit the least recently used ones are evicted |
| Cache uploads, per repository | 200 a minute |
| Artifact storage of private repositories | 500 MB |

What the library does, and what a project's workflows follow:

- **Caches.** Only pushes to `dev` and `main` and scheduled runs write caches; a pull request reads
  them. A cache written by a pull request belongs to its merge ref, only that pull request's
  reruns can restore it, and it evicts the shared ones. [hosted-cache](actions/hosted-cache/action.yml)
  applies this. A BuildKit `type=gha` cache follows the same rule: written only by a push to the
  integration branch, in `mode=min` (the image's own layers), one scope per architecture.
- **Cache budget.** A repository keeps its cache well under 10 GB (`gh cache list`). Once it is
  over, the least recently used entries leave first, and an artifact that takes minutes to rebuild,
  such as a compiled historical binary, is lost with them.
- **macOS.** A run plans its macOS jobs within five. Platform-independent work runs on Linux, a
  macOS leg runs in the full check rather than on every pull request, and a suite whose shards each
  pay a fixed setup cost runs as one shard on macOS.
- **Jobs.** Every job takes one of the 20 slots. Short jobs of one platform are merged, and a run of
  more jobs than slots queues behind itself.
- **Concurrency.** A pull request's run cancels its superseded runs. The full check of `dev`
  queues instead (`cancel-in-progress: false`), so at most one run waits behind the running one.
- **Telemetry.** [telemetry](actions/telemetry/action.yml) turns outside telemetry off; a workflow
  that does not use it sets the same switches as its environment.

## Caches

Managed execution preserves runner-owned package stores, `CARGO_HOME`, `RUSTC_WRAPPER`
and compiler-cache settings. The library reads no host settings file and installs
no second compiler-cache client.

External runners restore the dependency caches selected by the project's lockfiles.
Only successful `dev` and `main` jobs save them. Workspace crate outputs are excluded.
Exact SDK caches include the runner image and architecture; macOS Python is prepared
fresh because its framework is outside the tool cache.

The optional `artifact-registry` input, or `NDDEV_CI_ARTIFACT_REGISTRY` from the runner,
selects the tool-download source. Empty uses official upstream sources; a declared
unavailable source fails. Checksums remain mandatory. Its routes are:

- `/github-releases/sha256/<digest>/<owner>/<repository>/releases/download/<tag>/<asset>`
- `/pypi/simple/<project>/` and `/pypi-files/`
- `/osv/<UTC date>/<ecosystem>/all.zip`, the OSV vulnerability database of an ecosystem as the
  source's copy of that day
- `/grype/<UTC date>/v6/latest.json` and the archive it names, Grype's vulnerability database
  as the source's copy of that day
- `/v2/ghcr.io/aquasecurity/trivy-db` and `trivy-java-db`, Trivy's databases through the source's
  container registry route

With a declared source the dependency comparison of the merge stops and the daily dependency
scan take their vulnerability databases from the last route and never from the scanner's own
download: each first lets the scanner list the packages, then fetches the database of each
ecosystem they name. The data is at most a day old. Without a declared source the scanner
downloads the current databases itself. The daily licence report still asks its public source.

The daily package scan gives Grype and Trivy the declared source as well: Grype's database as
the source's copy of the day, `/grype/<UTC date>/v6/`, and Trivy's databases through the
source's route to their container registry, `/v2/ghcr.io/aquasecurity/`. Every repository's
scan of a day then reads one copy.

`image.yml` gives a build the same mirror, and takes its pinned Buildx binary through the first
route there. On a managed runner with that variable the build
runs on the host network, because a `RUN` step cannot reach the runner's loopback otherwise,
and the workflow passes the mirror under each package manager's own variable name:
`CARGO_SOURCE_CRATES_IO_REPLACE_WITH` with `CARGO_SOURCE_MIRROR_REGISTRY`,
`RUSTUP_DIST_SERVER`, `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL` with `PIP_TRUSTED_HOST`,
`UV_DEFAULT_INDEX`, `GOPROXY` and `PUB_HOSTED_URL`. The builder takes its base images from
the mirror's `/v2/<registry>` routes for Docker Hub, GHCR, GCR and cgr.dev, since it does not
read the Docker daemon's mirrors. A Dockerfile takes the variables it needs by
declaring them as arguments without a value, such as `ARG NPM_CONFIG_REGISTRY`. On a
GitHub-hosted runner they stay empty and each tool uses its public source, so the Dockerfile
names no runner and no address. apt needs no argument: the workflow passes the mirror as the
predefined `http_proxy`, and the mirror serves the Debian and Ubuntu archives in that form.
Any other plain-HTTP address in a `RUN` step is refused there, so such a download uses HTTPS.

`image.yml` prepares its builder with [image-builder](actions/image-builder/action.yml), which
also prepares it inside a job that builds images to test and scan them there, such as a native
recipe that builds several images, runs its own tests against them and keeps their SBOMs.
Managed jobs use the machine's Docker builder or its own BuildKit service. The runner supplies
`BUILDX_BUILDER`, a job-owned absolute `BUILDX_CONFIG` path and the Buildx CLI. The machine
owns registry mirrors, the host-network entitlement, storage and collection policy. Concurrent
jobs use the same builder cache. The image action creates no additional managed builder.
GitHub-hosted jobs provision their own builder and use public package sources.

The action exports `NDDEV_CI_IMAGE_BUILD_FLAGS`, the network and the mirror's build arguments,
so a recipe builds with `docker buildx build $NDDEV_CI_IMAGE_BUILD_FLAGS --load`. It also exports
the daily scanner database routes on managed runners. Set `images: true` on `check.yml` or
`recipe.yml` to make the builder available inside the project's recipe.

Project setup must support its execution environment. Hosted setup uses the explicit
SDK inputs and cannot require a private installer or private cache variable.

## Checked artifacts and publication

[qualify](actions/qualify/action.yml) selects the newest full check of an exact source
commit, repository, workflow, event and branch, with a finite pending budget. An older
green result cannot replace a newer failed or malformed one. Source deployments can
use its receipt without downloading artifacts.

[checked-artifacts](actions/checked-artifacts/action.yml) consumes that receipt and
rechecks it before and after transfer. Artifact ownership, attempt freshness,
expiration, size and digest must agree. Files are bounded regular top-level entries;
package directory trees into an archive first. API and artifact transports have
separate explicit inputs, and storage redirects receive no API credentials.

`release.yml` reuses this implementation: `main` releases the exact successful `dev`
commit, reuses its files, adds `SHA256SUMS`, and publishes a verified draft. Tags use
`v<major>.<minor>.<patch>` and never move. Reruns reconcile the same release.
Deployment stays with the caller.

For software with an embedded product version, pass `release-metadata` to both
`promote.yml` and `release.yml`. It lists the top-level JSON metadata file names
from the full-check artifacts, one per line; `artifacts` names the artifacts holding
them. Each document has `schema_version: 1`, `source_commit` equal to the checked
commit and a plain `version`, such as `1.2.3`. Additional platform or hash fields
are permitted. Every selected platform must agree. Missing, changed, malformed or
contradictory metadata stops promotion before moving `main`, and stops publication
before creating a tag or release. A version used by another commit is refused.
The checked product version is the release version; an explicit `version` must
agree with it. The project's version preparation updates its source before the
full build; these actions do not edit the product manifest.

A source release without an embedded product version can leave `release-metadata`
empty. Its tag is its version: an ordinary release raises the patch, `version`
selects a newer version, and `initial-version` sets the first release.

`registry.yml` verifies immutable release files before trusted publication. Crates
must reproduce the released package from tagged source. Public artifact attestations
use `provenance.yml`; private repositories use release verification.

## Job records

[job-record](actions/job-record/action.yml) ends each job with a summary and one
structured `nddev_ci.job.completed` line: source commit, workflow, result, actual
OS/architecture, duration and available compiler-cache counters. Missing measured
queue time remains unknown. A failed job names its `failure-layer`: `project` for its
own commands or named reports, `library` for the steps around them. The runner can
provide `NDDEV_CI_QUEUE_SECONDS` and `NDDEV_CI_TELEMETRY_FILE`; hosted jobs keep the
record in the job log. The execution controller owns the SDK, device and generation
provenance added at collection. [telemetry](actions/telemetry/action.yml) disables
outside telemetry in every job.

`just times owner/repository` measures how long a repository's checks make an agent wait, from
the newest 30 completed runs of each check (`--runs`, `--workflow ci.yml`, `--branch dev`). For the
short check of pull requests and the full check of the branch it prints the median, 90th
percentile and maximum of the answer, from the event to the job named `short check` or
`full check`, of the longest wait of one job for a runner and of the longest job. It reads the
API with `GH_TOKEN` or the authenticated `gh` identity.

## Promotion

[promote.yml](.github/workflows/promote.yml) moves `main` forward to the newest `dev` commit whose
newest full check on a push passed. The move is a push, so a release workflow that runs on a push to
`main` starts once for it. A newer
commit whose check failed or still runs waits for the next promotion. It never moves `main`
backward or sideways: when `main` holds a commit `dev` lacks, it stops.

Promotion retries transient GitHub API read failures up to three attempts within the request's
time limit. If the read still fails, the error names the last transport cause. The fast-forward
push runs separately.

GitHub's job token cannot move a branch onto commits that change workflow files, so the move
pushes with a deploy key that has write access. The caller keeps it as `PROMOTION_KEY` in an
environment, `promotion` by default, that only its `dev` branch may use, and calls the workflow
with `secrets: inherit`. The library promotes itself this way as the checks of a `dev` push pass.
For a private repository on GitHub Free, use the outside writer or the manual step below.

Promotion and publication accept optional `required-workflows`, one workflow file name per line.
Every additional workflow must qualify the same exact source/branch/event with its latest attempt,
and all receipts are checked again before writes. `check-workflow` remains the artifact source.
The library itself requires its portable floor and artifact-transfer smoke alongside `ci.yml`.

## Merge on green without branch rules

A private repository on GitHub's free plan has no branch rules, so GitHub's auto-merge cannot
wait for its checks. [merge-on-green.yml](.github/workflows/merge-on-green.yml) gives it the same
result: when the caller's check finishes, it takes the open pull request of this repository whose
head is that commit and which carries the label `merge-on-green`, and merges it into its base once
every check of that exact commit passed. It pushes the merge commit with the same `PROMOTION_KEY`
as promotion when the environment can supply it. The write credential must support changes to
workflow files and start the base branch's check. Label the pull request when it is opened.
Update bots can add the label themselves.

`required-checks` declares the mandatory check names, one per line. Its default is the standard
short check and its nested merge stops. A caller with other native jobs supplies its complete
mandatory set, including every required platform and the merge stops. Empty, duplicate or
self-excluded names fail. Each newest named result must succeed from the GitHub Actions
integration on the exact head; missing, pending, skipped, neutral or failed mandatory results
cannot merge. Earlier success cannot replace a newer unsuccessful result. Optional jobs may
still skip or finish neutral. Incomplete, changing or foreign check inventories fail.
Unrelated labels leave prior mandatory results intact and use a separate optional context for
ignored jobs. GitHub may display their name expressions unevaluated. The runner-selection label
still executes the real checks with their normal names; it does not take the ignored path.

```yaml
name: merge on green
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
permissions: {}
jobs:
  merge:
    uses: NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/merge-on-green.yml@<release commit>
    secrets: inherit # zizmor: ignore[secrets-inherit]
    permissions:
      checks: read
      contents: read
      pull-requests: read
      statuses: read
```

### Private repositories on GitHub Free

GitHub Free private repositories lack environment secrets, organization Actions secrets,
native auto-merge and branch rules. They still run checks and publish the checked release
after the target moves. Use a trusted service outside the repository's workflows to merge
labelled pull requests and move qualified releases. Keep its write credential on the service.
Use the repository's integration branch as the merge base, including `main` when it is the
default. The write must start the subsequent push workflows. Pushes made with the standard
`GITHUB_TOKEN` do not start them.

A service can call the same pull request qualifier from a trusted checkout of the pinned
library release or the release's `qualify-merge.zip`. The archive contains the command
and its runtime files under `nddev-ci/`. Its checksum is published in `SHA256SUMS`.
Run from the extracted directory with a repository-scoped read token as `GH_TOKEN`
and pass each required check as a separate argument.

```sh
node tools/qualify-merge.mjs owner/repository 42 "$head_sha" dev \
  'check / short check' 'check / merge-stops / merge stops'
```

The tool makes read-only API calls and prints one JSON receipt. A `ready` receipt binds
the repository, SHA, pull request number and base. The service must match that identity,
re-read the pull request before writing, guard against a changed head and verify the result.

If the trusted service is unavailable, the job summary for a qualified candidate names
the manual step:

| Step | What to do on GitHub Free | Where GitHub's controls are configured when available |
| --- | --- | --- |
| Merge on green | On the pull request page, verify the current head against the checked SHA and choose **Create a merge commit**. | **Settings → General → Pull Requests → Allow auto-merge** and required checks under **Settings → Rules → Rulesets** or **Settings → Branches**. Private organization repositories need Team or Enterprise. |
| Promote a release | From a clone with write access, fetch and push the checked SHA to the target branch without forcing. Use the exact command in the run summary. The push starts the release. | Keep the write key under **Settings → Environments → promotion → Environment secrets → PROMOTION_KEY** and its public key under **Settings → Deploy keys**. Private environment secrets and branch filters need Team or Enterprise. Private environment required reviewers and wait timers need Enterprise. |

Private repositories can use standard hosted Actions runners within the organization's
included compute. Self-hosted Actions usage is outside that compute allowance.
See GitHub's documentation for [environment availability][github-environments],
[secret scopes][github-secrets], [auto-merge][github-auto-merge], [rulesets][github-rulesets],
[push events][github-token-events] and [Actions billing][github-actions-billing].

[github-environments]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[github-secrets]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
[github-auto-merge]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request
[github-rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
[github-token-events]: https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs
[github-actions-billing]: https://docs.github.com/en/billing/concepts/product-billing/github-actions

## Renovate SDK inputs

The `renovate-sdk-inputs` preset tracks literal SDK versions passed to this library's
fully qualified workflow and action calls. A consumer can extend
`github>NDDev-Technocracy-OpenNetwork/nddev-ci:renovate-sdk-inputs#<release tag>`.
Renovate continues to own action/workflow pins. Expression-valued, non-scalar and
malformed inputs are not selected as literal SDK versions.

The library's own `renovate.json` has a generated manager for its relative and self
calls. Both forms come from `lib/renovate-sdk.mjs`; edit that definition and run
`just fix`. `just check` checks freshness offline. Regeneration preserves unrelated
repository settings and managers, and refuses duplicate ownership of the SDK block.
The self block has no dependency on another release of this repository.

Both SDK managers set `yamlMaxAliasCount: 0`. A file containing any YAML alias is
excluded from SDK extraction, even when the alias is outside the matched input.
Renovate reports the skipped file with a warning; literal files remain supported.

The required Linux check runs native Renovate qualification through its existing
isolated hosted job Docker provider. `tests/renovate-sdk-native.mjs` binds the
qualified temporary OCI image to its source, immutable manifest and executed image
configuration. The image is retained in its public container registry and imported
without rebuilding the engine. Missing registry access or a changed image refuses
the check instead of selecting another runtime.

Qualification resolves the public preset at the exact checked Git revision before
testing extraction and actual replacements. Both shared-alias ownership directions
must refuse extraction before updates and report the skipped file. The container
receives only public fixture/configuration files and the hosted job's short-lived
public-read token; no host credential, private source or Docker socket is mounted.
Docker-dependent qualification stays separate from the offline `just check`.

## Developing the library

```sh
just setup   # prepare pinned source-analysis tools
just check   # offline format, syntax, workflow and security checks
just test    # runtime fixtures and native tool integrations
just verify  # the complete check
```

Runtime tests and native matrices belong on build machines. Fixtures exercise real
Git histories, loopback HTTP transport and archive bytes; native integration suites
also download pinned tools. The library calls its own actions and reusable workflows with GitHub's
self-repository syntax, `uses: $/...`, which resolves at the commit being run: a caller's one pin
selects every part of the library. Self-hosted runners need version 2.336.0 or newer for it. The
library's own top-level workflows call its reusable workflows with `./`, which resolves to the same
commit there and keeps actionlint's check of their inputs.

## Credit

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Please credit NDDev and link
[this repository](https://github.com/NDDev-Technocracy-OpenNetwork/nddev-ci).

## Repository administration

`.github/rulesets/dev.json` owns this library's complete native, reusable, image and real
source-status merge checks. Its repository-scoped rule has no bypass actors and leaves other
repository/organization rules intact. With an existing administrator identity, run
`just repository-rules owner/repository` to plan, then the same command with `apply`.
The command uses the current `GH_TOKEN` or authenticated `gh` identity outside ordinary CI;
it verifies the complete observed rule after a write or lost reply and is safe to repeat.
A missing, duplicate, foreign or truncated inventory fails. Ordinary jobs receive no new grant.

### Secret policy for changes

The merge stop reads `.betterleaks.toml` or `.gitleaks.toml` from the exact base commit,
with Betterleaks taking precedence. It also reads only that base's ignore files. The change
cannot replace its own policy, add ignore fingerprints or use inline suppression comments.
No repository policy selects the scanner defaults. Environment policy overrides are excluded.

A repository policy adds to the default rules. One without an `[extend]` table, such as a
fixture allowlist alone, keeps them; one whose `[extend]` table does not set
`useDefault = true` fails before scanning, because it would scan without them.

The policy must be a bounded regular Git blob and self-contained TOML. Mutable local-file or URL
extensions fail before scanning. The policy stays in
the job's temporary directory, outside the checkout, and is removed after success or failure.
The scanner reads the original Git database from that isolated directory, so its automatic source
ignore-file discovery cannot read the proposed checkout.
Unchanged base blobs already belong to the checkout; the existing change-object fetch provides
the old blobs when a policy changes or disappears. The scan needs no token or lazy network fetch. Daily security reporting keeps its separate scan contract.
