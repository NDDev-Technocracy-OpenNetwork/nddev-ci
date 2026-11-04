# NDDev CI

Reusable GitHub Actions and workflows for source checks, runner routing,
artifacts, provenance and release publication. Use an immutable commit SHA
from a release when calling a workflow or action.

The library defaults to GitHub-hosted runners for public workflows. Private
managed callers may select an admitted runner class. External runner
providers use their own cache. Deployment runs on each project's release host
through its release controller.

- [Consumer configuration](docs/usage.md)
- [Routing examples](docs/examples.md)
- [Managed cache lifecycle](docs/cache-lifecycle.md)

Run `just setup` to install the locked development environment. The
`just check`, `just fix`, `just test` and `just build` commands cover source
checks, formatting, regressions and the Python distribution respectively.

The first implementation tree derives from the published `nddev-cicd`
0.6.25 source. Its distribution and module names remain stable for callers.
