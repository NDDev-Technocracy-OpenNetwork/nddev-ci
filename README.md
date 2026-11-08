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
- Syft makes an SBOM of the repository and of each image; Trivy and Grype check it.
- One open issue, "Security report", holds the latest run's findings. A finding never fails the
  run; a scanner that cannot run does. No scanner reports to its maker or checks for updates.

## Check

```sh
just check    # format, actionlint and zizmor
just verify   # everything the full check runs
```

When the runner supplies the canonical gateway settings, tool setup reads its package registry
before downloading pinned GitHub release assets. Both workflow tools and `just setup` receive
`NDDEV_CI_REGISTRIES_URL`; a project can fetch the same content-pinned release path through that
origin. Digest checks remain required. A configured registry error fails setup without switching
to upstream. Hosted runners without gateway settings use their upstream-download mode.
