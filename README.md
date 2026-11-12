# NDDev CI

Reusable checks, builds and publication through a project's own `just` commands.
Projects own their checks and artifacts; this library prepares the execution tools,
runs those commands and enforces the merge and release boundaries.

Copy a caller from [examples](examples), pin a released commit with its version in
the comment, and let Dependabot propose later releases. Input descriptions live in
the linked workflow and action declarations.

## Entry points

| Workflow | Purpose |
| --- | --- |
| [check.yml](.github/workflows/check.yml) | Project checks and merge stops |
| [merge-stops.yml](.github/workflows/merge-stops.yml) | The same stops beside a project's existing jobs |
| [recipe.yml](.github/workflows/recipe.yml) | One project recipe in a native platform matrix |
| [image.yml](.github/workflows/image.yml) | Build a native container image and push it by source commit |
| [release.yml](.github/workflows/release.yml) | Publish the exact verified commit and its files as an immutable GitHub Release |
| [image-tag.yml](.github/workflows/image-tag.yml) | Give the checked image digest its release tag without rebuilding |
| [registry.yml](.github/workflows/registry.yml) | Publish released files to crates.io or PyPI through trusted publishing |
| [provenance.yml](.github/workflows/provenance.yml) | Attest artifacts of a public repository's build |
| [security.yml](.github/workflows/security.yml) | Daily secrets, dependency, licence, SBOM and image scans |

## Project checks

| Event | Commands |
| --- | --- |
| Pull request | `just check`, then `just test` if declared, including aliases |
| Push to `dev`, or manual run | `just verify` |

`setup: true` runs `just setup` first. A missing optional test recipe is allowed;
a failed command or invalid justfile fails the job. New PR pushes cancel their
superseded checks. Each `dev` commit keeps its full check.

Use `check.yml` for this standard path. A project with existing command jobs calls
`merge-stops.yml` beside them. Use `recipe.yml` for a native matrix, with a declared
recipe, optional preparation recipe and literal arguments as a JSON string array.
Each matrix platform gives its artifact a distinct name. An artifact is kept for
`artifact-days`, 14 by default: long enough for `main` to release the checked `dev`
commit. A deployment that takes an older build sets more.

The PR merge stops scan secrets in the changed commits, dangerous workflows,
commit messages and newly introduced fixed critical dependency vulnerabilities.
Dependency comparison reads the exact proposed merge and its own base from Git,
runs no project installers, and scans both against the same vulnerability data.
Existing findings remain diagnostics. Native source packages without a registry version stay
counted and appear explicitly in the receipt; matched advisories are checked normally.
Missing or malformed metadata and unavailable scanners still fail.
The stops check out the history without file contents and fetch the contents of the change
alone, so a large repository costs them no more than a small one.
The message rules leave out a commit whose author is exactly Dependabot: it writes one long line
for a grouped update and offers no setting for it. A repository's own `committed.toml` replaces
the default rules whole.
Daily security findings update a report issue; scanner execution errors fail the run.
The default licence list is declared in `security.yml`; a caller's `license-policy`
can supply its own `[licenses].allow`. OSV accepts identifiers, so a `WITH` entry
requires its base to be independently allowed too; exception-only policies fail. Unchanged
MPL/EPL dependencies retain their notice and source obligations; modified files need
review and corresponding source publication. LGPL stays outside the default: an
explicit policy for unchanged dynamic use must preserve replaceability, licence and
source information. Static linking or modifications need review. The scanner does
not infer these use and distribution conditions.

Checkout inputs support projects that read history or omit generated trees.
`diagnostics` keeps only named workspace reports on failure; release artifacts are
uploaded only after successful non-PR checks.

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

Only the explicit PR label `runner:github` moves a private check and its merge stops
to GitHub's runners. Other labels do not rerun them. A caller may also select
`runner: github` explicitly for a manual full check; its `workflow_dispatch` choice list
uses `ours` and `github`. A waiting job stays where it was sent. Native public macOS and Windows
matrices use `recipe.yml`; supported hosted labels are in its declaration.

[hosted-sdk](actions/hosted-sdk/action.yml) prepares only selected exact Node, Python,
uv, Bun, Rust, Temurin Java, Go or stable Flutter versions and selected
`name@version` command-line tools. Managed runners verify those selections against
their prepared SDK, without sudo or global installation. External runners bootstrap
them through the pinned upstream actions. Preparation uses the embedded action
runtime, so it requires no preinstalled Node SDK.

Linux and Windows ARM64 reject Flutter; Windows ARM64 rejects Temurin Java.
Native tools such as FFmpeg require a separately qualified provider and the project's
complete acceptance tests. A language SDK or Python wrapper supplies neither.
[release-assets](actions/release-assets/action.yml) prepares explicitly declared
public archive members, checking archive and executable digests before adding PATH.
Managed runners retain their SDK instead.

Private source reads use either `read-keys` deploy keys or a scoped GitHub App,
never both. The App grants contents-read access only to the explicit same-organization
repositories. Keys stay in the job's temporary directory; App tokens are revoked in
cleanup. Merge stops receive neither credential. See [check.yml](.github/workflows/check.yml)
for the inputs and optional secrets.

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

[image-builder](actions/image-builder/action.yml) prepares the same builder inside a job that
builds images to test and scan them there, such as a native recipe that builds several images,
runs its own tests against them and keeps their SBOMs. It applies `image.yml`'s policy: on a
managed runner the pinned Buildx from the first route, the registry mirrors for the builder and
the host network. It exports `NDDEV_CI_IMAGE_BUILD_FLAGS`, the network and the mirror's build
arguments, so a recipe builds with `docker buildx build $NDDEV_CI_IMAGE_BUILD_FLAGS --load`, and
the database variables of the daily package scan, `TRIVY_DB_REPOSITORY`,
`TRIVY_JAVA_DB_REPOSITORY` and `GRYPE_DB_UPDATE_URL`, so the job's scans read the same copies. On
a GitHub-hosted runner the flags and variables stay empty and each tool uses its public source.

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
`v<major>.<minor>.<patch>` and never move. An ordinary release raises the patch;
`version` selects a newer version and `initial-version` sets the first release.
Reruns reconcile the same release. Deployment stays with the caller.

`registry.yml` verifies immutable release files before trusted publication. Crates
must reproduce the released package from tagged source. Public artifact attestations
use `provenance.yml`; private repositories use release verification.

## Job records

[job-record](actions/job-record/action.yml) ends each job with a summary and one
structured `nddev_ci.job.completed` line: source commit, workflow, result, actual
OS/architecture, duration and available compiler-cache counters. Missing measured
queue time remains unknown. The runner can provide `NDDEV_CI_QUEUE_SECONDS` and
`NDDEV_CI_TELEMETRY_FILE`; hosted jobs keep the record in the job log. The execution
controller owns the SDK, device and generation provenance added at collection.
[telemetry](actions/telemetry/action.yml) disables outside telemetry in every job.

## Developing the library

```sh
just setup   # prepare pinned source-analysis tools
just check   # offline format, syntax, workflow and security checks
just test    # runtime fixtures and native tool integrations
just verify  # the complete check
```

Runtime tests and native matrices belong on build machines. Fixtures exercise real
Git histories, loopback HTTP transport and archive bytes; native integration suites
also download pinned tools. Self-references in reusable workflows pin an existing
implementation commit and are updated after that implementation is committed.

## Credit

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Please credit NDDev and link
[this repository](https://github.com/NDDev-Technocracy-OpenNetwork/nddev-ci).
