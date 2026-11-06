# NDDev CI

The shared CI library of NDDev projects. A project calls one reusable workflow, pinned by commit,
and it runs the same `just` commands an agent runs.

## Use

Copy [examples/ci.yml](examples/ci.yml) to `.github/workflows/ci.yml` and pin a commit of this
repository.

| Event | Runs |
| --- | --- |
| Pull request | `just check`, then `just test` |
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
- A pull request also runs the merge stops of security.md: gitleaks over the change's commits, and
  actionlint and zizmor (high severity) over the workflows. Either finding stops the merge.

## Check

```sh
just check    # format, actionlint and zizmor
just verify   # everything the full check runs
```
