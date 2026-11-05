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

- Private repositories run on our runners, the label in the `runner` input, and public ones on
  GitHub's runners.
- On our runners, Rust builds compile through sccache into the contour's R2 cache, by way of the
  cache gateway of the machine named in `/etc/contour/caches/environment.toml`. Jobs of `dev` and
  `main` read and write; every other job only reads, so a pull request never writes what a
  release build reads. This separates honest builds, not hostile ones, as jobs share an account.
- The check step reports how many compilations came from the cache.
- A pull request also runs the merge stops of security.md: gitleaks over the change's commits, and
  actionlint and zizmor (high severity) over the workflows. Either finding stops the merge.

## Check

```sh
just check    # format, actionlint and zizmor
just verify   # everything the full check runs
```
