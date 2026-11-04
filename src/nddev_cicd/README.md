# Native CI and immutable artifact delivery

This package owns operations behind the public composite actions. Source CI executes the caller's
selected native tools and records actual results. Artifact packaging binds exact source, files,
locks and callee identity; delivery verifies that binding before changing an existing target.

Runner admission precedes allocation. Public routes remain hosted; private routes require trusted
caller-owned policy. A test failure cannot select a different provider to manufacture success.
The package does not depend on a private standard compiler or acquire an account entitlement.

`pyproject.toml` owns the package version through the existing `uv_build` backend. `__version__`,
the console script and module entrypoint use its installed distribution metadata. In a source
checkout the manifest and metadata must agree; `uv sync --locked` prepares that environment.
Missing or stale metadata fails explicitly instead of reporting an unrelated installed version.

Target locks, generations and previous artifact identities protect activation. Partial data changes
remain pending until the target owner reconciles real state; a network failure cannot authorize a
blind replay. SSH transfers the same tested implementation and bundle, with pinned host identity,
into owned staging rather than installing a persistent management service.

Native profile definitions own command defaults, allowed non-applicability and required stages.
The same impact closure serves per-invocation and job-level selection. Failure feedback owns only
bounded native run metadata and deduplication; task/branch policy remains caller-owned. Documentation feedback uses the
existing syntax, example, generation and link path; selected text rules report mechanical coverage
without exposing source prose or certifying its meaning. [The consumer guide](../../docs/usage.md)
explains caller configuration, and [local instructions](AGENTS.md) identify implementation checks.
