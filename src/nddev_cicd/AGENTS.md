# Shared runtime work

Read [README.md](README.md) for source, artifact and target boundaries. Root instructions apply.
Use the focused regression under [tests](../../tests/) for the affected native operation; run
`uv run pytest`, `uv run ruff check src tests` and `uv run basedpyright` for a ready implementation.
Selected native fixtures remain separate evidence from unit regressions.

Preserve public installation without private packages, corpora or tokens. Reuse native parsers and
SDKs. Keep caller and callee identity distinct and never turn a failed or unavailable selected tool
into success. Update owned reference generation through `uv run python -m nddev_cicd reference`.
Normative source and canonical corpus changes use the prepared standards-authoring path separately.
